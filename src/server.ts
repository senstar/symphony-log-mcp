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
    name: "sym_info",
    description:
      "Get information about the loaded Symphony log directory or bug report. " +
      "Actions: " +
      "'bug_report' — show incident metadata (version, farm, time of error, problem description, server list). " +
      "'list_files' — list available log files, optionally filtered by prefix (e.g. 'is') or date (YYMMDD). In bug-report mode files are grouped by server. " +
      "Prefix filtering also works as a file reference in other tools — pass 'is' or 'is-260227' instead of full filenames. " +
      "'decode_prefix' — look up what a log file prefix means (e.g. 'is'=InfoService, 'cs'=Tracker). Omit prefix to list all known prefixes.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["bug_report", "list_files", "decode_prefix"], description: "Which information to retrieve" },
        prefix: { type: "string", description: "For list_files: filter by log prefix (e.g. 'is', 'cs'). For decode_prefix: prefix to look up (omit to list all)." },
        date:   { type: "string", description: "For list_files: date filter in YYMMDD format (e.g. '260302')" },
        limit:  { type: "number", description: "For list_files: max files to return (default 50)" },
      },
      required: ["action"],
    },
  },
  {
    name: "sym_search",
    description:
      "Search Symphony log files for errors or arbitrary patterns. " +
      "Modes: " +
      "'errors' — find Error-level entries with deduplication by message fingerprint. Shows unique error patterns with occurrence counts and stack traces. " +
      "'pattern' — search for text or regex (method names, GUIDs, IPs, request types). Supports context lines and level filtering. " +
      "'files' accepts exact filenames, a prefix like 'ae', or prefix+date like 'ae-260227'. " +
      "Use startTime/endTime (HH:MM:SS) to narrow to a specific incident window.",
    inputSchema: {
      type: "object",
      properties: {
        mode:          { type: "string", enum: ["errors", "pattern"], description: "Search mode: 'errors' for Error-level entries, 'pattern' for text/regex search" },
        files:         { type: "array", items: { type: "string" }, description: "Log filenames, prefixes, or prefix-date patterns" },
        pattern:       { type: "string", description: "For pattern mode: text or regex to search for" },
        isRegex:       { type: "boolean", description: "For pattern mode: treat pattern as regex (default false)" },
        caseSensitive: { type: "boolean", description: "For pattern mode: case sensitive (default false)" },
        contextLines:  { type: "number",  description: "For pattern mode: lines of context around each match" },
        levelFilter:   { type: "array", items: { type: "string" }, description: "For pattern mode: only these levels, e.g. ['Error','BasicInfo']" },
        deduplicate:   { type: "boolean", description: "For errors mode: group identical errors (default true)" },
        includeStacks: { type: "boolean", description: "For errors mode: include stack traces (default true)" },
        startTime:     { type: "string", description: "Only include entries at or after HH:MM:SS" },
        endTime:       { type: "string", description: "Only include entries at or before HH:MM:SS" },
        limit:         { type: "number", description: "Max results (default 200 for pattern, 100 for errors)" },
      },
      required: ["mode", "files"],
    },
  },
  {
    name: "sym_crashes",
    description:
      "Extract crash and exception information from Symphony logs. " +
      "Modes: " +
      "'managed' — extract .NET exception stack traces from any log file. Summarizes exception types by frequency. Use exceptionFilter to narrow. " +
      "'native' — parse pd (PDebug) logs for native C++ crash dumps with full stack traces, register state, and minidump paths. " +
      "pd logs record crashes for all Symphony server processes (Tracker, InfoService, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        mode:            { type: "string", enum: ["managed", "native"], description: "'managed' for .NET exceptions, 'native' for C++ crash dumps from pd logs" },
        files:           { type: "array", items: { type: "string" }, description: "Log files to analyze. For native mode, use pd-*.txt files." },
        exceptionFilter: { type: "string", description: "For managed mode: filter by exception type substring, e.g. 'Timeout'" },
        includeNative:   { type: "boolean", description: "For managed mode: include native C++ traces too (default true)" },
        framesPerThread: { type: "number", description: "For native mode: max stack frames per thread (default 8)" },
        threadsPerCrash: { type: "number", description: "For native mode: max threads per crash (default 3)" },
        limit:           { type: "number", description: "Max results (default 20)" },
      },
      required: ["mode", "files"],
    },
  },
  {
    name: "sym_lifecycle",
    description:
      "Track service and process lifecycle events. " +
      "Modes: " +
      "'services' — find service start, stop, restart, and failover events. Surfaces causes: too many timeouts, DB reconnects, ping failures, buddy/failover. Startup chatter is suppressed. " +
      "'processes' — parse sccp logs to track process lifetimes by PID. Detects restarts, uptime per instance, memory/CPU trends. " +
      "Use 'services' for application-level events, 'processes' for OS-level process tracking.",
    inputSchema: {
      type: "object",
      properties: {
        mode:         { type: "string", enum: ["services", "processes"], description: "'services' for app-level events, 'processes' for PID-level tracking from sccp logs" },
        files:        { type: "array", items: { type: "string" }, description: "Log files. For processes mode, use sccp-*.txt files." },
        includePings: { type: "boolean", description: "For services: include inter-server ALIVE/PING messages (default false)" },
        symphonyOnly: { type: "boolean", description: "For processes: only Symphony processes (default true)" },
        filter:       { type: "string",  description: "For processes: filter by process name substring, e.g. 'Tracker'" },
        showAll:      { type: "boolean", description: "For processes: show all, not just restarted (default false)" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max results (default 200 for services, 100 for processes)" },
      },
      required: ["mode", "files"],
    },
  },
  {
    name: "sym_timeline",
    description:
      "Correlate events across multiple log sources. " +
      "Modes: " +
      "'correlate' — merge entries from multiple log files into a single chronological timeline. Cross-reference client and server activity (e.g. ae + is + cs). Filter by time and level. " +
      "'trace_rpc' — trace a named RPC request from MobileBridge (Mo log) through InfoService (IS log) using sequence numbers. Shows network latency, processing time, invoking user, and round-trip duration.",
    inputSchema: {
      type: "object",
      properties: {
        mode:        { type: "string", enum: ["correlate", "trace_rpc"], description: "'correlate' to merge timelines, 'trace_rpc' to trace an RPC call across Mo→IS" },
        files:       { type: "array", items: { type: "string" }, description: "For correlate: log files to merge" },
        levelFilter: { type: "array", items: { type: "string" }, description: "For correlate: e.g. ['Error', 'BasicInfo']" },
        requestName: { type: "string", description: "For trace_rpc: RPC method name, e.g. 'GetDeviceGraphCompressed'" },
        moFiles:     { type: "array", items: { type: "string" }, description: "For trace_rpc: Mo log file(s). Defaults to all Mo-* files." },
        isFiles:     { type: "array", items: { type: "string" }, description: "For trace_rpc: IS log file(s). Defaults to all is-* files." },
        startTime:   { type: "string", description: "Only include entries at or after HH:MM:SS" },
        endTime:     { type: "string", description: "Only include entries at or before HH:MM:SS" },
        limit:       { type: "number", description: "Max entries (default 500 for correlate, 5 for trace_rpc)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_slow_requests",
    description:
      "Find requests exceeding a duration threshold. Symphony logs durations as 'took HH:MM:SS.fffffff'. " +
      "Diagnose slowness, hung web broker threads, and timeout root causes. " +
      "groupBy='request' aggregates by RPC method (count, max, avg + per-minute histogram). " +
      "includeHttp=true merges HTTP-layer (RequestLogger) requests with RPC slow calls.",
    inputSchema: {
      type: "object",
      properties: {
        files:       { type: "array", items: { type: "string" }, description: "Log files to analyze" },
        thresholdMs: { type: "number", description: "Minimum duration in ms (default 1000)" },
        groupBy:     { type: "string", enum: ["request"], description: "Group by RPC method name for statistics + histogram" },
        includeHttp: { type: "boolean", description: "Include HTTP-layer (RequestLogger) slow requests" },
        sortBy:      { type: "string", enum: ["duration", "time"], description: "Sort order (default 'duration'). Ignored when groupBy is set." },
        startTime:   { type: "string", description: "Only include entries at or after HH:MM:SS" },
        endTime:     { type: "string", description: "Only include entries at or before HH:MM:SS" },
        limit:       { type: "number", description: "Max results (default 50)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_http",
    description:
      "Analyze IS (InfoService) HTTP request logs (Nancy RequestLogger, port 50014). " +
      "Each entry: method, path, client IP, status code, duration. Static /assets/ excluded by default. " +
      "groupBy: 'path' (slowest endpoints), 'client' (most active callers), 'status' (exact code), 'statusClass' (2xx/3xx/4xx/5xx). " +
      "totalsOnly=true for one-line summary (total, 2xx/3xx/4xx/5xx, error rate). " +
      "rateBy='minute'|'5min'|'hour' for request-rate histogram. " +
      "statusFilter: exact codes [500,503] or class strings ['4xx','5xx','error']. " +
      "NOTE: MobileBridge uses binary protocol (port 50001), not these HTTP endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        files:              { type: "array", items: { type: "string" }, description: "IS log files, e.g. 'is' or 'is-260227_31.txt'" },
        pathFilter:         { type: "string", description: "URL path substring or regex, e.g. '/api/video'" },
        method:             { type: "string", description: "HTTP method: GET, POST, PUT, DELETE" },
        minDurationMs:      { type: "number", description: "Only requests slower than N ms" },
        clientIp:           { type: "string", description: "Client IP substring, e.g. '10.234'" },
        statusFilter:       { type: "array",  items: {}, description: "Exact codes [500,503] or class strings ['4xx','5xx','error']" },
        groupBy:            { type: "string", enum: ["path", "client", "status", "statusClass"], description: "Aggregation mode" },
        sortBy:             { type: "string", enum: ["avg", "max", "count", "errors"], description: "Sort for groupBy (default 'max')" },
        rateBy:             { type: "string", enum: ["minute", "5min", "hour"], description: "Rate histogram interval" },
        totalsOnly:         { type: "boolean", description: "Single-line totals summary only" },
        isAssets:           { type: "boolean", description: "Include /assets/ and /bundles/ (default false)" },
        detectActiveWindow: { type: "boolean", description: "Auto-detect busiest window" },
        startTime:          { type: "string",  description: "Only include requests at or after HH:MM:SS" },
        endTime:            { type: "string",  description: "Only include requests at or before HH:MM:SS" },
        limit:              { type: "number",  description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_ui_thread",
    description:
      "Analyze AiraExplorer (ae) client logs to detect UI thread freezes and deadlocks. " +
      "Shows last activity on the UI thread and detects if it went silent while other threads continued. " +
      "Optionally specify a thread ID or let the tool auto-detect.",
    inputSchema: {
      type: "object",
      properties: {
        file:     { type: "string", description: "AE log file (typically ae-*.txt)" },
        threadId: { type: "string", description: "Thread ID to inspect (decimal). Omit for auto-detect." },
        lastN:    { type: "number", description: "Last N entries for the thread (default 30)" },
        fullLog:  { type: "boolean", description: "Return all entries (overrides lastN)" },
      },
      required: ["file"],
    },
  },
  {
    name: "sym_health",
    description:
      "Generate a health dashboard for a Symphony server from sccp process-lifetime data and IS error logs. " +
      "Shows per-process restart counts, pattern classification (stable/restarted/crash-loop/degrading), " +
      "peak memory, and overall HEALTHY/DEGRADED/CRITICAL rating.",
    inputSchema: {
      type: "object",
      properties: {
        sccpFiles:  { type: "array", items: { type: "string" }, description: "sccp log file(s), e.g. 'sccp'" },
        errorFiles: { type: "array", items: { type: "string" }, description: "IS or other log files for error counts" },
        startTime:  { type: "string", description: "Only include data at or after HH:MM:SS" },
        endTime:    { type: "string", description: "Only include data at or before HH:MM:SS" },
      },
      required: ["sccpFiles"],
    },
  },
  {
    name: "sym_compare",
    description:
      "Side-by-side comparison of two Symphony log directories (two builds, servers, or before/after). " +
      "Dimensions (freely combinable via 'include'): " +
      "'errors' — diff error fingerprints into FIXED/NEW/CHANGED. " +
      "'health' — summarize_health on each. " +
      "'lifecycle' — service start/stop/restart events. " +
      "'http' — hourly request rate histogram. " +
      "'slow' — grouped slow-request summary. " +
      "Default: ['errors','lifecycle','health'].",
    inputSchema: {
      type: "object",
      properties: {
        dirA:          { type: "string", description: "Absolute path to first log directory" },
        labelA:        { type: "string", description: "Label for dir A (e.g. 'Build 133')" },
        dirB:          { type: "string", description: "Absolute path to second log directory" },
        labelB:        { type: "string", description: "Label for dir B (e.g. 'Build 138')" },
        include:       { type: "array", items: { type: "string", enum: ["errors","lifecycle","health","http","slow"] },
                         description: "Dimensions to compare" },
        startTimeA:    { type: "string", description: "Start time for dir A (HH:MM:SS)" },
        endTimeA:      { type: "string", description: "End time for dir A (HH:MM:SS)" },
        startTimeB:    { type: "string", description: "Start time for dir B (HH:MM:SS)" },
        endTimeB:      { type: "string", description: "End time for dir B (HH:MM:SS)" },
        detectWindows: { type: "boolean", description: "Auto-detect active test windows (default true)" },
        summarize:     { type: "boolean", description: "Append heuristic change summary (default false)" },
        limit:         { type: "number", description: "Max results per section (default 50)" },
      },
      required: ["dirA", "dirB"],
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
        // ---- sym_info: bug_report + list_files + decode_prefix ----
        case "sym_info": {
          const action = a.action as string;
          if (action === "bug_report") {
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
          } else if (action === "list_files") {
            result = await toolListLogFiles(ctx.dirs, {
              prefix:       a.prefix       as string | undefined,
              date:         a.date         as string | undefined,
              limit:        a.limit        as number | undefined,
              serverLabels: ctx.serverLabels,
            });
          } else if (action === "decode_prefix") {
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
          } else {
            throw new Error(`sym_info: unknown action '${action}'`);
          }
          break;
        }

        // ---- sym_search: errors + pattern ----
        case "sym_search": {
          const mode = a.mode as string;
          if (mode === "errors") {
            result = await toolSearchErrors(ctx.dirs, {
              files:         a.files         as string[],
              deduplicate:   a.deduplicate   as boolean | undefined,
              includeStacks: a.includeStacks as boolean | undefined,
              startTime:     a.startTime     as string | undefined,
              endTime:       a.endTime       as string | undefined,
              limit:         a.limit         as number | undefined,
            });
          } else if (mode === "pattern") {
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
          } else {
            throw new Error(`sym_search: unknown mode '${mode}'`);
          }
          break;
        }

        // ---- sym_crashes: managed + native ----
        case "sym_crashes": {
          const mode = a.mode as string;
          if (mode === "managed") {
            result = await toolGetStackTraces(ctx.dirs, {
              files:           a.files           as string[],
              exceptionFilter: a.exceptionFilter as string | undefined,
              limit:           a.limit           as number | undefined,
              includeNative:   a.includeNative   as boolean | undefined,
            });
          } else if (mode === "native") {
            result = await toolGetPdCrashes(ctx.dirs, {
              files:           a.files           as string[],
              framesPerThread: a.framesPerThread as number | undefined,
              threadsPerCrash: a.threadsPerCrash as number | undefined,
              limit:           a.limit           as number | undefined,
            });
          } else {
            throw new Error(`sym_crashes: unknown mode '${mode}'`);
          }
          break;
        }

        // ---- sym_lifecycle: services + processes ----
        case "sym_lifecycle": {
          const mode = a.mode as string;
          if (mode === "services") {
            result = await toolGetServiceLifecycle(ctx.dirs, {
              files:        a.files        as string[],
              includePings: a.includePings as boolean | undefined,
              startTime:    a.startTime    as string | undefined,
              endTime:      a.endTime      as string | undefined,
              limit:        a.limit        as number | undefined,
            });
          } else if (mode === "processes") {
            result = await toolGetProcessLifetimes(ctx.dirs, {
              files:        a.files        as string[],
              symphonyOnly: a.symphonyOnly as boolean | undefined,
              filter:       a.filter       as string | undefined,
              showAll:      a.showAll      as boolean | undefined,
              startTime:    a.startTime    as string | undefined,
              endTime:      a.endTime      as string | undefined,
              limit:        a.limit        as number | undefined,
            });
          } else {
            throw new Error(`sym_lifecycle: unknown mode '${mode}'`);
          }
          break;
        }

        // ---- sym_timeline: correlate + trace_rpc ----
        case "sym_timeline": {
          const mode = a.mode as string;
          if (mode === "correlate") {
            result = await toolCorrelateTimelines(ctx.dirs, {
              files:       a.files       as string[],
              levelFilter: a.levelFilter as string[] | undefined,
              startTime:   a.startTime   as string | undefined,
              endTime:     a.endTime     as string | undefined,
              limit:       a.limit       as number | undefined,
            });
          } else if (mode === "trace_rpc") {
            result = await toolTraceMbRequest(ctx.dirs, {
              requestName: a.requestName as string,
              moFiles:     a.moFiles    as string[] | undefined,
              isFiles:     a.isFiles    as string[] | undefined,
              startTime:   a.startTime  as string | undefined,
              endTime:     a.endTime    as string | undefined,
              limit:       a.limit      as number | undefined,
            });
          } else {
            throw new Error(`sym_timeline: unknown mode '${mode}'`);
          }
          break;
        }

        // ---- standalone tools (renamed with sym_ prefix) ----
        case "sym_slow_requests":
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

        case "sym_http":
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

        case "sym_ui_thread":
          result = await toolGetUiThreadActivity(ctx.dirs, {
            file:     a.file     as string,
            threadId: a.threadId as string | undefined,
            lastN:    a.lastN    as number | undefined,
            fullLog:  a.fullLog  as boolean | undefined,
          });
          break;

        case "sym_health":
          result = await toolSummarizeHealth(ctx.dirs, {
            sccpFiles:  a.sccpFiles  as string[],
            errorFiles: a.errorFiles as string[] | undefined,
            startTime:  a.startTime  as string | undefined,
            endTime:    a.endTime    as string | undefined,
          });
          break;

        case "sym_compare":
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
