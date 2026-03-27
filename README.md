# Symphony Log MCP Server

A Model Context Protocol (MCP) server for automated analysis of Symphony VMS log files. This server provides AI assistants with powerful tools to diagnose errors, compare test runs, track process health, and identify performance issues across Symphony deployments.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that enables AI assistants to securely access external tools and data sources. This server implements MCP to give AI assistants specialized capabilities for analyzing Symphony logs.

## Features

- **Automated triage** - Single-call first-pass diagnosis that runs health, errors, lifecycle, and event log checks in parallel with prioritized findings
- **Side-by-side log comparison** - Compare two builds or environments with automatic detection of fixed/new/changed error patterns
- **Error pattern analysis** - Fingerprint and deduplicate errors, with full stack trace extraction
- **Process health monitoring** - Detect crash-loops, restarts, and memory trends from sccp logs
- **Service lifecycle tracking** - Find start/stop/restart events, diagnose restart causes, and detect log gaps
- **HTTP & slow request analysis** - Unified HTTP + RPC slow request analysis with grouping, rate histograms, and threshold detection
- **Video pipeline health** - Camera connection/disconnection, frame drops, codec errors, recording gaps
- **Storage management** - Disk space warnings, retention enforcement, cleaner cycle tracking
- **Alarm & event rules** - Alarm triggers, notification delivery, rule evaluation failures
- **Network connectivity** - Timeouts, connection refused, retries, DNS issues across all services
- **Access control integration** - Door events, sync status, panel communication failures
- **User permission resolution** - Effective permissions with deny-overrides-grant logic, group audit trails
- **UI thread freeze detection** - WPF/WinForms UI thread analysis with configurable freeze thresholds
- **Bug report package support** - Automatically extract and analyze multi-server bug report ZIPs
- **Database table parsing** - Extract camera, server, user, and license config from bug report SQL dumps
- **Hardware configuration** - CPU, RAM, disk, NIC details from serverinfo.txt
- **Domain knowledge resource** - MCP resource providing log format spec, service graph, and diagnostic playbooks

## Installation

### Prerequisites
- Node.js v18 or newer
- An MCP-compatible client (Claude Desktop, VS Code with GitHub Copilot, etc.)

### Setup
```bash
git clone https://github.com/senstar/symphony-log-mcp.git
cd symphony-log-mcp
npm install
npm run build
```

## Configuration

### Claude Desktop

Add this server to your Claude Desktop config file:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "symphony-logs": {
      "command": "node",
      "args": ["/path/to/symphony-log-mcp/dist/index.js"]
    }
  }
}
```

Optionally pass a log directory as the first CLI argument or via the `LOG_DIR` environment variable to pre-configure the session. Otherwise, call `sym_open` at the start of each session to point at the log directory you want to analyze.

> **Safety note:** There is no default log directory. Previous versions defaulted to `C:\Log`, which could silently read from a live production server junction. You must now explicitly set the directory.

### VS Code with GitHub Copilot

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "symphony-logs": {
      "command": "node",
      "args": ["${workspaceFolder}/tools/symphony-log-mcp/dist/index.js"]
    }
  }
}
```

Then call `sym_open` with a directory path to start analyzing logs. Every tool also accepts an optional `logDir` parameter for one-shot analysis of a different directory without changing the session.

## Usage

Once configured, you can ask your AI assistant natural language questions like:

- "Compare the logs from tests 133 and 138 and summarize the differences"
- "What are the most common errors in the InfoService logs?"
- "Triage this bug report and tell me what's wrong"
- "Show me the process health for this bug report"
- "Find all slow requests over 5 seconds"
- "Are there any log gaps that suggest a service outage?"
- "Show me memory trends — are any processes leaking?"
- "What caused InfoService to restart at 14:23?"

The AI assistant will automatically invoke the appropriate MCP tools and interpret the results for you.

## Available Tools (20)

