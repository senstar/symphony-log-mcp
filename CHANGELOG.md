# Changelog

All notable changes to the Symphony Log MCP Server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.3.0] - 2026-04-06

### Added
- 6 new tools: `sym_farm`, `sym_auth`, `sym_db_health`, `sym_cameras`, `sym_interserver`, `sym_hw`
- 271-test Vitest suite with coverage for bug-report, malformed-input, server, tool-dispatch, trace-mb-request
- Triage cache and prefix MCP resource for optimization
- Log level quality detection in triage — warns when diagnostic logging is missing
- Crash, DNS, session, and delivery detection from Jira ticket analysis patterns
- `count`, `assert_absent`, and `waves` modes for `sym_search` and `sym_timeline`

### Changed
- `sym_open` is now required — no default log directory (prevents silent reads from live production junctions)
- Updated `@modelcontextprotocol/sdk` from 1.27.1 to 1.29.0

### Fixed
- Distribution readiness fixes and repo cleanup
- Input validation improvements across tools

## [2.2.2] - 2026-03-15

### Fixed
- Survive stdin close without crashing
- Heartbeat logging and timestamped diagnostics
- Process exit on stdin close and stdout EPIPE

## [2.2.0] - 2026-03-12

### Fixed
- Crash from unhandled stream errors

## [2.1.0] - 2026-03-10

### Added
- `sym_triage` tool — single-call first-pass diagnosis running health, errors, lifecycle, and event log checks in parallel
- Log gap detection in `sym_lifecycle`
- Memory trend analysis in `sym_health`
- Auto-select files for relevant tools
- Server labels in timeline output
- Raw level parsing for log entries

### Changed
- Removed `totalsOnly` parameter (replaced by dedicated modes)
- Labeled bug-report-only tools in tool descriptions

### Fixed
- Operator precedence bug in search filtering (audit finding)
- Double I/O in file reading (audit finding)
- Better error messages across all tools

### Removed
- Dead code identified during audit

## [2.0.0] - 2026-03-08

### Added
- 7 new tools: `sym_video_health`, `sym_storage`, `sym_alarms`, `sym_network`, `sym_access_control`, `sym_permissions`, `sym_system`
- Full log package support with source-verified parsers
- Bug report ZIP extraction and multi-server analysis
- Database table parsing from SQL dumps
- Hardware configuration from serverinfo.txt
- Windows Event Log parsing
- `symphony://domain-knowledge` MCP resource

### Fixed
- 18 audit findings resolved: operator precedence bug, double I/O, restart pattern correction, temp cleanup
- Server.ts split for maintainability
- Version now read from package.json

### Removed
- Dead code identified during audit

## [1.1.0] - 2026-03-04

### Changed
- Consolidated 16 tools into 10 with `sym_` prefix for consistent naming

## [1.0.0] - 2026-03-01

### Added
- Initial release with core log analysis tools
- Error pattern fingerprinting and deduplication
- Process health monitoring from sccp logs
- Side-by-side log comparison
- HTTP and slow request analysis
