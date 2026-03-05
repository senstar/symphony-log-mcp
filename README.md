# Symphony Log MCP Server

A Model Context Protocol (MCP) server for automated analysis of Symphony VMS log files. This server provides AI assistants with powerful tools to diagnose errors, compare test runs, track process health, and identify performance issues across Symphony deployments.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that enables AI assistants to securely access external tools and data sources. This server implements MCP to give AI assistants specialized capabilities for analyzing Symphony logs.

## Features

- **Side-by-side log comparison** - Compare two builds or environments with automatic detection of fixed/new/changed error patterns
- **Error pattern analysis** - Fingerprint and deduplicate errors, with full stack trace extraction
- **Process health monitoring** - Detect crash-loops, restarts, and memory trends from sccp logs
- **Service lifecycle tracking** - Find start/stop/restart events and diagnose restart causes
- **Slow request analysis** - Aggregate and histogram request duration patterns
- **HTTP request analysis** - Parse Nancy RequestLogger entries with grouping and rate analysis
- **Bug report package support** - Automatically extract and analyze multi-server bug report ZIPs

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

## Available Tools (10)

All tools use the `sym_` prefix for easy discovery.

| Tool | Description |
|------|-------------|
| `sym_info` | Bug report metadata, list log files, decode prefixes (action: `bug_report` \| `list_files` \| `decode_prefix`) |
| `sym_search` | Search for errors or text/regex patterns (mode: `errors` \| `pattern`) |
| `sym_crashes` | Extract .NET exceptions or native C++ crash dumps (mode: `managed` \| `native`) |
| `sym_lifecycle` | Service start/stop/restart events or process-level PID tracking (mode: `services` \| `processes`) |
| `sym_timeline` | Merge logs chronologically or trace RPC calls across Mo→IS (mode: `correlate` \| `trace_rpc`) |
| `sym_slow_requests` | Find requests exceeding a duration threshold with grouping and histograms |
| `sym_http` | Analyze HTTP request logs with grouping, rate histograms, and status filtering |
| `sym_ui_thread` | Detect UI thread freezes and deadlocks in AiraExplorer client logs |
| `sym_health` | Generate process health dashboard (HEALTHY / DEGRADED / CRITICAL) |
| `sym_compare` | Side-by-side diff of two log directories (errors, lifecycle, health, http, slow) |

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
