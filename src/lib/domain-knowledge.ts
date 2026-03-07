/**
 * domain-knowledge.ts
 *
 * Static MCP resource content that describes Symphony VMS architecture,
 * log format, service relationships, and diagnostic playbooks.
 * AI callers read this once to orient themselves before using tools.
 */

export const DOMAIN_KNOWLEDGE = `# Symphony VMS — Domain Knowledge for Log Analysis

## Log Format

Symphony services use a common log format (C++ source: AILog.cpp LogInternal()):

\`\`\`
HH:MM:SS.mmm  THREADID <LEVEL8__> [FunctionalArea\\t]Source.Method[context]\\tMessage
\`\`\`

- **Timestamp**: HH:MM:SS.mmm (local server time, millisecond precision)
- **Thread ID**: decimal, right-justified 7 chars (%7d)
- **Level**: 8-char left-justified (%-8.8s) inside angle brackets. The "Log" prefix is stripped before writing.
- **Primary levels**: \`Verbose \`, \`BasicInf\`, \`MoreInfo\`, \`Diagnost\`, \`Error   \`
- **Sub-diagnostic levels**: \`Tracker \`, \`Classifi\`, \`NetCam  \`, \`PTZ     \`, \`Policies\`, \`Alarming\`, \`Tracking\`, \`All     \`, and ~20 more.
- **FunctionalArea**: optional category (e.g. WebService, Communication)
- **Source**: C# format is \`ClassName.MethodName[instanceId]\`; C++ uses \`FunctionName     | message\` (15-char pipe-delimited)
- **Message**: free-text, tab-separated from source

Stack traces appear as indented continuation lines starting with \`at \`.
Max line length: 8192 chars (truncated). Files start with UTF-8 BOM.

### File Naming

Log files follow: \`{prefix}-{YYMMDD}_{NN}.txt\` (AILog.cpp CreateNewLogFile())
- **prefix**: identifies the service (see Service Map below)
- **YYMMDD**: date (year - 100, month, day)
- **NN**: rollover number (00, 01, 02...) — increments when file exceeds 5 MB (MAX_FILE_SIZE = 5000000)
- Rolled-over files are set to FILE_ATTRIBUTE_READONLY
- Write buffer flushed every 10 minutes (LOG_FLUSH_INTERVAL_SEC = 600)
- Default prefix derivation: exe name starting with "aira"/"seer" → first + fifth char; otherwise → first two chars

### Key Timing Patterns

- Request durations: \`took HH:MM:SS.fffffff\` (from TimeSpan.ToString() default)
- HTTP requests: \`RequestLogger | [#N] GET /path\` → \`[#N] ... status: 200, duration: 142 ms\` (OWIN middleware, IDs cycle mod 99999)
- Process snapshots (sccp): periodic with PID, memory, CPU — format from CpuCounter.cpp

---

## Service Architecture

### Port System

Symphony uses two base port systems (ResourceLocations.cpp):
- **External base port** (default 50000): IS main (+0), IS WS/SOAP (+1), Intel Send (+2), RPC (+3), SSO (+4), VideoWall (+5), RTSP (+10), HTTPS (+14)
- **Internal base port** (default 5000): localhost-only — Data Access (+47), Tracker Health (+46), Actions, Multicaster, etc.
- **MobileBridge**: separately configured, default port 8433 (ShConst.cs DefaultMobilePort)
- Per-camera ports: base + 10*cam + offset (1=config, 2=historical, 3=intel stream)

### Core Services (always running)

| Prefix | Service | Role |
|--------|---------|------|
| \`is\` | **InfoService** | Central API server. Handles REST/RPC requests, authentication, database access, alarm processing. Port base+0 (binary/SOAP), base+14 (HTTPS via Seer.Web.Host). |
| \`sc\` | **Scheduler** | Manages recording schedules, camera assignments, PTZ presets. Parent process for sub-services. |
| \`cs{N}\` | **Tracker** | One instance per camera (cs1, cs2, ...). Handles motion detection, video analytics, recording. Special sccp name: \`Tracker(NNNN)\`. |
| \`da\` | **Data Access** | Database abstraction layer. Internal port base+47. |
| \`hm\` | **Health Monitor (Watchdog)** | Monitors and restarts services. Constant: AILog.HEALTH_MONITORING_LOG_FILE_PREFIX = "hm". |
| \`nu\` | **Health Monitor (legacy prefix)** | Same as hm; older builds used "nu". |
| \`sccp\` | **CPU/Memory Stats** | Periodic process health snapshots from CpuCounter.cpp. |

### Scheduler Sub-Services (verified from Scheduler.cpp OpenLogFile calls)

| Prefix | Service |
|--------|---------|
| \`scac\` | Actions — alarm/event rule engine |
| \`scad\` | Analog Devices — legacy analog camera control |
| \`scax\` | Access Control |
| \`scpm\` | PTZ Multiplexer |
| \`scse\` | Searches — recorded video search/export |
| \`sccl\` | Cleaner — storage management, retention enforcement |
| \`scis\` | Multicaster (Intelsend) — multicast video distribution |

### InfoService Sub-Logs

| Prefix | Purpose |
|--------|---------|
| \`isac\` | Access Control (SetLoggingPrefix in InfoService.cs) |
| \`isbk\` | Auto Backup (AILog.INFO_SERVICE_BACKUP_LOG_FILE_PREFIX) |
| \`ismq\` | MQTT (ShConst.MqttLogPrefix) |

### Client Applications

| Prefix | Service | Notes |
|--------|---------|-------|
| \`ae\` / \`ae_{port}\` | **AiraExplorer** | Main operator desktop client (WPF/WinForms). Exe name: ae.exe. Prefix from OpenLogFile("ae_{port}"). |
| \`pre\` | **AiraExplorer Preload** | Preload.cs const LogPrefix = "pre". |
| \`am\` | **AiraManager** | Administration/configuration client. Exe: SeerManager.exe. |
| \`sm\` | **Manager (alternate/OEM)** | Same as am, display variant. |
| \`vp\` | **VMS Player (AiraPlayer)** | One instance per viewing panel displaying a camera feed (client-side). |
| \`se\` / \`se{ID}\` | **Setup Wizard / Surrogate** | Bare \`se\` = Setup Wizard; \`se{ID}\` = Surrogate/OPX viewing panel. |

### Server-Side Network Services

| Prefix | Service |
|--------|---------|
| \`mo\` | **MobileBridge** — API proxy for mobile/web clients. Default port 8433 (NOT 50001). Video proxy on port 8488. |
| \`http\` | Web Host (Seer.Web.Host) — serves web client, OWIN-based on port base+14 |
| \`ht\` | HTTP Server — host lifecycle only |
| \`mg\` | Media Gateway — video streaming proxy |
| \`ne\` | RTSP Server — port base+10 |
| \`fe\` | Fusion Engine Service — analytics port base+34 |
| \`fs\` | Enterprise Management (Federation Updater) |
| \`hs\` | NetSendHist — historical video streaming |

### Access Control Integrations

| Prefix | Integration |
|--------|-------------|
| \`ac\` / \`isac\` | Built-in Access Control (runs inside InfoService) |
| \`aacl\` | Axis PACS Listener (port base+26) |
| \`lacl\` | Lenel OnGuard Listener |
| \`ga\` / \`ga32\` | Gallagher Listener (32-bit and 64-bit) |
| \`biu\` | Bosch Intrusion Utility |

---

## Service Dependencies

\`\`\`
MobileBridge (mo) ──→ InfoService (is) ──→ Data Access (da) ──→ SQL Server
                                         ├──→ Tracker (cs*) ──→ Camera (RTSP/ONVIF)
                                         └──→ Scheduler (sc)
AiraExplorer (ae) ──→ InfoService (is)        ├── scac (alarms)
                                              ├── sccl (storage)
Web Client (wc) ───→ Web Host (http) ─→ IS    └── sccp (monitoring)

Health Monitor (hm/Watchdog) watches all services, restarts on failure.
sccp monitors all process PIDs and resource usage.
\`\`\`

---

## Common Diagnostic Playbooks

### "Camera not recording"
1. Check \`cs{N}\` logs for the camera number — look for errors or disconnect messages
2. Check \`sc\` logs for schedule activation/deactivation events
3. Check \`sccl\` logs for disk full / retention deletion events
4. Check \`sccp\` for Tracker process restarts (crash-loop = no recording)
5. Check \`is\` for database errors that might prevent schedule retrieval

### "Server restarted / service outage"
1. Use \`sym_lifecycle\` on \`is\` and \`sc\` logs — find STOP → START events
2. Check cause: database down? buddy failover? ALIVE heartbeat missed?
3. Use \`sym_health\` to see restart counts and crash-loop detection
4. Check \`hm\` logs for watchdog-initiated restarts
5. Check \`pd\` logs for native crash dumps (C++ exceptions, access violations)

### "Slow / unresponsive"
1. Use \`sym_slow_requests\` on \`is\` to find requests > threshold
2. Use \`sym_http\` to check request rates and error codes
3. Check for UI thread freeze with \`sym_ui_thread\` on \`ae\` logs
4. Check \`sccp\` for high memory or CPU usage patterns
5. Look for web broker thread issues in IS errors

### "Client can't connect"
1. Check \`mo\` logs for MobileBridge connection/authentication events
2. Check \`is\` logs for authentication failures
3. Look for SSL/TLS errors in \`http\` or \`ht\` logs
4. Verify service is running via \`sym_lifecycle\` or \`sym_health\`

### "Failover / buddy server issues"
1. Search for "buddy", "failover", "ALIVE" in IS logs (CFarmHealth.cs sends ALIVE heartbeats to buddies every cycle, 30-second timeout per Signals.asmx.cs)
2. Use \`sym_lifecycle\` with \`includePings: true\` to see inter-server health
3. Check \`sym_timeline\` correlating IS logs from both servers
4. Look for database connectivity issues (\`Database is down\` in Service.cpp)

### "Alarm did not trigger"
1. Check \`scac\` logs for rule evaluation and action execution
2. Check \`cs{N}\` for the camera — was motion detected?
3. Check \`is\` for alarm processing errors
4. Look at schedule — was the alarm profile active?

---

## Known Error Signatures

| Error Pattern | Likely Cause | Source Verification |
|---------------|-------------|---------------------|
| \`Database is down. Failing connection.\` | SQL Server connection lost. Check DB server health and network. | Service.cpp:216 — CDbWrapper::Connect |
| \`WallGetPanels\` errors | Video wall layout request failed. IS overload or large wall config. | Signals.asmx.cs:9394 |
| \`System.OutOfMemoryException\` | Process hit memory limit. Check sccp for memory trends — usually a leak. | Generic .NET |
| \`System.TimeoutException\` in RequestProcessor | Individual RPC call timed out. Use \`sym_slow_requests\` to find other slow calls. | Generic .NET |
| \`System.Net.Sockets.SocketException\` | Network connectivity issue. Check source/dest IPs in the error. | Generic .NET |
| \`LprVersion\` errors | LPR version check failed — LPR.asmx.cs web service method. Check LPR integration config. | LPR.asmx.cs:106 |
| \`AbortAuthenticate\` | Client authentication aborted — thrown in MessageDispatcher.cs:384,512. Usually SSO/AD timeout. Caught and filtered, not always logged. | MessageDispatcher.cs |
| Tracker \`cs{N}\` crash-looping | Camera driver issue, corrupt stream, or hardware problem. Tracker calls RestartMyself() (TrackerAx.cpp:921). Check pd logs for native crashes. | TrackerAx.cpp |

---

## Bug Report Structure

A bug report package contains:
- \`bugreport.txt\` — incident metadata (version, farm name, problem description, time of error)
- \`serverinfo.txt\` — per-server hardware and topology info
- \`SymphonyLog-{IP}-{YYMMDD}-{HHMMSS}.zip\` — one per server, contains \`ai_logs/*.txt\`
- \`SymphonyLog-client-{YYMMDD}-{HHMMSS}.zip\` — client logs

The MCP server auto-extracts these and presents them as a multi-server log directory.

---

## Tips for Effective Analysis

1. **Start with \`sym_info\` (bug_report)** to get incident context — time of error, product version, server count
2. **Use \`sym_health\`** for a quick overall assessment before diving into specific logs
3. **Narrow by time** — use startTime/endTime around the "Time of Error" from the bug report
4. **Use prefixes** — pass 'is' or 'is-260227' instead of full filenames to select log files
5. **Cross-reference** — an error in IS may have a root cause in sc, cs, or sccp logs
6. **Check sccp** for process restarts — they often explain service-level errors
7. **Use \`sym_compare\`** when you have two test runs or before/after scenarios
`;
