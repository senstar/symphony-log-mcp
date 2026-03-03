import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { toolListLogFiles } from "./tools/list-logs.js";
import { toolSearchErrors } from "./tools/search-errors.js";
import { toolSearchPattern } from "./tools/search-pattern.js";
import { toolGetSlowRequests } from "./tools/slow-requests.js";
import { toolGetStackTraces } from "./tools/stack-traces.js";
import { toolGetServiceLifecycle } from "./tools/service-lifecycle.js";
import { toolGetUiThreadActivity } from "./tools/ui-thread.js";
import { toolCorrelateTimelines } from "./tools/correlate-timeline.js";
import { toolGetProcessLifetimes } from "./tools/process-lifetimes.js";
import { toolGetPdCrashes } from "./tools/pd-crashes.js";
import { toolTraceMbRequest } from "./tools/trace-mb-request.js";
import { toolSearchHttpRequests } from "./tools/search-http-requests.js";
import { toolSummarizeHealth } from "./tools/summarize-health.js";
import { toolCompareLogs } from "./tools/compare-logs.js";
import { decodePrefix, listKnownPrefixes } from "./lib/prefix-map.js";
import { isBugReportFolder, extractBugReport, type BugReport } from "./lib/bug-report.js";

/**
 * Log directory (or bug report folder) can be overridden by the LOG_DIR
 * environment variable or passed as the first command-line argument.
 */
const LOG_DIR_RAW: string = process.env.LOG_DIR ?? process.argv[2] ?? "C:\\Log";

// ------------------------------------------------------------------ lazy log context

interface LogContext {
  /** One or more directories containing extracted .txt log files */
  dirs: string | string[];
  /** Server labels parallel to dirs[] — set when in bug-report mode */
  serverLabels?: string[];
  /** Parsed bug report metadata (null when pointing at a plain log folder) */
  bugReport: BugReport | null;
}

let _logContext: LogContext | null = null;

async function getLogContext(): Promise<LogContext> {
  if (_logContext) return _logContext;

  if (await isBugReportFolder(LOG_DIR_RAW)) {
    const bugReport = await extractBugReport(LOG_DIR_RAW);
    const serverDirs = bugReport.servers.filter(s => !s.isClient && s.logDir);
    _logContext = {
      dirs:         serverDirs.map(s => s.logDir),
      serverLabels: serverDirs.map(s => s.label),
      bugReport,
    };
    console.error(
      `symphony-log-mcp: bug report mode — ${serverDirs.length} server(s) from ${LOG_DIR_RAW}`
    );
  } else {
    _logContext = { dirs: LOG_DIR_RAW, bugReport: null };
  }

  return _logContext;
}

// ------------------------------------------------------------------ tool definitions

