# Symphony Log MCP — Improvement Plan

## v2.0.0 Changelog

### Source-Verified Accuracy Overhaul

All tool assumptions were systematically verified against the Symphony VMS C++ and C# source code. This is a breaking change in version number to reflect the scope of corrections.

#### Corrected Data (verified from source)

- **Log format**: Documented exact C format string from AILog.cpp (`%02i:%02i:%02i.%03i %7d <%-8.8s>`). "Log" prefix is stripped before writing — `LogError` → `Error   `.
- **Log levels**: Expanded LEVEL_MAP from 6 to 30+ entries. Sub-diagnostic levels (Tracker, Classifi, NetCam, PTZ, Policies, Alarming, etc.) now map to Verbose instead of Unknown.
- **Prefix map**: Fixed `mo` category (was Client, correct is Server). Fixed `ka` description (KillAllEx → KillAll). Added 15 missing prefixes (ai, ba, bk, in, ml, ms, pe, pr, sr, ss, su, un, up, scax).
- **Process names**: Fixed 6 misspelled exe names in process-lifetimes.ts — `airaexplorer`→`ae.exe`, `airamanager`→`seermanager`, `schedulerservice`→`scheduler`, `fusioenginservice`→`fusionengineservice`, `mobilbridge`→`mobilebridge`, `killallex`→`killall`.
- **Port system**: MobileBridge default port corrected from 50001 to **8433** (ShConst.cs DefaultMobilePort). Documented two-base system: external 50000, internal 5000.
- **Service lifecycle**: Removed fabricated patterns not found in source ("database went away", "database came back", "self-restart"). Added verified patterns ("Database is down" from Service.cpp:216, "RestartMyself" from TrackerAx.cpp:921, "buddy.*down" from CFarmHealth.cs).
- **HTTP requests**: Corrected from "Nancy/ASP.NET" to "OWIN middleware in Seer.Web.Host". Fixed regex to match any .NET TaskStatus (was only matching WaitingForActivation).
- **Mo↔IS RPC**: All regex patterns confirmed correct. The "receieved" typo is real (WebServiceRequestProcessor.cs:459). `___$System$___` confirmed as SYSTEM_USERNAME constant.
- **Domain knowledge**: Major rewrite with source file citations for all claims. Port offset table, file naming details (5MB rollover, UTF-8 BOM, readonly, 10-min flush), scheduler sub-services, InfoService sub-logs.

#### New Tools Added (Phase 2)

| Tool | Description |
|------|-------------|
| `sym_db_tables` | Parse database table dumps from bug reports (cameras, servers, settings, users, licenses) |
| `sym_video_health` | Camera connect/disconnect, frame drops, codec errors, recording gaps |
| `sym_storage` | Disk space warnings, retention enforcement, cleaner cycle tracking |
| `sym_alarms` | Alarm triggers, notification delivery, rule evaluation failures |
| `sym_network` | Timeouts, connection refused, retries, DNS issues across all services |
| `sym_access_control` | Door events, sync status, panel communication failures |
| `sym_permissions` | Effective user permissions with deny-overrides-grant logic (100+ rights catalog) |

#### New Libraries

| Library | Description |
|---------|-------------|
| `fingerprint.ts` | Shared message fingerprinting for deduplication across tools |
| `config-parser.ts` | Hardware/topology parsing from serverinfo.txt |
| `domain-knowledge.ts` | Static MCP resource with verified architecture documentation |

#### Tool Improvements

- `sym_ui_thread`: Multi-file support, startTime/endTime, configurable freeze threshold, WPF indicators
- `sym_http`: Merged slow requests + HTTP analysis into unified tool with `mode` parameter
- `sym_timeline`: Added `trace_rpc` mode for Mo↔IS request tracing

#### Infrastructure

- Shared `readRawLinesWithTimeFilter()` helper for consistent file I/O
- `resolveFileRefs()` used consistently across all tools
- 16 tools + 1 MCP resource, v2.0.0

