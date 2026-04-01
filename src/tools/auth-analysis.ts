/**
 * auth-analysis.ts
 *
 * Analyse authentication and session events from Symphony IS logs:
 *   - AD authentication failures
 *   - EstablishSecureScope / session failures
 *   - Login records (from IS logs and Logins.txt)
 *   - Session creation / renewal issues
 */

import { tryReadLogEntries, resolveFileRefs, isInTimeWindow, listLogFiles, appendWarnings } from "../lib/log-reader.js";
import { fingerprint } from "../lib/fingerprint.js";
import * as fs from "fs/promises";
import * as path from "path";

// ── Patterns ────────────────────────────────────────────────────────────────

const RE_AD_FAILURE    = /not authenticated by Active Directory/i;
const RE_SECURE_SCOPE  = /EstablishSecureScope.*(?:Failed|error|unable)/i;
const RE_SESSION_FAIL  = /(?:CreateSession|GetSessionFromDB|session\s+retrieval).*(?:Failed|error|unable|exception)/i;
const RE_LOGIN         = /(?:Login|logged\s+in|authenticated)\s+(?:successful|user|for|by)/i;
const RE_LOGOUT        = /(?:Logout|logged\s+out|session\s+(?:expired|terminated|closed))/i;
const RE_AUTH_GENERAL  = /(?:authentication|authorization|credential|password|token)\s+(?:failed|error|denied|expired|invalid)/i;

// Extract username from common patterns
const RE_USERNAME      = /(?:user\s+['"]?([^'":\s,]+)|for\s+user\s+['"]?([^'":\s,]+)|session\s+for\s+['"]?([^'":\s,]+))/i;

interface AuthEvent {
  timestamp: string;
  level: string;
  category: "ad_failure" | "session_failure" | "scope_failure" | "login" | "logout" | "auth_error";
  user: string;
  message: string;
  source: string;
  file: string;
}