All tools use the `sym_` prefix for easy discovery.

| Tool | Description |
|------|-------------|
| `sym_open` | **Call first.** Set the log directory for this session. Accepts an absolute path to a directory or bug report folder. Call again to switch directories. |
| `sym_triage` | Automated first-pass diagnosis — runs health, error, lifecycle, and event log checks in parallel, returns prioritized findings |
| `sym_info` | Bug report metadata, list log files, decode prefixes, hardware config (action: `bug_report` \| `list_files` \| `decode_prefix` \| `hardware`) |
| `sym_search` | Search for errors, text/regex patterns, count occurrences, or prove absence (mode: `errors` \| `pattern` \| `count` \| `assert_absent`) |
| `sym_crashes` | Extract .NET exceptions or native C++ crash dumps (mode: `managed` \| `native`) |
| `sym_lifecycle` | Service start/stop/restart events, process-level PID tracking, or log gap detection (mode: `services` \| `processes` \| `gaps`) |
| `sym_timeline` | Merge logs chronologically, trace RPC calls, or cluster pattern matches into temporal waves (mode: `correlate` \| `trace_rpc` \| `waves`) |
| `sym_http` | Unified HTTP + RPC request analysis with slow-request detection (mode: `requests` \| `slow` \| `rates` \| `totals`) |
| `sym_ui_thread` | Detect UI thread freezes and deadlocks with multi-file support, configurable freeze threshold, and time filtering |
| `sym_health` | Health dashboard or memory/CPU trends from sccp logs (mode: `dashboard` \| `trends`) |
| `sym_compare` | Side-by-side diff of two log directories (errors, lifecycle, health, http, slow) |
| `sym_db_tables` | *(Bug report only)* Parse database table dumps (mode: `summary` \| `cameras` \| `servers` \| `settings` \| `users` \| `licenses` \| `settings_xml` \| `raw`) |
| `sym_video_health` | Video pipeline health: camera connect/disconnect, frame drops, codec errors, recording gaps (mode: `summary` \| `events` \| `cameras`) |
| `sym_storage` | Disk/storage management: space warnings, retention, cleaner cycles (mode: `summary` \| `events` \| `timeline`) |
| `sym_alarms` | Alarm & event rule processing: triggers, notifications, rule failures (mode: `summary` \| `events` \| `failures`) |
| `sym_network` | Network connectivity: timeouts, retries, connection refused, DNS (mode: `summary` \| `events` \| `targets` \| `timeouts`) |
| `sym_access_control` | Access control integration: doors, credentials, sync, panel comms (mode: `summary` \| `events` \| `failures` \| `sync`) |
| `sym_permissions` | *(Bug report only)* Resolve effective user permissions with full audit trail (mode: `resolve` \| `check` \| `groups` \| `rights` \| `raw`) |
| `sym_system` | *(Bug report only)* System diagnostics from supplementary files (mode: `overview` \| `services` \| `processes` \| `network` \| `environment` \| `license` \| `files` \| `db_summary` \| `raw`) |
| `sym_event_log` | *(Bug report only)* Parse Windows Event Log exports — crashes, driver failures, .NET runtime errors (mode: `entries` \| `summary`) |

## Resources

The server exposes one MCP resource for AI callers:

| Resource URI | Description |
|-------------|-------------|
| `symphony://domain-knowledge` | Symphony VMS architecture, log format spec, service dependency graph, diagnostic playbooks, and known error signatures. AI callers should read this once at session start. |

See the tool descriptions in the MCP client for detailed parameter documentation.

## Direct Invocation (Advanced)

While this server is designed for MCP clients, you can invoke it directly for testing:

```bash
echo '{"method":"tools/call","params":{"name":"sym_compare","arguments":{"dirA":"C:/Logs/133","dirB":"C:/Logs/138"}}}' | node dist/index.js
```

## Contributing

Pull requests welcome! Please ensure code is well-documented and tested.

## License

MIT
