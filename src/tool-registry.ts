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
    description:
      "Set the log directory for this session.  Call this FIRST before using any other sym_* tool. " +
      "Accepts an absolute path to a directory containing Symphony .txt log files, or a bug report folder. " +
      "Can be called again to switch to a different directory (resets cached state). " +
      "If called with no arguments, returns the current directory.",
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
    description:
      "Automated first-pass diagnosis of a Symphony log set. " +
      "Runs health analysis, error grouping, service lifecycle, and Windows event log checks in parallel, " +
      "then produces a prioritized list of findings ranked by severity (CRITICAL/WARNING/INFO) with " +
      "drill-down hints pointing to the right tool for deeper investigation. " +
      "Start here when diagnosing an unfamiliar bug report or log set.",
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
      "'count' — count occurrences of a pattern per file. Returns a table with file name, match count, first/last timestamp. " +
      "Use this to quickly quantify how often something happens across many files without reading full matches. " +
      "'assert_absent' — prove a pattern does NOT appear. Returns explicit '0 matches in N files (M lines scanned)' confirmation or lists the unexpected matches found. " +
      "Use this to verify a code path was never taken, an error never occurred, etc. " +
      "'files' accepts exact filenames, a prefix like 'ae', or prefix+date like 'ae-260227'. " +
      "Use startTime/endTime (HH:MM:SS) to narrow to a specific incident window.",
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
      "'services' — find service start, stop, restart, and failover events. Surfaces causes: DB reconnects, ping failures, buddy/failover. Startup chatter is suppressed. " +
      "'processes' — parse sccp logs to track process lifetimes by PID. Detects restarts, uptime per instance, memory/CPU trends. " +
      "'gaps' — detect time periods where log files went silent (no entries). Reports gaps exceeding a configurable threshold. Useful for finding service outages, hangs, or crashes. " +
      "Use 'services' for application-level events, 'processes' for OS-level process tracking.",
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
    description:
      "Correlate events across multiple log sources. " +
      "Modes: " +
      "'correlate' — merge entries from multiple log files into a single chronological timeline. Cross-reference client and server activity (e.g. ae + is + cs). Filter by time and level. " +
      "'trace_rpc' — trace a named RPC request from MobileBridge (Mo log) through InfoService (IS log) using sequence numbers. Shows network latency, processing time, invoking user, and round-trip duration. " +
      "'waves' — find all occurrences of a pattern across files and group them into temporal waves (clusters). " +
      "A new wave starts when the gap between consecutive matches exceeds gapSeconds (default 300 = 5 min). " +
      "Reports per-wave: start time, end time, duration, server/file count, match count, first and last match. " +
      "Ideal for analyzing fan-out patterns (e.g. ForceServerRefreshDeviceGraph across a farm).",
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
    description:
      "Analyze HTTP and RPC request performance in Symphony logs. " +
      "Modes: " +
      "'requests' (default) — list/filter/group IS HTTP requests (Nancy RequestLogger, port 50014). " +
      "'slow' — find slow requests exceeding a duration threshold. Merges RPC-level 'took HH:MM:SS' entries with HTTP-layer RequestLogger entries. Set includeRpc=false to show HTTP only. slowGroupBy='request' for method aggregation. " +
      "'rates' — request rate histogram per minute/5min/hour. " +
      "'totals' — one-line summary (total, 2xx/3xx/4xx/5xx, error rate). " +
      "groupBy: 'path' (slowest endpoints), 'client' (most active callers), 'status', 'statusClass'. " +
      "statusFilter: exact codes [500,503] or class strings ['4xx','5xx','error']. " +
      "NOTE: MobileBridge uses its own binary protocol on port 8433 (ShConst.DefaultMobilePort), not these HTTP endpoints. Port 50001 is IS WS/SOAP.",
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
      "peak memory, and overall HEALTHY/DEGRADED/CRITICAL rating." +
      " 'trends' mode shows per-process memory/CPU trajectory over time from sccp snapshots, flagging processes with >50% memory growth as potential leaks.",
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
      "(Bug report only) Parse database table dumps from a Symphony bug report package. " +
      "Discovers and parses ASCII-bordered tables, TSV data, SQL output, and key-value config blocks. " +
      "Modes: " +
      "'summary' — overview of all discovered tables with row counts by category. " +
      "'cameras' — camera/device configuration (ID, name, server, resolution, FPS, codec, status). " +
      "'servers' — server/farm topology (name, IP, role, status). " +
      "'settings' — system settings and feature flags. " +
      "'users' — user accounts, roles, auth methods. " +
      "'licenses' — license entitlements and features. " +
      "'settings_xml' — parse TableSettings.xml for structured settings with section/key filtering. " +
      "'raw' — show raw parsed table data, optionally filtered by table name.",
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
    description:
      "Analyze video pipeline health from Tracker (cs*), VCD (vcd), and history sender (hs*) logs. " +
      "Detects camera connection/disconnection, frame drops, codec errors, storage write failures, " +
      "recording gaps, and stream start/stop events. " +
      "Modes: 'summary' — overview with counts per category. " +
      "'events' — chronological event listing. " +
      "'cameras' — group events by source/camera." +
      " Results are keyword-matched; for best accuracy use Tracker (cs*), VCD (vcd), or history sender (hs*) log files rather than generic logs.",
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
    description:
      "Analyze storage and disk management from Cleaner (sccl) and related logs. " +
      "Detects disk space warnings, storage full events, retention enforcement, " +
      "file deletions, and cleaner cycle activity. Answers 'why did recording stop?' " +
      "Modes: 'summary' — count overview with alerts. " +
      "'events' — chronological listing. " +
      "'timeline' — hourly histogram of storage activity." +
      " Results are keyword-matched; for best accuracy use Cleaner (sccl*) log files rather than generic logs.",
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
    description:
      "Parse Scheduler action logs (scac) for alarm/event rule processing. " +
      "Tracks alarm triggers, clears, notification delivery (email/relay), " +
      "rule evaluation, and action execution. Answers 'why didn't the alarm fire?' " +
      "Modes: 'summary' — count overview. " +
      "'events' — chronological listing. " +
      "'failures' — notification and rule failures only." +
      " Results are keyword-matched; for best accuracy use Scheduler (scac*) log files rather than generic logs.",
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
    description:
      "Extract connection and network events from any Symphony log. " +
      "Tracks TCP connect/disconnect, timeouts, connection refused, DNS failures, and retries. " +
      "Modes: 'summary' — count overview with problem targets. " +
      "'events' — chronological listing. " +
      "'targets' — group by IP/endpoint. " +
      "'timeouts' — deduplicated timeout patterns." +
      " Results are keyword-matched and may match application-level connection messages alongside network events. Cross-reference with the originating log source.",
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
    description:
      "Parse access control integration logs (ac, aacl, lacl, ga) for door events, " +
      "credential scans, sync operations, and communication failures with panels. " +
      "Modes: 'summary' — count overview with failure highlights. " +
      "'events' — chronological listing. " +
      "'failures' — communication and sync failures only. " +
      "'sync' — sync operation history with success/fail counts." +
      " Results are keyword-matched; for best accuracy use access control (ac, aacl, lacl, ga) log files rather than generic logs.",
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
    description:
      "(Bug report only) Resolve effective user permissions from Symphony bug report database dumps. " +
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
  {
    name: "sym_system",
    description:
      "(Bug report only) Analyze supplementary system diagnostic files from a Symphony bug report package. " +
      "These files are captured by LogPackage.cs alongside the log files and provide host-level context. " +
      "Modes: " +
      "'overview' — combined summary: OS, hardware, Symphony services status, key ports, license, database stats. " +
      "'services' — Windows services from sc queryex output. Use symphonyOnly=true to filter to Symphony services. " +
      "'processes' — running processes from tasklist /V with memory/CPU. " +
      "'network' — ipconfig + netstat: adapters, IPs, listening ports, active connections. Filter by port number. " +
      "'environment' — environment variables. " +
      "'license' — license info and shared memory (printshmem). " +
      "'files' — installed file listing from dir.txt with sizes and versions. " +
      "'db_summary' — database table list with row counts. " +
      "'raw' — dump any supplementary file as-is (omit file= to list available files).",
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
    description:
      "(Bug report only) Parse Windows Event Log exports from a Symphony bug report package. " +
      "LogPackage.cs captures the last 14 days of Application and System event logs as text files. " +
      "Invaluable for diagnosing service crashes, driver failures, disk errors, and .NET runtime " +
      "exceptions that occur outside Symphony's own log files. " +
      "Modes: " +
      "'entries' (default) — show individual events, filtered and sorted by time. " +
      "'summary' — breakdown by source and level showing where errors concentrate.",
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