---

## Overview

This plan covers enhancements to make the MCP server more useful to AI callers by deepening system understanding, adding database/configuration parsing, consolidating overlapping tools, and fixing correctness bugs.

---

## 1. New Tool: `sym_db_tables` — Database Table Parser

**Priority: HIGH — Highest-value addition**

Bug reports often contain SQL table dumps or structured table output. A new tool should parse these to extract system configuration that gives callers *context* beyond raw logs.

### Modes

| Mode | What It Extracts |
|------|-----------------|
| `cameras` | Camera ID, name, server assignment, resolution, FPS, enabled/disabled, codec, retention days |
| `servers` | Server names, roles (master/slave), IP addresses, farm membership |
| `settings` | Feature flags, enabled integrations (LPR, access control, analytics), retention policies |
| `users` | User accounts, roles, auth method (AD/local/SSO) |
| `licenses` | License state, feature entitlements, expiry |
| `summary` | One-paragraph overview: "3-server farm, 48 cameras, LPR enabled, SSO, 14-day retention" |

### Implementation Notes

- Auto-discover table files from the bug report folder (look for `CREATE TABLE`, ASCII table borders `+---+`, tab-separated headers)
- Parse into typed rows and return structured text
- Should work even when only partial tables are present
- Register in `server.ts` as a new case in the tool switch

### Why This Matters

Transforms the tool from "log reader" to "system diagnostician." When an AI is asked "why did camera 4 stop recording?", knowing that camera 4 is a 4K stream on a server with 16 other cameras and 8GB RAM is critical context.

---

## 2. New Tool: `sym_config` — Hardware & Topology from `serverinfo.txt`

**Priority: HIGH**

`bug-report.ts` already parses `serverinfo.txt` for server name and master/slave status, but discards hardware details. Expand extraction to include:

- CPU model, core count
- RAM total
- Disk count, capacity, free space
- OS version and edition
- NIC configuration (speed, teaming)
- Symphony service account

### Implementation Notes

- Extend `parseServerInfoTxt()` in `bug-report.ts` or create a dedicated parser
- Expose via `sym_info` as a new action (`action: "hardware"`) or as a standalone tool
- Answers "is this server under-resourced for its workload?"

---

## 3. MCP Resource: Domain Knowledge Context

**Priority: MEDIUM**

Expose a static **MCP resource** that AI callers can read once to orient themselves. Content should include:

- Log format specification (fields, levels, continuation lines, timestamp format)
- Service dependency graph (IS depends on DB, Scheduler starts cameras via Tracker, Mo proxies through IS)
- Common diagnostic playbooks ("if you see X in IS + Y in sccp → Z")
- Prefix → service → responsibility mapping with richer detail than the flat prefix table
- Known error signatures and what they mean

This replaces trial-and-error discovery with structured domain knowledge.

---

## 4. Tool Consolidation

**Priority: MEDIUM**

### Merge `sym_slow_requests` + `sym_http`

Both analyze IS HTTP traffic. `sym_slow_requests` already has `includeHttp` to bridge them. Merge into one tool:

```
sym_http
  mode: "requests" | "slow" | "rates" | "totals"
```

This reduces caller confusion about which tool to use for HTTP-related questions.

### Consider `sym_search` split

`errors` and `pattern` modes have completely different parameter sets. Not urgent, but if the tool count grows, splitting could improve discoverability.

---

## 5. Bug Fixes & Technical Debt

### 5.1 Midnight Rollover Bug (Priority: HIGH)

**All tools** sort timestamps lexicographically. Logs spanning midnight (`23:59:59` → `00:00:01`) sort incorrectly — the post-midnight entries appear *before* pre-midnight ones.

**Fix:** In `log-parser.ts`, detect rollover when a timestamp decreases by >20 hours and add a day offset to `timestampMs`. Propagate the adjusted value through all sorting and time-window comparisons.