const TOOLS = [
  {
    name: "describe_bug_report",
    description:
      "When the log directory is a Symphony bug report package, returns the incident metadata " +
      "(product version, farm, time of error, problem description) and lists all servers with their IPs, " +
      "roles (master/non-master), and how many log files were extracted from each. " +
      "Returns a short message if a plain log directory is loaded instead.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_log_files",
    description:
      "List Symphony log files in the configured log directory (or bug report package). " +
      "In bug report mode files are grouped by server. " +
      "Optionally filter by prefix (e.g. 'is' for InfoService, 'cs' for Tracker) and/or date (YYMMDD format, e.g. '260302'). " +
      "Prefix filtering also works as a prefix for other tools' 'files' parameter — you can pass 'is' or 'is-260227' as a file reference in any other tool.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Log prefix to filter by, e.g. 'is', 'cs', 'sc'" },
        date:   { type: "string", description: "Date in YYMMDD format, e.g. '260302'" },
        limit:  { type: "number", description: "Max number of files to return (default 50)" },
      },
    },
  },
  {
    name: "search_errors",
    description:
      "Find Error-level log entries across one or more log files. Supports deduplication by message fingerprint to surface unique error patterns and their occurrence counts. Includes stack traces when present. "
      + "'files' accepts exact filenames, a prefix like 'ae', or a prefix+date like 'ae-260227'. "
      + "Use startTime/endTime to narrow to a specific incident window (e.g. the 5 minutes around a restart).",
    inputSchema: {
      type: "object",
      properties: {
        files:         { type: "array", items: { type: "string" }, description: "Log filenames, prefixes, or prefix-date patterns" },
        deduplicate:   { type: "boolean", description: "Group identical errors (default true)" },
        includeStacks: { type: "boolean", description: "Include stack trace frames (default true)" },
        startTime:     { type: "string", description: "Only include entries at or after HH:MM:SS" },
        endTime:       { type: "string", description: "Only include entries at or before HH:MM:SS" },
        limit:         { type: "number",  description: "Max error groups to return (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "search_pattern",
    description:
      "Search log files for a text or regex pattern. Useful for finding specific method names, GUIDs, IP addresses, request types, or any custom string. Supports surrounding context lines.",
    inputSchema: {
      type: "object",
      properties: {
        files:         { type: "array", items: { type: "string" } },
        pattern:       { type: "string", description: "Text or regex to search for" },
        isRegex:       { type: "boolean", description: "Treat pattern as regex (default false)" },
        caseSensitive: { type: "boolean", description: "Case sensitive match (default false)" },
        contextLines:  { type: "number",  description: "Lines of context before/after each match" },
        levelFilter:   { type: "array", items: { type: "string" },
                         description: "Only show entries of these levels e.g. ['Error','BasicInfo']" },
        startTime:     { type: "string", description: "Only search entries at or after HH:MM:SS" },
        endTime:       { type: "string", description: "Only search entries at or before HH:MM:SS" },
        limit:         { type: "number", description: "Max matches (default 200)" },
      },
      required: ["files", "pattern"],
    },
  },
  {
    name: "get_slow_requests",
    description:
      "Find requests that took longer than a threshold. Symphony logs request durations in the format 'took HH:MM:SS.fffffff'. Use this to diagnose slowness, hung web broker threads, or timeout root causes. "
      + "Use groupBy='request' to aggregate by RPC method name (shows count, max, avg per method plus a per-minute time histogram to pinpoint when slowness occurred). "
      + "Use includeHttp=true to also surface slow HTTP-layer (RequestLogger) requests merged with RPC slow calls for a unified view.",
    inputSchema: {
      type: "object",
      properties: {
        files:       { type: "array", items: { type: "string" } },
        thresholdMs: { type: "number", description: "Minimum duration in milliseconds (default 1000)" },
        limit:       { type: "number", description: "Max results (default 50)" },
        sortBy:      { type: "string", enum: ["duration", "time"], description: "Sort order (default 'duration'). Ignored when groupBy is set." },
        groupBy:     { type: "string", enum: ["request"], description: "Set to 'request' to group by RPC method name with count/max/avg statistics and a per-minute time histogram" },
        includeHttp: { type: "boolean", description: "Also include slow HTTP-layer requests (RequestLogger entries in IS files) merged with RPC slow calls" },
        startTime:   { type: "string", description: "Only include entries at or after HH:MM:SS" },
        endTime:     { type: "string", description: "Only include entries at or before HH:MM:SS" },
      },
      required: ["files"],
    },
  },
  {
    name: "get_stack_traces",
    description:
      "Extract exception stack traces from log files. Finds both managed (.NET) and native (C++) crashes. Summarizes exception types by frequency. Use exceptionFilter to narrow to specific exception types.",
    inputSchema: {
      type: "object",
      properties: {
        files:           { type: "array", items: { type: "string" } },
        exceptionFilter: { type: "string", description: "Filter by exception type substring, e.g. 'Timeout', 'NullReference'" },
        limit:           { type: "number", description: "Max stack traces to return (default 20)" },
        includeNative:   { type: "boolean", description: "Include native C++ stack traces (default true)" },
      },
      required: ["files"],
    },
  },
  {
    name: "get_service_lifecycle",
    description:
      "Find service start, stop, restart, and failover events. Also surfaces causes of unplanned restarts: too many timeouts, database reconnects, inter-server ping failures, buddy/failover events. "
      + "High-volume startup initialization chatter is automatically suppressed. "
      + "For process-level restart detection (PID changes, memory trends, uptime), use get_process_lifetimes with the sccp log instead.",
    inputSchema: {
      type: "object",
      properties: {
        files:        { type: "array", items: { type: "string" } },
        includePings: { type: "boolean", description: "Include inter-server ALIVE/PING messages (default false)" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max events (default 200)" },
      },
      required: ["files"],
    },
  },
  {
    name: "get_ui_thread_activity",
    description:
      "Analyze AiraExplorer (ae) client logs to find what the UI thread was doing last. Detects if the UI thread went silent while other threads continued (freeze/deadlock indicator). Optionally specify a thread ID or let the tool guess the UI thread.",
    inputSchema: {
      type: "object",
      properties: {
        file:     { type: "string", description: "Log filename or path (typically an ae-*.txt file)" },
        threadId: { type: "string", description: "Specific thread ID to inspect (decimal). Omit to auto-detect UI thread." },
        lastN:    { type: "number", description: "Show last N entries for the thread (default 30)" },
        fullLog:  { type: "boolean", description: "Return all entries for the thread (overrides lastN)" },
      },
      required: ["file"],
    },
  },
  {
    name: "correlate_timelines",
    description:
      "Merge entries from multiple log files into a single chronological timeline. Useful for cross-referencing client and server activity at the same moment (e.g. ae + is + cs logs side by side). Filter by time window and log level.",
    inputSchema: {
      type: "object",
      properties: {
        files:       { type: "array", items: { type: "string" }, description: "Log files to merge" },
        levelFilter: { type: "array", items: { type: "string" }, description: "e.g. ['Error', 'BasicInfo']" },
        startTime:   { type: "string", description: "Start of window HH:MM:SS" },
        endTime:     { type: "string", description: "End of window HH:MM:SS" },
        limit:       { type: "number", description: "Max entries (default 500)" },
      },
      required: ["files"],
    },
  },
  {
    name: "get_pd_crashes",
    description:
      "Parse pd (PDebug) log files to extract native crash dumps. "
      + "The pd log records crashes for all Symphony server processes (Tracker, InfoService, etc.) with full native stack traces, register state, and minidump paths. "
      + "This is the primary tool for diagnosing C++ crashes and access violations. "
      + "Pass pd-*.txt files. Each crash block shows the crashed process, PID, timestamp, and per-thread stack frames.",
    inputSchema: {
      type: "object",
      properties: {
        files:            { type: "array", items: { type: "string" }, description: "pd log file(s), e.g. 'pd-260227_00.txt' or prefix 'pd'" },
        framesPerThread:  { type: "number", description: "Max stack frames per thread (default 8)" },
        threadsPerCrash:  { type: "number", description: "Max threads per crash (default 3)" },
        limit:            { type: "number", description: "Max crashes to show (default 20)" },
      },
      required: ["files"],
    },
  },
  {
    name: "get_process_lifetimes",
    description:
      "Parse sccp (System CPU/Check Process) log files to track process lifetimes and detect restarts. "
      + "sccp logs contain periodic snapshots of every process with PID, memory, CPU%, and OS start time. "
      + "By tracking PID changes across snapshots this tool detects when Symphony services restarted, how long each instance ran, and memory/CPU trends per instance. "
      + "Pass sccp-*.txt files. By default shows only processes that restarted (use showAll:true for everything).",
    inputSchema: {
      type: "object",
      properties: {
        files:         { type: "array", items: { type: "string" }, description: "sccp log file(s), e.g. 'sccp-260227_00.txt' or prefix 'sccp'" },
        symphonyOnly:  { type: "boolean", description: "Only show Symphony processes (Tracker, InfoService, etc.). Default true." },
        filter:        { type: "string",  description: "Filter process names containing this substring, e.g. 'Tracker'" },
        showAll:       { type: "boolean", description: "Show all processes, not just those that restarted (default false)" },
        startTime:     { type: "string",  description: "Only include snapshots at or after HH:MM:SS" },
        endTime:       { type: "string",  description: "Only include snapshots at or before HH:MM:SS" },
        limit:         { type: "number",  description: "Max process records (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "search_http_requests",
    description:
      "Parse IS (InfoService) Nancy HTTP request logs (RequestLogger). "
      + "These record all inbound HTTP calls to the Symphony web management UI and REST API on port 50014. "
      + "Each entry includes method, path, client IP, HTTP status code, and duration. "
      + "Static /assets/ and /bundles/ requests are excluded by default. "
      + "Use groupBy='path' to see slowest endpoints (sort with sortBy='avg'|'max'|'count'|'errors'); groupBy='client' to see most active callers. "
      + "Use groupBy='status' to aggregate by exact HTTP status code; groupBy='statusClass' to bucket into 2xx/3xx/4xx/5xx with counts and avg/max latency per class. "
      + "Use totalsOnly=true for a single-line summary: total, 2xx, 3xx, 4xx, 5xx counts and error rate — ideal for quick build comparisons. "
      + "Use rateBy='minute'|'5min'|'hour' to see a request rate-over-time histogram — useful for spotting thundering-herd or polling bursts. "
      + "statusFilter accepts exact codes [500,503] OR class strings ['4xx','5xx','error']. "
      + "Pass IS log files (is-*.txt). NOTE: MobileBridge uses a binary protocol (port 50001), not these HTTP endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        files:         { type: "array", items: { type: "string" }, description: "IS log files, e.g. 'is' or 'is-260227_31.txt'" },
        pathFilter:    { type: "string", description: "Filter by URL path substring or regex, e.g. '/api/video', 'videowalls'" },
        method:        { type: "string", description: "Filter by HTTP method: GET, POST, PUT, DELETE" },
        minDurationMs: { type: "number", description: "Only show requests slower than N ms" },
        clientIp:      { type: "string", description: "Filter by client IP substring, e.g. '10.234'" },
        statusFilter:  { type: "array",  items: {}, description: "Only include these statuses. Accepts exact codes [500, 503] or class strings ['4xx', '5xx', 'error', '2xx']" },
        groupBy:       { type: "string", enum: ["path", "client", "status", "statusClass"], description: "Aggregate: 'path' per endpoint, 'client' per IP, 'status' per exact code, 'statusClass' buckets into 2xx/3xx/4xx/5xx" },
        sortBy:        { type: "string", enum: ["avg", "max", "count", "errors"], description: "Sort order for groupBy mode (default 'max')" },
        rateBy:        { type: "string", enum: ["minute", "5min", "hour"], description: "Show rate-over-time histogram bucketed by this interval (replaces groupBy/list output)" },
        totalsOnly:         { type: "boolean", description: "Return just a single-line totals summary: total, 2xx, 3xx, 4xx, 5xx counts and error rate. Fastest way to compare two builds." },
        isAssets:           { type: "boolean", description: "Include static /assets/ and /bundles/ requests (default false)" },
        detectActiveWindow: { type: "boolean", description: "Auto-detect the busiest activity window and prepend its HH:MM:SS bounds to the output" },
        startTime:          { type: "string",  description: "Only include requests at or after HH:MM:SS" },
        endTime:            { type: "string",  description: "Only include requests at or before HH:MM:SS" },
        limit:              { type: "number",  description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "trace_mb_request",
    description:
      "Trace a named RPC request as it flows from MobileBridge (Mo log) to InfoService (IS log). "
      + "Uses sequence numbers to correlate the sent/received entries in Mo with the invoke/completion entries in IS. "
      + "Shows timestamps, network latency (Mo→IS), IS processing time, invoking user/session, and round-trip duration. "
      + "Pass a request name like 'GetDeviceGraphCompressed', 'GetUserModel', 'GetAlarmInputs'. "
      + "Defaults to all Mo-* and is-* files in the log directory.",
    inputSchema: {
      type: "object",
      properties: {
        requestName: { type: "string", description: "RPC method name to trace, e.g. 'GetDeviceGraphCompressed'" },
        moFiles:     { type: "array", items: { type: "string" }, description: "Mo log file(s). Defaults to all Mo-* files." },
        isFiles:     { type: "array", items: { type: "string" }, description: "IS log file(s). Defaults to all is-* files." },
        startTime:   { type: "string", description: "Only trace requests at or after HH:MM:SS" },
        endTime:     { type: "string", description: "Only trace requests at or before HH:MM:SS" },
        limit:       { type: "number", description: "Max number of trace instances to show (default 5)" },
      },
      required: ["requestName"],
    },
  },
  {
    name: "summarize_health",
    description:
      "Generate a high-level health dashboard for a Symphony server from sccp process-lifetime data and IS error logs. "
      + "Shows per-process restart counts, pattern classification (stable / restarted / crash-loop / degrading), "
      + "peak memory, and an overall HEALTHY / DEGRADED / CRITICAL rating. "
      + "Pass sccp log files in sccpFiles and optionally IS log files in errorFiles for the error count.",
    inputSchema: {
      type: "object",
      properties: {
        sccpFiles:  { type: "array", items: { type: "string" }, description: "sccp log file(s), e.g. 'sccp' or 'sccp-260302_00.txt'" },
        errorFiles: { type: "array", items: { type: "string" }, description: "IS or other log files for error counts, e.g. 'is'" },
        startTime:  { type: "string", description: "Only include data at or after HH:MM:SS" },
        endTime:    { type: "string", description: "Only include data at or before HH:MM:SS" },
      },
      required: ["sccpFiles"],
    },
  },
  {
    name: "compare_logs",
    description:
      "Side-by-side comparison of two Symphony log directories (e.g. two builds, two servers, or before/after a fix). "
      + "For 'errors': shows error counts per directory, then diffs fingerprints into FIXED / NEW / CHANGED sections. "
      + "For 'health': runs summarize_health on each directory independently. "
      + "For 'lifecycle': shows service start/stop/restart events from each. "
      + "For 'http': shows hourly request rate histogram from each. "
      + "For 'slow': shows grouped slow-request summary from each. "
      + "include defaults to ['errors','lifecycle','health']. You can freely combine any subset.",
    inputSchema: {
      type: "object",
      properties: {
        dirA:        { type: "string", description: "Absolute path to the first log directory" },
        labelA:      { type: "string", description: "Human label for directory A (e.g. 'Build 133 (broken)')" },
        dirB:        { type: "string", description: "Absolute path to the second log directory" },
        labelB:      { type: "string", description: "Human label for directory B (e.g. 'Build 138 (fixed)')" },
        include:     { type: "array", items: { type: "string", enum: ["errors","lifecycle","health","http","slow"] },
                       description: "Dimensions to compare (default: ['errors','lifecycle','health'])" },
        startTimeA:  { type: "string", description: "Only include events at or after HH:MM:SS for directory A" },
        endTimeA:    { type: "string", description: "Only include events at or before HH:MM:SS for directory A" },
        startTimeB:  { type: "string", description: "Only include events at or after HH:MM:SS for directory B" },
        endTimeB:    { type: "string", description: "Only include events at or before HH:MM:SS for directory B" },
        limit:       { type: "number", description: "Max results per section (default 50)" },
        detectWindows: { type: "boolean", description: "Auto-detect active test windows from IS file rollover rate (default: true). Set to false to use the full log range." },
        summarize:   { type: "boolean", description: "Append a heuristic change summary after all sections (default: false)." },
      },
      required: ["dirA", "dirB"],
    },
  },
  {
    name: "decode_log_prefix",
    description:
      "Look up what a Symphony log file prefix means. Returns the process name, category (server/client/tool), and any notes. Also lists all known prefixes if no argument given.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Prefix to look up, e.g. 'is', 'cs01', 'scac'. Omit to list all." },
      },
    },
  },
];

// ------------------------------------------------------------------ server

export function createServer(): Server {
  const server = new Server(
    { name: "symphony-log-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    const ctx = await getLogContext();

    try {
      let result: string;

      switch (name) {
        case "describe_bug_report": {
          const br = ctx.bugReport;
          if (!br) {
            result = `Not a bug report package. Log directory: ${LOG_DIR_RAW}`;
          } else {
            const lines: string[] = [
              `Bug Report Package: ${br.folderPath}`,
              `Product Version:    ${br.productVersion}`,
              `Farm:               ${br.farmName}`,
              `Log Start:          ${br.logStartTime}`,
              `Log End:            ${br.logEndTime}`,
              `Time of Error:      ${br.timeOfError}`,
              `Problem:            ${br.problemDescription}`,
              "",
              `Servers (${br.servers.length}):`,
            ];
            for (const s of br.servers) {
              if (s.isClient) {
                lines.push(`  Client  (no standard log files)`);
              } else {
                lines.push(`  ${s.label}`);
              }
            }
            result = lines.join("\n");
          }
          break;
        }

        case "list_log_files":
          result = await toolListLogFiles(ctx.dirs, {
            prefix:       a.prefix       as string | undefined,
            date:         a.date         as string | undefined,
            limit:        a.limit        as number | undefined,
            serverLabels: ctx.serverLabels,
          });
          break;

        case "search_errors":
          result = await toolSearchErrors(ctx.dirs, {
            files:         a.files         as string[],
            deduplicate:   a.deduplicate   as boolean | undefined,
            includeStacks: a.includeStacks as boolean | undefined,
            startTime:     a.startTime     as string | undefined,
            endTime:       a.endTime       as string | undefined,
            limit:         a.limit         as number | undefined,
          });
          break;

        case "search_pattern":
          result = await toolSearchPattern(ctx.dirs, {
            files:         a.files         as string[],
            pattern:       a.pattern       as string,
            isRegex:       a.isRegex       as boolean | undefined,
            caseSensitive: a.caseSensitive as boolean | undefined,
            contextLines:  a.contextLines  as number | undefined,
            levelFilter:   a.levelFilter   as string[] | undefined,
            startTime:     a.startTime     as string | undefined,
            endTime:       a.endTime       as string | undefined,
            limit:         a.limit         as number | undefined,
          });
          break;

        case "get_slow_requests":
          result = await toolGetSlowRequests(ctx.dirs, {
            files:       a.files       as string[],
            thresholdMs: a.thresholdMs as number | undefined,
            limit:       a.limit       as number | undefined,
            sortBy:      a.sortBy      as "duration" | "time" | undefined,
            groupBy:     a.groupBy     as "request" | undefined,
            includeHttp: a.includeHttp as boolean | undefined,
            startTime:   a.startTime   as string | undefined,
            endTime:     a.endTime     as string | undefined,
          });
          break;

        case "get_stack_traces":
          result = await toolGetStackTraces(ctx.dirs, {
            files:           a.files           as string[],
            exceptionFilter: a.exceptionFilter as string | undefined,
            limit:           a.limit           as number | undefined,
            includeNative:   a.includeNative   as boolean | undefined,
          });
          break;

        case "get_service_lifecycle":
          result = await toolGetServiceLifecycle(ctx.dirs, {
            files:        a.files        as string[],
            includePings: a.includePings as boolean | undefined,
            startTime:    a.startTime    as string | undefined,
            endTime:      a.endTime      as string | undefined,
            limit:        a.limit        as number | undefined,
          });
          break;

        case "get_pd_crashes":
          result = await toolGetPdCrashes(ctx.dirs, {
            files:           a.files           as string[],
            framesPerThread: a.framesPerThread as number | undefined,
            threadsPerCrash: a.threadsPerCrash as number | undefined,
            limit:           a.limit           as number | undefined,
          });
          break;

        case "get_process_lifetimes":
          result = await toolGetProcessLifetimes(ctx.dirs, {
            files:        a.files        as string[],
            symphonyOnly: a.symphonyOnly as boolean | undefined,
            filter:       a.filter       as string | undefined,
            showAll:      a.showAll      as boolean | undefined,
            startTime:    a.startTime    as string | undefined,
            endTime:      a.endTime      as string | undefined,
            limit:        a.limit        as number | undefined,
          });
          break;

        case "search_http_requests":
          result = await toolSearchHttpRequests(ctx.dirs, {
            files:              a.files              as string[],
            pathFilter:         a.pathFilter         as string | undefined,
            method:             a.method             as string | undefined,
            minDurationMs:      a.minDurationMs      as number | undefined,
            clientIp:           a.clientIp           as string | undefined,
            statusFilter:       a.statusFilter       as (number | string)[] | undefined,
            groupBy:            a.groupBy            as "path" | "client" | "status" | "statusClass" | undefined,
            totalsOnly:         a.totalsOnly         as boolean | undefined,
            sortBy:             a.sortBy             as "avg" | "max" | "count" | "errors" | undefined,
            rateBy:             a.rateBy             as "minute" | "5min" | "hour" | undefined,
            isAssets:           a.isAssets           as boolean | undefined,
            detectActiveWindow: a.detectActiveWindow as boolean | undefined,
            startTime:          a.startTime          as string | undefined,
            endTime:            a.endTime            as string | undefined,
            limit:              a.limit              as number | undefined,
          });
          break;

        case "trace_mb_request":
          result = await toolTraceMbRequest(ctx.dirs, {
            requestName: a.requestName as string,
            moFiles:     a.moFiles    as string[] | undefined,
            isFiles:     a.isFiles    as string[] | undefined,
            startTime:   a.startTime  as string | undefined,
            endTime:     a.endTime    as string | undefined,
            limit:       a.limit      as number | undefined,
          });
          break;

        case "get_ui_thread_activity":
          result = await toolGetUiThreadActivity(ctx.dirs, {
            file:     a.file     as string,
            threadId: a.threadId as string | undefined,
            lastN:    a.lastN    as number | undefined,
            fullLog:  a.fullLog  as boolean | undefined,
          });
          break;

        case "correlate_timelines":
          result = await toolCorrelateTimelines(ctx.dirs, {
            files:       a.files       as string[],
            levelFilter: a.levelFilter as string[] | undefined,
            startTime:   a.startTime   as string | undefined,
            endTime:     a.endTime     as string | undefined,
            limit:       a.limit       as number | undefined,
          });
          break;

        case "summarize_health":
          result = await toolSummarizeHealth(ctx.dirs, {
            sccpFiles:  a.sccpFiles  as string[],
            errorFiles: a.errorFiles as string[] | undefined,
            startTime:  a.startTime  as string | undefined,
            endTime:    a.endTime    as string | undefined,
          });
          break;

        case "compare_logs":
          result = await toolCompareLogs(ctx.dirs, {
            dirA:          a.dirA          as string,
            labelA:        a.labelA        as string | undefined,
            dirB:          a.dirB          as string,
            labelB:        a.labelB        as string | undefined,
            include:       a.include       as string[] | undefined,
            startTimeA:    a.startTimeA    as string | undefined,
            endTimeA:      a.endTimeA      as string | undefined,
            startTimeB:    a.startTimeB    as string | undefined,
            endTimeB:      a.endTimeB      as string | undefined,
            limit:         a.limit         as number | undefined,
            detectWindows: a.detectWindows as boolean | undefined,
            summarize:     a.summarize     as boolean | undefined,
          });
          break;

        case "decode_log_prefix":
          if (!a.prefix) {
            const all = listKnownPrefixes();
            const lines = [
              `${all.length} known prefixes:\n`,
              ...all.map(
                (p) =>
                  `  ${p.prefix.padEnd(8)} [${p.side.padEnd(11)}]  ${p.description}`
              ),
            ];
            result = lines.join("\n");
          } else {
            const info = decodePrefix(a.prefix as string);
            result = [
              `Prefix:      ${a.prefix}`,
              `Description: ${info.description}`,
              `Category:    ${info.category}`,
              `Side:        ${info.side}`,
              info.notes ? `Notes:       ${info.notes}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          }
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`symphony-log-mcp running. Log directory: ${LOG_DIR_RAW}`);
}
