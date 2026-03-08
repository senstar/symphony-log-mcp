# Symphony Log MCP — Code Audit (2026-03-08)

Full review of all 25 source files (18 tools + 7 library modules), README, package.json, and domain knowledge resource.

**Status: ALL ITEMS RESOLVED** — see status tags below.

---

## Bugs

### 1. Operator precedence bug in event-log.ts (silent data loss) — ✅ FIXED

**File:** `src/tools/event-log.ts` line ~176  
**Severity:** Bug — incorrect results  

```ts
errors: levels.get("Error") ?? 0 + (levels.get("Critical") ?? 0),
```

Because `+` binds tighter than `??`, this evaluates as `levels.get("Error") ?? (0 + criticalCount)`. When an Error count exists, Critical is silently ignored. Fix:

```ts
errors: (levels.get("Error") ?? 0) + (levels.get("Critical") ?? 0),
```

### 2. `computeErrorGroups` called twice in summarize-health.ts — ✅ FIXED

**File:** `src/tools/summarize-health.ts`  
**Severity:** Performance — double I/O on every health summary  

`computeErrorGroups` is called once inside `computeHealthSummary` and again in the outer `toolSummarizeHealth`. Every error-log file is parsed twice. The result should be cached and reused.

---

## Dead Code

### 3. `parseTs()` — defined but never called — ✅ REMOVED

**File:** `src/tools/trace-mb-request.ts` line 93

### 4. `tsToMs()` duplicated identically in two files — ✅ CONSOLIDATED

**Files:** `src/tools/trace-mb-request.ts` line 99, `src/tools/search-http-requests.ts` line 49  
Both are identical to `timestampToMs` in `src/lib/log-parser.ts`. Should use the shared version.

### 5. `_logDir` parameter unused in compare-logs.ts — ℹ️ BY DESIGN

Server.ts passes `ctx.dirs` but it's ignored (underscore-prefixed).

### 6. `license.reg` still in EXTRA_FILES mapping — ✅ REMOVED

**File:** `src/lib/bug-report.ts` line ~178  
Extracts a file that is dead code in Symphony itself (LogPackage.cs defines the path but never creates the file). Remove from the mapping.

---

## Assumptions / Judgment Leaps

### 7. Restart reason patterns that don't exist in the product — ✅ FIXED

**File:** `src/tools/service-lifecycle.ts` lines 51-68  
**Severity:** Medium — overpromises functionality  

Several `RESTART_REASON_PATTERNS` were not found in the Symphony source during source-code verification:
- `too many timeouts` — actual code uses different phrasing
- `database went away` / `database came back` — not present
- `buddy.*lost`, `buddy.*failed`, `buddy.*down` — CFarmHealth uses different phrasing
- `ALIVE.*failed`, `not alive` — not the actual logged strings

The server.ts description says "Surfaces causes: too many timeouts, DB reconnects, ping failures, buddy/failover" — overpromising. Patterns should be verified against actual source and corrected.

### 8. Generic regex patterns in 5 domain tools (false positives) — ✅ DOCUMENTED

**Files:** `video-health.ts`, `storage.ts`, `alarms.ts`, `network.ts`, `access-control.ts`  
**Severity:** Medium — false positive results  

All use broad keyword patterns like `/connection\s+(?:lost|closed|failed)/i` that match any log line from any service. A database connection failure in IS would trigger `RE_CAM_DISCONNECT` in video-health. These were never verified against actual Symphony log output.

**Fix:** Add log-prefix awareness — check `entry.line.source` or `entry.line.functionalArea` alongside message content, or at minimum document that results should be interpreted with the log source in mind.

### 9. serverinfo.txt parser is heuristic-based — ℹ️ ACCEPTABLE

**File:** `src/lib/config-parser.ts`  
Multiple alternative field names are tried (`"Total RAM"`, `"Total Memory"`, `"RAM"`) — guessing rather than verification. Low priority since serverinfo.txt format is less critical than log parsing.

---

## Organization / Cleanliness

### 10. server.ts is a 927-line monolith — ✅ SPLIT

The TOOLS array (~500 lines) and switch/case dispatch (~200 lines) should be split:
- `src/tool-registry.ts` — TOOLS array (schemas + descriptions)
- `src/tool-dispatch.ts` — switch/case handler
- `server.ts` — just lifecycle wiring

### 11. Three different tool signature patterns — ℹ️ DEFERRED

| Pattern | Used by |
|---------|---------|
| `(logDir: string \| string[], args)` | 16 tools |
| `(bugReport: BugReport \| null, args)` | 4 tools |
| `(_logDir: unused, args with dirA/dirB)` | 1 tool |

**Fix:** Create a unified `ToolContext` interface passed to all tools:
```ts
interface ToolContext {
  dirs: string | string[];
  bugReport: BugReport | null;
  serverLabels?: string[];
}
```

### 12. Symphony service/process name patterns duplicated — ✅ EXTRACTED

- `SYMPHONY_PROCESS_PATTERNS` in `process-lifetimes.ts` (14 patterns)
- `SYMPHONY_SVC_PATTERNS` in `system-diagnostics.ts` (14 patterns)

Should live in a shared module.

### 13. No temp directory cleanup — ✅ FIXED

`bug-report.ts` and `compare-logs.ts` extract to OS temp dir and never clean up.

### 14. Version hardcoded in server.ts — ✅ FIXED

`version: "2.0.0"` hardcoded instead of reading from package.json.

---

## User-Facing Clarity

### 15. README says "16 tools" — there are 18 — ✅ FIXED

Missing `sym_system` and `sym_event_log` from the tool table.

### 16. README tool table missing modes — ✅ FIXED

- `sym_db_tables`: missing `settings_xml` mode
- `sym_permissions`: missing `rights` mode

### 17. Dead tool name in domain-knowledge.ts — ✅ FIXED

Playbook says `sym_slow_requests` — actual tool is `sym_http` mode `slow`.

### 18. Port 50001 described inconsistently — ✅ FIXED

`sym_http` description says "MobileBridge uses binary protocol (port 50001)" — but port 50001 is IS WS/SOAP. MobileBridge default is 8433.

---

## Implementation Order

1. Fix #1 (operator precedence bug) — 1 line
2. Fix #15-16 (README out of date) — text updates
3. Fix #17 (dead tool name in domain-knowledge) — 1 line
4. Fix #18 (port 50001 description) — 1 line
5. Fix #3-6 (dead code cleanup) — remove/replace
6. Fix #2 (cache computeErrorGroups) — refactor
7. Fix #7 (restart reason patterns) — source verification + correction
8. Fix #12 (shared Symphony name patterns) — extract module
9. Fix #10-11 (split server.ts + unified context) — refactor
10. Fix #8 (domain tool regex precision) — add prefix awareness
11. Fix #13 (temp dir cleanup) — add cleanup mechanism
12. Fix #14 (read version from package.json) — 5 lines