### 5.2 Inconsistent File I/O (Priority: MEDIUM)

Three tools bypass the shared `readLogEntries()` infrastructure:

- `pd-crashes.ts` — reads raw with `fs.readFile`
- `search-http-requests.ts` — reads raw with `fs.readFile`
- `trace-mb-request.ts` — reads raw with `fs.readFile`

These miss time-window filtering, won't benefit from future streaming/pagination, and parse timestamps redundantly.

**Fix:** Refactor to use the shared reader, or at minimum extract a common `readRawLinesWithTimeFilter()` helper.

### 5.3 Deduplicate Fingerprinting (Priority: LOW)

`search-errors.ts` and `service-lifecycle.ts` have near-identical fingerprint normalization functions (GUID→`<GUID>`, IP→`<IP:PORT>`, pointer→`<PTR>`, etc.).

**Fix:** Extract to `src/lib/fingerprint.ts` and import from both.

### 5.4 Stream Large Files (Priority: LOW)

All tools load entire files into memory. For multi-GB IS logs with heavy rollover this is problematic.

**Fix:** Implement a line-by-line streaming reader (Node `readline` or `Transform` stream) with the same `LogEntry` output interface.

---

## 6. Additional New Tools

### 6.1 `sym_video_health` (Priority: MEDIUM)

Analyze Tracker (`cs*`) and video pipeline (`vcd`, `hs`) logs for:
- Frame drops and codec errors
- Storage write failures
- Camera connection/disconnection events
- Recording gaps

Video is the #1 support topic — dedicated tooling is warranted.

### 6.2 `sym_storage` (Priority: MEDIUM)

Analyze Cleaner (`sccl`) logs for:
- Disk space warnings and thresholds
- Retention enforcement activity
- Deletion rates and patterns
- Storage full events

Answers "why did recording stop?" — a common support question.

### 6.3 `sym_alarms` (Priority: LOW)

Parse Scheduler action logs (`scac`) for:
- Alarm/event rule triggers
- Notification delivery (email, relay, etc.)
- Rule evaluation failures
- Action execution timing

Answers "why didn't the alarm fire?"

### 6.4 `sym_network` (Priority: LOW)

Extract connection events from any log:
- TCP connect/disconnect patterns
- Timeout frequency and targets
- Latency measurements
- Build a connectivity timeline across services

### 6.5 `sym_access_control` (Priority: LOW)

Parse `ac`/`aacl`/`lacl`/`ga` logs for:
- Door events and credential scans
- Integration sync status
- Communication failures with access control panels

---

## 7. `sym_ui_thread` Improvements

- Support `startTime`/`endTime` filtering (currently missing)
- Use `resolveFileRefs` instead of `resolveLogPath` for consistency
- Add WPF-specific UI indicators (`DispatcherObject`, `Binding`, `DependencyProperty`)
- Make freeze detection threshold configurable (currently hardcoded at 5s)
- Accept multiple files for cross-file UI analysis

---

## 8. Implementation Priority Order

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1 | `sym_db_tables` — database table parser | Medium | Very High |
| 2 | `sym_config` — hardware from `serverinfo.txt` | Small | High |
| 3 | Midnight rollover fix | Small | High (correctness) |
| 4 | Merge `sym_slow_requests` + `sym_http` | Small | Medium |
| 5 | MCP resource for domain knowledge | Medium | Medium |
| 6 | Shared fingerprinting utility | Small | Low (code quality) |
| 7 | Stream-based file reading | Medium | Medium (scalability) |
| 8 | `sym_video_health` | Medium | High |
| 9 | `sym_storage` | Small | Medium |
| 10 | Consistent file I/O refactor | Medium | Medium (code quality) |
| 11 | `sym_alarms` | Small | Low |
| 12 | `sym_network` | Medium | Low |
| 13 | `sym_access_control` | Small | Low |
| 14 | `sym_ui_thread` improvements | Small | Low |
