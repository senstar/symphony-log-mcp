/**
 * tool-registry.ts
 *
 * MCP tool definitions (name, description, inputSchema) for Symphony log tools.
 * Pure data — no handler logic.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_DEFS: any[] = [
  {
    name: "sym_open",
    description: "Set or switch the active log directory. Call FIRST before other sym_* tools. No args returns current directory.",
    inputSchema: {
      type: "object",
      properties: {
        logDir: {
          type: "string",
          description: "Absolute path to a directory containing Symphony log files, or a bug report folder.",
        },
      },
      required: [],
    },
  },
  {
    name: "sym_triage",
    description: "Automated first-pass diagnosis. Runs health, errors, lifecycle, and event log checks in parallel with severity ranking. Start here for unfamiliar log sets.",
    inputSchema: {
      type: "object",
      properties: {
        sccpFiles:      { type: "array", items: { type: "string" }, description: "sccp log file(s) for process health (default: auto-detect)" },
        errorFiles:     { type: "array", items: { type: "string" }, description: "IS or other log files for error analysis (default: auto-detect)" },
        lifecycleFiles: { type: "array", items: { type: "string" }, description: "Log files for lifecycle events (default: auto-detect)" },
        startTime:      { type: "string", description: "Only include data at or after HH:MM:SS" },
        endTime:        { type: "string", description: "Only include data at or before HH:MM:SS" },
      },
      required: [],
    },
  },
  {
    name: "sym_info",
    description: "Log directory metadata, file listing, and server info. Actions: bug_report, list_files, decode_prefix, hardware.",
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
    description: "Search logs for errors, text, or regex patterns. Modes: errors (deduplicated), pattern (text/regex), count (per-file totals), assert_absent (prove pattern missing).",
    inputSchema: {
      type: "object",
      properties: {
        mode:          { type: "string", enum: ["errors", "pattern", "count", "assert_absent"], description: "Search mode" },
        files:         { type: "array", items: { type: "string" }, description: "Log filenames, prefixes, or prefix-date patterns" },
        pattern:       { type: "string", description: "For pattern/count/assert_absent: text or regex to search for" },
        isRegex:       { type: "boolean", description: "For pattern/count/assert_absent: treat pattern as regex (default false)" },
        caseSensitive: { type: "boolean", description: "For pattern/count/assert_absent: case sensitive (default false)" },
        contextLines:  { type: "number",  description: "For pattern mode: lines of context around each match" },
        levelFilter:   { type: "array", items: { type: "string" }, description: "For pattern/count/assert_absent: only these levels, e.g. ['Error','BasicInfo']" },
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
    description: "Extract crash and exception data. Modes: managed (.NET stack traces), native (C++ crash dumps from pd logs).",
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
    description: "Track service/process lifecycle events and log gaps. Modes: services (start/stop/restart), processes (PID tracking from sccp), gaps (log silence detection).",
    inputSchema: {
      type: "object",
      properties: {
        mode:            { type: "string", enum: ["services", "processes", "gaps"], description: "'services' for app-level events, 'processes' for PID-level tracking, 'gaps' for log silence detection" },
        files:           { type: "array", items: { type: "string" }, description: "Log files. For processes mode, use sccp-*.txt files." },
        includePings:    { type: "boolean", description: "For services: include inter-server ALIVE/PING messages (default false)" },
        symphonyOnly:    { type: "boolean", description: "For processes: only Symphony processes (default true)" },
        filter:          { type: "string",  description: "For processes: filter by process name substring, e.g. 'Tracker'" },
        showAll:         { type: "boolean", description: "For processes: show all, not just restarted (default false)" },
        gapThresholdSec: { type: "number", description: "For gaps mode: minimum gap in seconds to report (default 60)" },
        startTime:       { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:         { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:           { type: "number", description: "Max results (default 200 for services, 100 for processes)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_timeline",
    description: "Correlate events across log sources. Modes: correlate (merge timelines), trace_rpc (RPC round-trips via Mo+IS), waves (temporal clustering of pattern matches).",
    inputSchema: {
      type: "object",
      properties: {
        mode:        { type: "string", enum: ["correlate", "trace_rpc", "waves"], description: "'correlate' to merge timelines, 'trace_rpc' to trace RPC, 'waves' to cluster pattern matches by time" },
        files:       { type: "array", items: { type: "string" }, description: "For correlate/waves: log files to analyze" },
        levelFilter: { type: "array", items: { type: "string" }, description: "For correlate: e.g. ['Error', 'BasicInfo']" },
        requestName: { type: "string", description: "For trace_rpc: RPC method name, e.g. 'GetDeviceGraphCompressed'" },
        pattern:     { type: "string", description: "For waves: text or regex to search for" },
        isRegex:     { type: "boolean", description: "For waves: treat pattern as regex (default false)" },
        gapSeconds:  { type: "number", description: "For waves: gap between clusters in seconds (default 300 = 5 min)" },
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
    description: "Analyze HTTP/RPC request performance from IS logs. Modes: requests, slow, rates, totals. Supports groupBy, statusFilter, and duration thresholds.",
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
    description: "Detect UI thread freezes and deadlocks in AiraExplorer (ae) client logs. Configurable freeze threshold.",
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
    description: "Server health dashboard from sccp/IS logs. Modes: dashboard (restarts, status rating), trends (memory/CPU trajectory, leak detection).",
    inputSchema: {
      type: "object",
      properties: {
        sccpFiles:  { type: "array", items: { type: "string" }, description: "sccp log file(s), e.g. 'sccp'" },
        errorFiles: { type: "array", items: { type: "string" }, description: "IS or other log files for error counts" },
        mode:       { type: "string", enum: ["dashboard", "trends"], description: "'dashboard' (default) for health summary, 'trends' for memory/CPU trajectory" },
        filter:     { type: "string", description: "For trends mode: filter by process name substring" },
        startTime:  { type: "string", description: "Only include data at or after HH:MM:SS" },
        endTime:    { type: "string", description: "Only include data at or before HH:MM:SS" },
      },
      required: ["sccpFiles"],
    },
  },
  {
    name: "sym_compare",
    description: "Side-by-side comparison of two log directories. Dimensions: errors, health, lifecycle, http, slow.",
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
    description: "(Bug report only) Parse database table dumps. Modes: summary, cameras, servers, settings, users, licenses, settings_xml, raw.",
    inputSchema: {
      type: "object",
      properties: {
        mode:      { type: "string", enum: ["summary", "cameras", "servers", "settings", "users", "licenses", "settings_xml", "raw"], description: "What category of data to extract" },
        tableName: { type: "string", description: "For raw mode: filter by table name substring" },
        section:   { type: "string", description: "For settings_xml: filter by section name substring" },
        key:       { type: "string", description: "For settings_xml: filter by key name substring" },
        limit:     { type: "number", description: "Max rows to return (default 100)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_video_health",
    description: "Video pipeline health from Tracker (cs*), VCD, and history sender (hs*) logs. Modes: summary, events, cameras.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files (default: cs*, vcd*, hs* — auto-detected if omitted)" },
        mode:      { type: "string", enum: ["summary", "events", "cameras"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: [],
    },
  },
  {
    name: "sym_storage",
    description: "Storage and disk management from Cleaner (sccl) logs. Modes: summary, events, timeline.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files (default: sccl* — auto-detected if omitted)" },
        mode:      { type: "string", enum: ["summary", "events", "timeline"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: [],
    },
  },
  {
    name: "sym_alarms",
    description: "Alarm/event rule processing from Scheduler (scac) logs. Modes: summary, events, failures.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files (default: scac* — auto-detected if omitted)" },
        mode:      { type: "string", enum: ["summary", "events", "failures"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: [],
    },
  },
  {
    name: "sym_network",
    description: "Network connection events: TCP, timeouts, DNS failures, retries. Modes: summary, events, targets, timeouts.",
    inputSchema: {
      type: "object",
      properties: {
        files:        { type: "array", items: { type: "string" }, description: "Log files (default: all available — auto-detected if omitted)" },
        mode:         { type: "string", enum: ["summary", "events", "targets", "timeouts"], description: "Output mode (default 'summary')" },
        targetFilter: { type: "string", description: "Filter to specific IP or hostname" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max results (default 100)" },
      },
      required: [],
    },
  },
  {
    name: "sym_access_control",
    description: "Access control integration (ac, aacl, lacl, ga): door events, credentials, sync, panel failures. Modes: summary, events, failures, sync.",
    inputSchema: {
      type: "object",
      properties: {
        files:     { type: "array", items: { type: "string" }, description: "Log files (default: ac, aacl, lacl, ga — auto-detected if omitted)" },
        mode:      { type: "string", enum: ["summary", "events", "failures", "sync"], description: "Output mode (default 'summary')" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 100)" },
      },
      required: [],
    },
  },
  {
    name: "sym_permissions",
    description: "(Bug report only) Resolve effective user permissions from DB dumps. Modes: resolve, check, groups, rights, raw.",
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
  {
    name: "sym_system",
    description: "(Bug report only) System diagnostics from bug report package. Modes: overview, services, processes, network, environment, license, files, db_summary, raw.",
    inputSchema: {
      type: "object",
      properties: {
        mode:         { type: "string", enum: ["overview", "services", "processes", "network", "environment", "license", "files", "db_summary", "raw"], description: "What system information to show" },
        filter:       { type: "string", description: "Filter by name substring (for services, environment, files)" },
        symphonyOnly: { type: "boolean", description: "For services: only show Symphony-related services (default false)" },
        sortBy:       { type: "string", enum: ["memory", "cpu", "name"], description: "For processes: sort order (default memory)" },
        port:         { type: "number", description: "For network: filter by port number" },
        file:         { type: "string", description: "For raw: which supplementary file to dump (omit to list available)" },
        limit:        { type: "number", description: "Max entries (default 100)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_event_log",
    description: "(Bug report only) Parse Windows Event Log exports (Application/System). Modes: entries, summary.",
    inputSchema: {
      type: "object",
      properties: {
        log:     { type: "string", enum: ["application", "system", "both"], description: "Which event log to inspect" },
        mode:    { type: "string", enum: ["entries", "summary"], description: "Output format (default 'entries')" },
        level:   { type: "string", description: "Filter by level: comma-separated, e.g. 'error,critical'" },
        source:  { type: "string", description: "Filter by event source (substring match)" },
        eventId: { type: "number", description: "Filter by specific event ID" },
        search:  { type: "string", description: "Text search in event messages" },
        limit:   { type: "number", description: "Max entries (default 50)" },
      },
      required: ["log"],
    },
  },
  {
    name: "sym_farm",
    description: "Farm-wide analysis across multiple server log packages. Modes: dashboard, errors, topology, cameras, connectivity.",
    inputSchema: {
      type: "object",
      properties: {
        parentDir: {
          type: "string",
          description: "Absolute path to a directory containing multiple server log package folders.",
        },
        mode: {
          type: "string",
          enum: ["dashboard", "errors", "topology", "cameras", "connectivity"],
          description: "Analysis mode (default 'dashboard')",
        },
        limit: { type: "number", description: "Max results per section (default 50)" },
      },
      required: ["parentDir"],
    },
  },
  {
    name: "sym_auth",
    description: "Authentication and session events from IS logs. Modes: summary, failures, sessions.",
    inputSchema: {
      type: "object",
      properties: {
        mode:         { type: "string", enum: ["summary", "failures", "sessions"], description: "Analysis mode (default 'summary')" },
        files:        { type: "array", items: { type: "string" }, description: "Log files (default: 'is' — auto-detected)" },
        userFilter:   { type: "string", description: "Filter by username substring" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max results (default 50)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_db_health",
    description: "Database connectivity and health from IS logs. Detects outages, SQL exceptions, pool exhaustion. Modes: summary, outages, events.",
    inputSchema: {
      type: "object",
      properties: {
        mode:      { type: "string", enum: ["summary", "outages", "events"], description: "Analysis mode (default 'summary')" },
        files:     { type: "array", items: { type: "string" }, description: "Log files (default: 'is' — auto-detected)" },
        startTime: { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:   { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:     { type: "number", description: "Max results (default 50)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_cameras",
    description: "Camera inventory and status from Tracker (cs*) logs. Modes: inventory, problems, status.",
    inputSchema: {
      type: "object",
      properties: {
        mode:         { type: "string", enum: ["inventory", "problems", "status"], description: "Analysis mode (default 'inventory')" },
        cameraFilter: { type: "string", description: "Filter by camera ID number" },
        files:        { type: "array", items: { type: "string" }, description: "Tracker log files to scan (default: auto-detect cs* files)" },
        limit:        { type: "number", description: "Max results (default 50)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_interserver",
    description: "Inter-server communication from IS logs: heartbeats, connection failures, proxy errors. Modes: summary, map, failures.",
    inputSchema: {
      type: "object",
      properties: {
        mode:         { type: "string", enum: ["summary", "map", "failures"], description: "Analysis mode (default 'summary')" },
        files:        { type: "array", items: { type: "string" }, description: "Log files (default: 'is' — auto-detected)" },
        serverFilter: { type: "string", description: "Filter by server ID or IP substring" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max results (default 50)" },
      },
      required: ["mode"],
    },
  },
  {
    name: "sym_hw",
    description: "Hardware integration events: Advantech/ADAM, serial ports, IO modules. Modes: summary, advantech, devices, errors.",
    inputSchema: {
      type: "object",
      properties: {
        mode:         { type: "string", enum: ["summary", "advantech", "devices", "errors"], description: "Analysis mode (default 'summary')" },
        files:        { type: "array", items: { type: "string" }, description: "Log files (default: 'is', 'ac', 'hm' — auto-detected)" },
        deviceFilter: { type: "string", description: "Filter by device name, IP, or COM port" },
        startTime:    { type: "string", description: "Only include events at or after HH:MM:SS" },
        endTime:      { type: "string", description: "Only include events at or before HH:MM:SS" },
        limit:        { type: "number", description: "Max results (default 50)" },
      },
      required: ["mode"],
    },
  },
];

// ── Inject logDir override into every tool except sym_open ───────────────────

const LOG_DIR_OVERRIDE_PROP = {
  logDir: {
    type: "string",
    description:
      "Override log directory for this call only. Absolute path to a log directory or bug report folder. " +
      "If omitted, uses the directory set by sym_open (or LOG_DIR env var).",
  },
};

for (const tool of TOOL_DEFS) {
  if (tool.name !== "sym_open") {
    tool.inputSchema.properties = {
      ...LOG_DIR_OVERRIDE_PROP,
      ...tool.inputSchema.properties,
    };
  }
}

export const TOOLS = TOOL_DEFS;
