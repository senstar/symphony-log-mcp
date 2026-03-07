# Symphony Log MCP Server

A Model Context Protocol (MCP) server for automated analysis of Symphony VMS log files. This server provides AI assistants with powerful tools to diagnose errors, compare test runs, track process health, and identify performance issues across Symphony deployments.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that enables AI assistants to securely access external tools and data sources. This server implements MCP to give AI assistants specialized capabilities for analyzing Symphony logs.

## Features

- **Side-by-side log comparison** - Compare two builds or environments with automatic detection of fixed/new/changed error patterns
- **Error pattern analysis** - Fingerprint and deduplicate errors, with full stack trace extraction
- **Process health monitoring** - Detect crash-loops, restarts, and memory trends from sccp logs
- **Service lifecycle tracking** - Find start/stop/restart events and diagnose restart causes
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
      "args": ["/path/to/symphony-log-mcp/dist/index.js", "C:\\Log"],
      "env": {
        "LOG_DIR": "C:\\Log"
      }
    }
  }
}
```

The second argument or `LOG_DIR` environment variable sets the default log directory. You can override this per-tool by using absolute paths in tool parameters.

### VS Code with GitHub Copilot

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "symphony-logs": {
      "command": "node",
      "args": ["${workspaceFolder}/tools/symphony-log-mcp/dist/index.js"],
      "env": {
        "LOG_DIR": "${workspaceFolder}/Compare"
      }
    }
  }
}
```

## Usage

Once configured, you can ask your AI assistant natural language questions like:

- "Compare the logs from tests 133 and 138 and summarize the differences"
- "What are the most common errors in the InfoService logs?"
- "Show me the process health for this bug report"
- "Find all slow requests over 5 seconds"
- "What caused InfoService to restart at 14:23?"

The AI assistant will automatically invoke the appropriate MCP tools and interpret the results for you.

## Available Tools (16)

All tools use the `sym_` prefix for easy discovery.

| Tool | Description |
|------|-------------|
| `sym_info` | Bug report metadata, list log files, decode prefixes, hardware config (action: `bug_report` \| `list_files` \| `decode_prefix` \| `hardware`) |
| `sym_search` | Search for errors or text/regex patterns (mode: `errors` \| `pattern`) |
| `sym_crashes` | Extract .NET exceptions or native C++ crash dumps (mode: `managed` \| `native`) |
| `sym_lifecycle` | Service start/stop/restart events or process-level PID tracking (mode: `services` \| `processes`) |
| `sym_timeline` | Merge logs chronologically or trace RPC calls across Mo→IS (mode: `correlate` \| `trace_rpc`) |
| `sym_http` | Unified HTTP + RPC request analysis with slow-request detection (mode: `requests` \| `slow` \| `rates` \| `totals`) |
| `sym_ui_thread` | Detect UI thread freezes and deadlocks with multi-file support, configurable freeze threshold, and time filtering |
| `sym_health` | Generate process health dashboard (HEALTHY / DEGRADED / CRITICAL) |
| `sym_compare` | Side-by-side diff of two log directories (errors, lifecycle, health, http, slow) |
| `sym_db_tables` | Parse database table dumps from bug reports (mode: `summary` \| `cameras` \| `servers` \| `settings` \| `users` \| `licenses` \| `raw`) |
| `sym_video_health` | Video pipeline health: camera connect/disconnect, frame drops, codec errors, recording gaps (mode: `summary` \| `events` \| `cameras`) |
| `sym_storage` | Disk/storage management: space warnings, retention, cleaner cycles (mode: `summary` \| `events` \| `timeline`) |
| `sym_alarms` | Alarm & event rule processing: triggers, notifications, rule failures (mode: `summary` \| `events` \| `failures`) |
| `sym_network` | Network connectivity: timeouts, retries, connection refused, DNS (mode: `summary` \| `events` \| `targets` \| `timeouts`) |
| `sym_access_control` | Access control integration: doors, credentials, sync, panel comms (mode: `summary` \| `events` \| `failures` \| `sync`) |
| `sym_permissions` | Resolve effective user permissions with full audit trail — handles group inheritance and deny-overrides-grant (mode: `resolve` \| `check` \| `groups` \| `raw`) |

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
