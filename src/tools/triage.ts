/**
 * triage.ts
 *
 * Automated first-pass diagnosis tool. Runs multiple analyses in parallel
 * and produces a prioritized finding list with drill-down hints.
 */

import { computeHealthSummary } from "./summarize-health.js";
import { computeErrorGroups } from "./search-errors.js";
import { toolGetServiceLifecycle } from "./service-lifecycle.js";
import { toolEventLog } from "./event-log.js";
import { listLogFiles } from "../lib/log-reader.js";
import type { BugReport } from "../lib/bug-report.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Severity = "CRITICAL" | "WARNING" | "INFO";

interface Finding {
  severity: Severity;
  category: string;
  message: string;
  drillDown: string;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

const SEVERITY_ICON: Record<Severity, string> = {
  CRITICAL: "🔴",
  WARNING: "🟡",
  INFO: "🟢",
};

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function toolTriage(
  logDir: string | string[],
  bugReport: BugReport | null,
  args: {
    sccpFiles?: string[];
    errorFiles?: string[];
    lifecycleFiles?: string[];
    startTime?: string;
    endTime?: string;
  }
): Promise<string> {
  let { sccpFiles, errorFiles, lifecycleFiles, startTime, endTime } = args;

  // ── Auto-discover files if not provided ──────────────────────────────────
  if (!sccpFiles) {
    const found = await listLogFiles(logDir, { prefix: "sccp" });
    sccpFiles = found.length > 0 ? ["sccp"] : [];
  }
  if (!errorFiles) {
    const found = await listLogFiles(logDir, { prefix: "is" });
    errorFiles = found.length > 0 ? ["is"] : [];
  }
  if (!lifecycleFiles) {
    const found = await listLogFiles(logDir, { prefix: "is" });
    lifecycleFiles = found.length > 0 ? ["is"] : [];
  }

  // ── Run analyses in parallel ─────────────────────────────────────────────
  const promises: [
    Promise<Awaited<ReturnType<typeof computeHealthSummary>>>,
    Promise<Awaited<ReturnType<typeof computeErrorGroups>>>,
    Promise<string>,
    Promise<string | null>,
  ] = [
    sccpFiles.length > 0
      ? computeHealthSummary(logDir, { sccpFiles, errorFiles, startTime, endTime })
      : Promise.reject(new Error("No sccp files available")),

    errorFiles.length > 0
      ? computeErrorGroups(logDir, { files: errorFiles, deduplicate: true, startTime, endTime })
      : Promise.reject(new Error("No error files available")),

    lifecycleFiles.length > 0
      ? toolGetServiceLifecycle(logDir, { files: lifecycleFiles, startTime, endTime, limit: 50 })
      : Promise.reject(new Error("No lifecycle files available")),

    bugReport != null
      ? toolEventLog(bugReport, { log: "both", mode: "summary" })
      : Promise.resolve(null),
  ];

  const [healthResult, errorResult, lifecycleResult, eventLogResult] =
    await Promise.allSettled(promises);

  // ── Build findings ───────────────────────────────────────────────────────
  const findings: Finding[] = [];

  // --- Health findings ---
  if (healthResult.status === "fulfilled") {
    const h = healthResult.value;

    if (h.crashLoopCount > 0) {
      const names = h.processRows
        .filter(r => r.pattern === "crash-loop")
        .map(r => r.name)
        .join(", ");
      findings.push({
        severity: "CRITICAL",
        category: "Health",
        message: `${h.crashLoopCount} process(es) in crash-loop: ${names}`,
        drillDown: "sym_lifecycle mode=processes",
      });
    }

    if (h.totalRestarts > 0) {
      findings.push({
        severity: "WARNING",
        category: "Health",
        message: `${h.totalRestarts} total restart(s) detected`,
        drillDown: "sym_health",
      });
    }

    const degrading = h.processRows.filter(r => r.pattern === "degrading").map(r => r.name);
    if (degrading.length > 0) {
      findings.push({
        severity: "WARNING",
        category: "Health",
        message: `Memory degradation in: ${degrading.join(", ")}`,
        drillDown: "sym_health mode=trends",
      });
    }

    // Overall health rating
    let health: string;
    if (h.crashLoopCount > 0 || h.totalRestarts >= 5) {
      health = "CRITICAL";
    } else if (h.totalRestarts > 0 || h.errorCount > 50) {
      health = "DEGRADED";
    } else {
      health = "HEALTHY";
    }

    if (health === "CRITICAL") {
      findings.push({
        severity: "CRITICAL",
        category: "Health",
        message: "Overall health: CRITICAL",
        drillDown: "sym_health",
      });
    } else if (health === "DEGRADED") {
      findings.push({
        severity: "WARNING",
        category: "Health",
        message: "Overall health: DEGRADED",
        drillDown: "sym_health",
      });
    } else if (
      health === "HEALTHY" &&
      findings.length === 0
    ) {
      findings.push({
        severity: "INFO",
        category: "Health",
        message: "System appears healthy",
        drillDown: "sym_health",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Health",
      message: `Could not run health analysis: ${healthResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_health",
    });
  }

  // --- Error findings ---
  if (errorResult.status === "fulfilled") {
    const groups = errorResult.value.groups;
    const errorCount = [...groups.values()].reduce((s, g) => s + g.count, 0);
    const uniquePatterns = groups.size;

    if (errorCount > 50) {
      findings.push({
        severity: "WARNING",
        category: "Errors",
        message: `${errorCount} errors (${uniquePatterns} unique patterns)`,
        drillDown: "sym_search mode=errors files=is",
      });
    } else if (errorCount > 0) {
      findings.push({
        severity: "INFO",
        category: "Errors",
        message: `${errorCount} errors (${uniquePatterns} unique patterns)`,
        drillDown: "sym_search mode=errors files=is",
      });
    }

    // Top 3 error messages
    const topErrors = [...groups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    for (const e of topErrors) {
      findings.push({
        severity: "INFO",
        category: "Errors",
        message: `Top error: "${e.first.line.message.slice(0, 80)}"  (×${e.count})`,
        drillDown: "sym_search mode=errors files=is",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Errors",
      message: `Could not run error analysis: ${errorResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_search mode=errors",
    });
  }

  // --- Lifecycle findings ---
  if (lifecycleResult.status === "fulfilled") {
    const lcText = lifecycleResult.value;
    if (lcText.includes("CAUSE")) {
      const preview = lcText.split("\n").find(l => l.includes("CAUSE"))?.trim() ?? "";
      findings.push({
        severity: "WARNING",
        category: "Lifecycle",
        message: preview.slice(0, 120),
        drillDown: "sym_lifecycle mode=services",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Lifecycle",
      message: `Could not run lifecycle analysis: ${lifecycleResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_lifecycle",
    });
  }

  // --- Event log findings ---
  if (eventLogResult.status === "fulfilled") {
    const elText = eventLogResult.value;
    if (elText != null && (/Error/i.test(elText) || /Critical/i.test(elText))) {
      findings.push({
        severity: "WARNING",
        category: "Event Log",
        message: "Windows Event Log contains Error/Critical entries",
        drillDown: "sym_event_log",
      });
    }
  } else {
    findings.push({
      severity: "INFO",
      category: "Event Log",
      message: `Could not run event log analysis: ${eventLogResult.reason?.message ?? "unknown error"}`,
      drillDown: "sym_event_log",
    });
  }

  // ── Sort: CRITICAL > WARNING > INFO ──────────────────────────────────────
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // ── Format output ────────────────────────────────────────────────────────
  const critical = findings.filter(f => f.severity === "CRITICAL").length;
  const warnings = findings.filter(f => f.severity === "WARNING").length;
  const info = findings.filter(f => f.severity === "INFO").length;

  const bar = "═".repeat(47);
  const out: string[] = [
    bar,
    "  SYMPHONY TRIAGE REPORT",
    bar,
    "",
    `  ${findings.length} finding(s) — ${critical} critical, ${warnings} warnings, ${info} info`,
    "",
  ];

  for (const f of findings) {
    const icon = SEVERITY_ICON[f.severity];
    const sev = f.severity.padEnd(8);
    out.push(`  ${icon} ${sev}  [${f.category}] ${f.message}`);
    out.push(`     → Drill down: ${f.drillDown}`);
    out.push("");
  }

  out.push(bar);

  return out.join("\n");
}
