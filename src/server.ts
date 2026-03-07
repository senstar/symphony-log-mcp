import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { toolListLogFiles } from "./tools/list-logs.js";
import { toolSearchErrors } from "./tools/search-errors.js";
import { toolSearchPattern } from "./tools/search-pattern.js";
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
import { toolDbTables } from "./tools/db-tables.js";
import { toolVideoHealth } from "./tools/video-health.js";
import { toolStorage } from "./tools/storage.js";
import { toolAlarms } from "./tools/alarms.js";
import { toolNetwork } from "./tools/network.js";
import { toolAccessControl } from "./tools/access-control.js";
import { toolPermissions } from "./tools/permissions.js";
import { decodePrefix, listKnownPrefixes } from "./lib/prefix-map.js";
import { isBugReportFolder, extractBugReport, type BugReport } from "./lib/bug-report.js";
import { getHardwareConfig, formatHardwareConfig } from "./lib/config-parser.js";
import { DOMAIN_KNOWLEDGE } from "./lib/domain-knowledge.js";

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
      "'decode_prefix' — look up what a log file prefix means (e.g. 'is'=InfoService, 'cs'=Tracker). Omit prefix to list all known prefixes. " +
      "'hardware' — show server hardware details (CPU, RAM, disk, OS, NICs) from serverinfo.txt in bug report packages.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["bug_report", "list_files", "decode_prefix", "hardware"], description: "Which information to retrieve" },
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
    name: "sym_http",
    description:
      "Analyze HTTP and RPC request performance in Symphony logs. " +
      "Modes: " +
      "'requests' (default) — list/filter/group IS HTTP requests (Nancy RequestLogger, port 50014). " +
      "'slow' — find slow requests exceeding a duration threshold. Merges RPC-level 'took HH:MM:SS' entries with HTTP-layer RequestLogger entries. Set includeRpc=false to show HTTP only. slowGroupBy='request' for method aggregation. " +
      "'rates' — request rate histogram per minute/5min/hour. " +
      "'totals' — one-line summary (total, 2xx/3xx/4xx/5xx, error rate). " +
      "groupBy: 'path' (slowest endpoints), 'client' (most active callers), 'status', 'statusClass'. " +
      "statusFilter: exact codes [500,503] or class strings ['4xx','5xx','error']. " +
      "NOTE: MobileBridge uses binary protocol (port 50001), not these HTTP endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        files:              { type: "array", items: { type: "string" }, description: "IS log files, e.g. 'is' or 'is-260227_31.txt'" },
        mode:               { type: "string", enum: ["requests", "slow", "rates", "totals"], description: "Analysis mode (default 'requests')" },
        pathFilter:         { type: "string", description: "URL path substring or regex, e.g. '/api/video'" },
        method:             { type: "string", description: "HTTP method: GET, POST, PUT, DELETE" },
        minDurationMs:      { type: "number", description: "Only requests slower than N ms" },
        thresholdMs:        { type: "number", description: "For slow mode: minimum duration in ms (default 1000)" },
        includeRpc:         { type: "boolean", description: "For slow mode: include RPC 'took' entries (default true)" },
        slowGroupBy:        { type: "string", enum: ["request"], description: "For slow mode: group by RPC method name" },
        clientIp:           { type: "string", description: "Client IP substring, e.g. '10.234'" },
        statusFilter:       { type: "array",  items: {}, description: "Exact codes [500,503] or class strings ['4xx','5xx','error']" },
        groupBy:            { type: "string", enum: ["path", "client", "status", "statusClass"], description: "Aggregation mode" },
        sortBy:             { type: "string", enum: ["avg", "max", "count", "errors", "duration", "time"], description: "Sort order (default 'max')" },
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
      "Shows last activity on the UI thread and detects gaps where the thread went silent. " +
      "Supports multiple files for cross-file UI analysis. " +
      "Configurable freeze threshold (default 5000ms). " +
      "Optionally specify a thread ID or let the tool auto-detect via WPF/WinForms indicators.",
    inputSchema: {
      type: "object",
      properties: {
        files:             { type: "array", items: { type: "string" }, description: "AE log files (typically ae-*.txt). Accepts multiple for cross-file analysis." },
        threadId:          { type: "string", description: "Thread ID to inspect (decimal). Omit for auto-detect." },
        lastN:             { type: "number", description: "Last N entries for the thread (default 30)" },
        fullLog:           { type: "boolean", description: "Return all entries (overrides lastN)" },
        freezeThresholdMs: { type: "number", description: "Minimum gap in ms to flag as a freeze (default 5000)" },
        startTime:         { type: "string", description: "Only include entries at or after HH:MM:SS" },
        endTime:           { type: "string", description: "Only include entries at or before HH:MM:SS" },
      },
      required: ["files"],
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
  {
    name: "sym_db_tables",
    description:
      "Parse database table dumps from a Symphony bug report package. " +
      "Discovers and parses ASCII-bordered tables, TSV data, SQL output, and key-value config blocks. " +
      "Modes: " +
      "'summary' — overview of all discovered tables with row counts by category. " +
      "'cameras' — camera/device configuration (ID, name, server, resolution, FPS, codec, status). " +
      "'servers' — server/farm topology (name, IP, role, status). " +
      "'settings' — system settings and feature flags. " +
      "'users' — user accounts, roles, auth methods. " +
      "'licenses' — license entitlements and features. " +
      "'raw' — show raw parsed table data, optionally filtered by table name.",
    inputSchema: {
      type: "object",
      properties: {
        mode:      { type: "string", enum: ["summary", "cameras", "servers", "settings", "users", "licenses", "raw"], description: "What category of data to extract" },
        tableName: { type: "string", description: "For raw mode: filter by table name substring" },
        limit:     { type: "number", description: "Max rows to return (default 100)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_video_health",
    description:
      "Analyze video pipeline health from Tracker (cs*), VCD (vcd), and history sender (hs*) logs. " +
      "Detects camera connection/disconnection, frame drops, codec errors, storage write failures, " +
      "recording gaps, and stream start/stop events. " +
      "Modes: 'summary' — overview with counts per category. " +
      "'events' — chronological event listing. " +
      "'cameras' — group events by source/camera.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files — cs*, vcd*, hs* prefixes recommended" },
        mode:      { type: "string", enum: ["summary", "events", "cameras"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_storage",
    description:
      "Analyze storage and disk management from Cleaner (sccl) and related logs. " +
      "Detects disk space warnings, storage full events, retention enforcement, " +
      "file deletions, and cleaner cycle activity. Answers 'why did recording stop?' " +
      "Modes: 'summary' — count overview with alerts. " +
      "'events' — chronological listing. " +
      "'timeline' — hourly histogram of storage activity.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files — sccl* prefix recommended" },
        mode:      { type: "string", enum: ["summary", "events", "timeline"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_alarms",
    description:
      "Parse Scheduler action logs (scac) for alarm/event rule processing. " +
      "Tracks alarm triggers, clears, notification delivery (email/relay), " +
      "rule evaluation, and action execution. Answers 'why didn't the alarm fire?' " +
      "Modes: 'summary' — count overview. " +
      "'events' — chronological listing. " +
      "'failures' — notification and rule failures only.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files — scac* prefix recommended" },
        mode:      { type: "string", enum: ["summary", "events", "failures"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_network",
    description:
      "Extract connection and network events from any Symphony log. " +
      "Tracks TCP connect/disconnect, timeouts, connection refused, DNS failures, and retries. " +
      "Modes: 'summary' — count overview with problem targets. " +
      "'events' — chronological listing. " +
      "'targets' — group by IP/endpoint. " +
      "'timeouts' — deduplicated timeout patterns.",
    inputSchema: {
      type: "object",
      properties: {
        files:        { type: "array", items: { type: "string" }, description: "Log files to analyze" },
        mode:         { type: "string", enum: ["summary", "events", "targets", "timeouts"], description: "Output mode (default 'summary')" },
        targetFilter: { type: "string", description: "Filter to specific IP or hostname" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_access_control",
    description:
      "Parse access control integration logs (ac, aacl, lacl, ga) for door events, " +
      "credential scans, sync operations, and communication failures with panels. " +
      "Modes: 'summary' — count overview with failure highlights. " +
      "'events' — chronological listing. " +
      "'failures' — communication and sync failures only. " +
      "'sync' — sync operation history with success/fail counts.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files — ac, aacl, lacl, ga prefixes recommended" },
        mode:      { type: "string", enum: ["summary", "events", "failures", "sync"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: ["files"],
    },
  },
  {
    name: "sym_permissions",
    description:
      "Resolve effective user permissions from Symphony bug report database dumps. " +
      "Handles the group-based permission model where Deny always overrides Grant. " +
      "Shows which groups cause each permission to be granted or denied — answers " +
      "'does this user have permission to do X?' with full audit trail. " +
      "Modes: " +
      "'resolve' — show all effective permissions for a user with grant/deny sources. " +
      "'check' — answer 'can user X do Y on resource Z?' with detailed reasoning. " +
      "'groups' — list all security groups, their members, and permission counts. " +
      "'rights' — list the full Symphony VMS rights catalog (100+ rights) with IDs. " +
      "'raw' — dump all discovered permission-related tables for manual inspection.",
    inputSchema: {
      type: "object",
      properties: {
        mode:       { type: "string", enum: ["resolve", "check", "groups", "rights", "raw"], description: "What to show" },
        user:       { type: "string", description: "User name or login to look up (required for resolve & check)" },
        permission: { type: "string", description: "Permission to check (for check mode) — fuzzy matched" },
        resource:   { type: "string", description: "Resource/entity name to check (for check mode) — fuzzy matched" },
        limit:      { type: "number", description: "Max rows in raw output (default 50)" },
      },
      required: ["mode"],
    },
  },
];

// ------------------------------------------------------------------ server

export function createServer(): Server {
  const server = new Server(
    { name: "symphony-log-mcp", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ---- Resources: static domain knowledge ----
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "symphony://domain-knowledge",
        name: "Symphony VMS Domain Knowledge",
        description:
          "Log format specification, service architecture, dependency graph, " +
          "diagnostic playbooks, and known error signatures for Symphony VMS. " +
          "Read this first to understand how to use the analysis tools effectively.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === "symphony://domain-knowledge") {
      return {
        contents: [
          { uri, text: DOMAIN_KNOWLEDGE, mimeType: "text/markdown" },
        ],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // ---- Tools ----
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
          } else if (action === "hardware") {
            const br = ctx.bugReport;
            if (!br) {
              result = "Hardware info requires a bug report package (serverinfo.txt). Log directory: " + LOG_DIR_RAW;
            } else {
              const hw = await getHardwareConfig(br.folderPath);
              result = formatHardwareConfig(hw);
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
        case "sym_http":
          result = await toolSearchHttpRequests(ctx.dirs, {
            files:              a.files              as string[],
            mode:               a.mode               as "requests" | "slow" | "rates" | "totals" | undefined,
            pathFilter:         a.pathFilter         as string | undefined,
            method:             a.method             as string | undefined,
            minDurationMs:      a.minDurationMs      as number | undefined,
            thresholdMs:        a.thresholdMs        as number | undefined,
            includeRpc:         a.includeRpc         as boolean | undefined,
            slowGroupBy:        a.slowGroupBy        as "request" | undefined,
            clientIp:           a.clientIp           as string | undefined,
            statusFilter:       a.statusFilter       as (number | string)[] | undefined,
            groupBy:            a.groupBy            as "path" | "client" | "status" | "statusClass" | undefined,
            totalsOnly:         a.totalsOnly         as boolean | undefined,
            sortBy:             a.sortBy             as "avg" | "max" | "count" | "errors" | "duration" | "time" | undefined,
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
            files:             a.files             as string[],
            threadId:          a.threadId           as string | undefined,
            lastN:             a.lastN              as number | undefined,
            fullLog:           a.fullLog            as boolean | undefined,
            freezeThresholdMs: a.freezeThresholdMs  as number | undefined,
            startTime:         a.startTime          as string | undefined,
            endTime:           a.endTime            as string | undefined,
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

        case "sym_db_tables":
          result = await toolDbTables(ctx.bugReport, {
            mode:      a.mode      as "cameras" | "servers" | "settings" | "users" | "licenses" | "raw" | "summary",
            tableName: a.tableName as string | undefined,
            limit:     a.limit     as number | undefined,
          });
          break;

        case "sym_video_health":
          result = await toolVideoHealth(ctx.dirs, {
            files:     a.files     as string[],
            mode:      a.mode      as "summary" | "events" | "cameras" | undefined,
            startTime: a.startTime as string | undefined,
            endTime:   a.endTime   as string | undefined,
            limit:     a.limit     as number | undefined,
          });
          break;

        case "sym_storage":
          result = await toolStorage(ctx.dirs, {
            files:     a.files     as string[],
            mode:      a.mode      as "summary" | "events" | "timeline" | undefined,
            startTime: a.startTime as string | undefined,
            endTime:   a.endTime   as string | undefined,
            limit:     a.limit     as number | undefined,
          });
          break;

        case "sym_alarms":
          result = await toolAlarms(ctx.dirs, {
            files:     a.files     as string[],
            mode:      a.mode      as "summary" | "events" | "failures" | undefined,
            startTime: a.startTime as string | undefined,
            endTime:   a.endTime   as string | undefined,
            limit:     a.limit     as number | undefined,
          });
          break;

        case "sym_network":
          result = await toolNetwork(ctx.dirs, {
            files:        a.files        as string[],
            mode:         a.mode         as "summary" | "events" | "targets" | "timeouts" | undefined,
            targetFilter: a.targetFilter as string | undefined,
            startTime:    a.startTime    as string | undefined,
            endTime:      a.endTime      as string | undefined,
            limit:        a.limit        as number | undefined,
          });
          break;

        case "sym_access_control":
          result = await toolAccessControl(ctx.dirs, {
            files:     a.files     as string[],
            mode:      a.mode      as "summary" | "events" | "failures" | "sync" | undefined,
            startTime: a.startTime as string | undefined,
            endTime:   a.endTime   as string | undefined,
            limit:     a.limit     as number | undefined,
          });
          break;

        case "sym_permissions":
          result = await toolPermissions(ctx.bugReport, {
            mode:       a.mode       as "resolve" | "check" | "groups" | "rights" | "raw",
            user:       a.user       as string | undefined,
            permission: a.permission as string | undefined,
            resource:   a.resource   as string | undefined,
            limit:      a.limit      as number | undefined,
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