export interface AuthArgs {
  mode: "failures" | "sessions" | "summary";
  files?: string[];
  userFilter?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export async function toolAuth(
  logDir: string | string[],
  args: AuthArgs,
): Promise<string> {
  const { mode, limit = 100, userFilter, startTime, endTime } = args;

  let files = args.files;
  if (!files || files.length === 0) {
    files = ["is"];
  }
  const paths = await resolveFileRefs(files, logDir);
  if (paths.length === 0) return "No log files found. Try specifying files (e.g., 'is').";

  const events: AuthEvent[] = [];
  const warnings: string[] = [];

  for (const fullPath of paths) {
    const fileRef = path.basename(fullPath);
    const entries = await tryReadLogEntries(fullPath, warnings);
    if (!entries) continue;

    for (const entry of entries) {
      if (!isInTimeWindow(entry.line.timestamp, startTime, endTime)) continue;
      const msg = entry.line.message;
      const fullMsg = entry.fullText;

      let category: AuthEvent["category"] | null = null;
      if (RE_AD_FAILURE.test(msg))         category = "ad_failure";
      else if (RE_SECURE_SCOPE.test(msg))  category = "scope_failure";
      else if (RE_SESSION_FAIL.test(msg))  category = "session_failure";
      else if (RE_LOGOUT.test(msg))        category = "logout";
      else if (RE_LOGIN.test(msg))         category = "login";
      else if (RE_AUTH_GENERAL.test(msg))  category = "auth_error";

      if (!category) continue;

      // Extract username
      let user = "";
      const userMatch = RE_USERNAME.exec(fullMsg);
      if (userMatch) user = (userMatch[1] ?? userMatch[2] ?? userMatch[3] ?? "").trim();

      if (userFilter && !user.toLowerCase().includes(userFilter.toLowerCase())) continue;

      events.push({
        timestamp: entry.line.timestamp,
        level: entry.line.level,
        category,
        user: user || "(unknown)",
        message: msg.slice(0, 200),
        source: entry.line.source,
        file: fileRef,
      });
    }
  }

  if (events.length === 0) {
    return appendWarnings("No authentication events found" + (userFilter ? ` for user '${userFilter}'` : "") + ".", warnings);
  }

  switch (mode) {
    case "summary":
      return appendWarnings(formatSummary(events), warnings);
    case "failures":
      return appendWarnings(formatFailures(events, limit), warnings);
    case "sessions":
      return appendWarnings(formatSessions(events, limit), warnings);
    default:
      return `Unknown mode '${mode}'. Use: summary, failures, sessions`;
  }
}

function formatSummary(events: AuthEvent[]): string {
  const out: string[] = [];
  out.push("═".repeat(60));
  out.push("  AUTHENTICATION SUMMARY");
  out.push("═".repeat(60));
  out.push("");

  // By category
  const byCat = new Map<string, number>();
  for (const e of events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);

  out.push("By Type:");
  for (const [cat, count] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    const label = cat.replace(/_/g, " ");
    out.push(`  ${String(count).padStart(6)}×  ${label}`);
  }
  out.push("");

  // By user
  const byUser = new Map<string, { total: number; failures: number }>();
  for (const e of events) {
    const u = byUser.get(e.user) ?? { total: 0, failures: 0 };
    u.total++;
    if (e.category !== "login" && e.category !== "logout") u.failures++;
    byUser.set(e.user, u);
  }

  out.push("By User:");
  for (const [user, info] of [...byUser.entries()].sort((a, b) => b[1].failures - a[1].failures).slice(0, 20)) {
    out.push(`  ${user.padEnd(25)} ${String(info.total).padStart(5)} total  ${String(info.failures).padStart(5)} failures`);
  }
  out.push("");

  // Time range
  if (events.length > 0) {
    const first = events[0].timestamp;
    const last = events[events.length - 1].timestamp;
    out.push(`Time range: ${first} → ${last}`);
    out.push(`Total events: ${events.length}`);
  }

  out.push("═".repeat(60));
  return out.join("\n");
}

function formatFailures(events: AuthEvent[], limit: number): string {
  const failures = events.filter(e => e.category !== "login" && e.category !== "logout");
  const out: string[] = [];
  out.push(`Found ${failures.length} authentication failure(s) (showing ${Math.min(failures.length, limit)}):`);
  out.push("");

  // Group by fingerprint for deduplication
  const groups = new Map<string, { count: number; first: AuthEvent; last: AuthEvent }>();
  for (const e of failures) {
    const fp = fingerprint(e.message);
    const g = groups.get(fp);
    if (g) {
      g.count++;
      g.last = e;
    } else {
      groups.set(fp, { count: 1, first: e, last: e });
    }
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  for (const g of sorted) {
    out.push(`  ${String(g.count).padStart(5)}×  [${g.first.category}] user=${g.first.user}`);
    out.push(`         ${g.first.message.slice(0, 120)}`);
    out.push(`         first: ${g.first.timestamp} ${g.first.file}  last: ${g.last.timestamp}`);
    out.push("");
  }

  return out.join("\n");
}

function formatSessions(events: AuthEvent[], limit: number): string {
  const sessionEvents = events.filter(e =>
    e.category === "session_failure" || e.category === "scope_failure" ||
    e.category === "login" || e.category === "logout"
  );

  const out: string[] = [];
  out.push(`Found ${sessionEvents.length} session event(s) (showing ${Math.min(sessionEvents.length, limit)}):`);
  out.push("");

  const shown = sessionEvents.slice(0, limit);
  for (const e of shown) {
    const icon = e.category === "login" ? "→" : e.category === "logout" ? "←" : "✗";
    out.push(`  ${icon} [${e.timestamp}] ${e.category.padEnd(16)} user=${e.user.padEnd(15)} ${e.message.slice(0, 80)}`);
  }

  return out.join("\n");
}
