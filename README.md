# Symphony Log MCP Server

## Overview

Symphony Log MCP Server is a tool for reading, analyzing, and comparing Symphony VMS log files. It provides automated diagnostics for error patterns, process health, service lifecycle, and performance issues across multiple test runs or environments.

## Features
- Side-by-side log comparison for two builds or environments
- Error pattern analysis and fingerprinting
- Process health and crash-loop detection
- Service lifecycle event tracking
- Slow request aggregation and performance metrics
- Heuristic change summary for regression analysis

## Usage

### Prerequisites
- Node.js (v18 or newer recommended)
- Access to Symphony log directories (unpacked or zipped)

### Install
```
npm install
npm run build
```

### Run Comparison
```
node dist/index.js compare_logs --dirA <path/to/logsA> --labelA "Test A" --dirB <path/to/logsB> --labelB "Test B" --include errors,health,lifecycle,slow --summarize true
```

- `dirA`, `dirB`: Paths to log directories for each test/build
- `labelA`, `labelB`: Human-readable labels for each side
- `include`: Comma-separated dimensions to compare (errors, health, lifecycle, http, slow)
- `summarize`: Adds a heuristic summary to the output

### Example
```
node dist/index.js compare_logs --dirA "Compare/133/Log" --labelA "Test 133" --dirB "Compare/138/Log" --labelB "Test 138" --include errors,health,lifecycle,slow --summarize true
```

## Output
The tool prints a detailed comparison report to the console, highlighting error counts, fixed/new patterns, process restarts, crash-loops, and performance changes.

## Contributing
Pull requests and issues are welcome. Please ensure code is well-documented and tested.

## License
MIT
