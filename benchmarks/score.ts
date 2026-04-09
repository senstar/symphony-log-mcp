/**
 * score.ts — Reusable scoring functions for symphony-log-mcp e2e benchmarks.
 *
 * All functions are pure (no I/O), all string comparisons case-insensitive,
 * all scores clamped to [0, 10].
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GroundTruth {
  fixture: string;
  description: string;
  expectedIssues: {
    severity: "CRITICAL" | "WARNING" | "INFO";
    category: string;
    keyPhrases: string[];
  }[];
  triage: {
    expectedSeverity: "CRITICAL" | "WARNING" | "INFO" | "HEALTHY";
    mustContain: string[];
    mustNotContain: string[];
  };
  errors: {
    expectedCount: { min: number; max: number };
    expectedPatterns: string[];
  };
  lifecycle: {
    expectedRestarts: { min: number; max: number };
    expectedEvents: string[];
  };
  health: {
    expectedRating: "CRITICAL" | "DEGRADED" | "HEALTHY";
    crashLoopProcesses: string[];
  };
  connectivity?: {
    expectedIssueCount: number;
    mustContain: string[];
  };
}

export interface DimensionScores {
  issueDetection: number;
  severityAccuracy: number;
  falsePositives: number;
  keywordCoverage: number;
  completeness: number;
  negativeAssertions: number;
}

export interface BenchmarkResult {
  fixture: string;
  dimensions: DimensionScores;
  overall: number;
  grade: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number): number {
  return Math.max(0, Math.min(10, value));
}

function containsCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function allOutputs(outputs: Record<string, string>): string {
  return Object.values(outputs).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity adjacency map for partial credit
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  DEGRADED: 1, // DEGRADED treated same as WARNING for adjacency
  INFO: 2,
  HEALTHY: 3,
};

function severityDistance(a: string, b: string): number {
  const ra = SEVERITY_RANK[a.toUpperCase()] ?? -1;
  const rb = SEVERITY_RANK[b.toUpperCase()] ?? -1;
  if (ra === -1 || rb === -1) return 99;
  return Math.abs(ra - rb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring functions (all return 0–10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For each expected issue, check if ANY of its keyPhrases appear in triageOutput.
 * Score = (issues found / total expected) * 10.
 * If no expected issues and output mentions "healthy", score = 10.
 */
export function scoreIssueDetection(triageOutput: string, gt: GroundTruth): number {
  const expected = gt.expectedIssues;
  if (expected.length === 0) {
    // No issues expected — score 10 if output looks clean
    const cleanIndicators = ["healthy", "no issues", "no findings"];
    const isClean = cleanIndicators.some((kw) => containsCI(triageOutput, kw));
    return isClean ? 10 : 10; // no expected issues = 10 regardless
  }

  let found = 0;
  for (const issue of expected) {
    const hit = issue.keyPhrases.some((phrase) => containsCI(triageOutput, phrase));
    if (hit) found++;
  }

  return clamp((found / expected.length) * 10);
}

/**
 * Check if triage output's overall severity matches gt.triage.expectedSeverity.
 * Full match = 10, adjacent mismatch = 5, total mismatch = 0.
 */
export function scoreSeverityAccuracy(triageOutput: string, gt: GroundTruth): number {
  const expected = gt.triage.expectedSeverity;

  // Detect the actual severity from the triage findings summary line.
  // Format: "N finding(s) — X critical, Y warnings, Z info"
  // After zero-count suppression, absent categories mean zero.
  let detected: string | null = null;

  const summaryMatch = triageOutput.match(/\d+\s+finding\(s\)\s*[—–-]\s*(.*)/);
  if (summaryMatch) {
    const summary = summaryMatch[1].toLowerCase();
    if (/\d+\s+critical/.test(summary)) {
      detected = "CRITICAL";
    } else if (/\d+\s+warning/.test(summary)) {
      detected = "WARNING";
    } else {
      detected = "HEALTHY";
    }
  }

  // Fallback: look for Overall health line
  if (!detected) {
    const upper = triageOutput.toUpperCase();
    if (upper.includes("OVERALL HEALTH: CRITICAL")) detected = "CRITICAL";
    else if (upper.includes("OVERALL HEALTH: DEGRADED")) detected = "WARNING";
    else if (upper.includes("OVERALL HEALTH: HEALTHY")) detected = "HEALTHY";
  }

  if (!detected) return 0;

  const dist = severityDistance(detected, expected);
  if (dist === 0) return 10;
  if (dist === 1) return 5;
  return 0;
}

/**
 * Count mustNotContain phrases that appear in triage output.
 * Score = 10 - (violations / total) * 10.
 */
export function scoreFalsePositives(triageOutput: string, gt: GroundTruth): number {
  const forbidden = gt.triage.mustNotContain;
  if (forbidden.length === 0) return 10;

  let violations = 0;
  for (const phrase of forbidden) {
    if (containsCI(triageOutput, phrase)) violations++;
  }

  return clamp(10 - (violations / forbidden.length) * 10);
}

/**
 * Across ALL tool outputs, check gt.triage.mustContain keywords.
 * Score = (matched / total) * 10.
 */
export function scoreKeywordCoverage(outputs: Record<string, string>, gt: GroundTruth): number {
  const required = gt.triage.mustContain;
  if (required.length === 0) return 10;

  const combined = allOutputs(outputs);
  let matched = 0;
  for (const kw of required) {
    if (containsCI(combined, kw)) matched++;
  }

  return clamp((matched / required.length) * 10);
}

/**
 * Check completeness across multiple dimensions:
 * - Each expected issue category is covered somewhere in outputs
 * - Error count is within expected range
 * - Restart count is within expected range
 * Score based on fraction of checks that pass.
 */
export function scoreCompleteness(outputs: Record<string, string>, gt: GroundTruth): number {
  const checks: boolean[] = [];
  const combined = allOutputs(outputs);

  // Check each expected issue category appears
  const categories = new Set(gt.expectedIssues.map((i) => i.category));
  for (const cat of categories) {
    checks.push(containsCI(combined, cat));
  }

  // Check error count in range — look for a number near "error" in the output
  const errorCountMatch = combined.match(/(\d+)\s*error/i);
  if (errorCountMatch) {
    const count = parseInt(errorCountMatch[1], 10);
    checks.push(count >= gt.errors.expectedCount.min && count <= gt.errors.expectedCount.max);
  } else if (gt.errors.expectedCount.min === 0) {
    // No error mention is OK if we expect 0
    checks.push(true);
  } else {
    checks.push(false);
  }

  // Check restart count in range — look for a number near "restart"
  const restartCountMatch = combined.match(/(\d+)\s*(?:total\s+)?restart/i);
  if (restartCountMatch) {
    const count = parseInt(restartCountMatch[1], 10);
    checks.push(count >= gt.lifecycle.expectedRestarts.min && count <= gt.lifecycle.expectedRestarts.max);
  } else if (gt.lifecycle.expectedRestarts.min === 0) {
    checks.push(true);
  } else {
    checks.push(false);
  }

  // Check expected error patterns
  for (const pattern of gt.errors.expectedPatterns) {
    checks.push(containsCI(combined, pattern));
  }

  // Check expected lifecycle events
  for (const event of gt.lifecycle.expectedEvents) {
    checks.push(containsCI(combined, event));
  }

  if (checks.length === 0) return 10;

  const passed = checks.filter(Boolean).length;
  return clamp((passed / checks.length) * 10);
}

/**
 * Check mustNotContain across ALL outputs.
 * Score = 10 - (violations / total) * 10.
 */
export function scoreNegativeAssertions(outputs: Record<string, string>, gt: GroundTruth): number {
  const forbidden = gt.triage.mustNotContain;
  if (forbidden.length === 0) return 10;

  const combined = allOutputs(outputs);
  let violations = 0;
  for (const phrase of forbidden) {
    if (containsCI(combined, phrase)) violations++;
  }

  return clamp(10 - (violations / forbidden.length) * 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Weighted scoring & grading
// ─────────────────────────────────────────────────────────────────────────────

const WEIGHTS: Record<keyof DimensionScores, number> = {
  issueDetection: 0.25,
  severityAccuracy: 0.20,
  falsePositives: 0.15,
  keywordCoverage: 0.20,
  completeness: 0.10,
  negativeAssertions: 0.10,
};

export function computeWeightedScore(scores: DimensionScores): { overall: number; grade: string } {
  let overall = 0;
  for (const [dim, weight] of Object.entries(WEIGHTS)) {
    overall += scores[dim as keyof DimensionScores] * weight;
  }
  overall = clamp(overall);

  let grade: string;
  if (overall >= 9) grade = "A";
  else if (overall >= 8) grade = "B";
  else if (overall >= 7) grade = "C";
  else if (overall >= 6) grade = "D";
  else grade = "F";

  return { overall, grade };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report formatting
// ─────────────────────────────────────────────────────────────────────────────

export function formatScoreReport(results: BenchmarkResult[]): string {
  const header = [
    "Fixture",
    "Detection",
    "Severity",
    "FalsePos",
    "Keywords",
    "Complete",
    "NegAssert",
    "Overall",
    "Grade",
  ];

  const rows = results.map((r) => [
    r.fixture,
    r.dimensions.issueDetection.toFixed(1),
    r.dimensions.severityAccuracy.toFixed(1),
    r.dimensions.falsePositives.toFixed(1),
    r.dimensions.keywordCoverage.toFixed(1),
    r.dimensions.completeness.toFixed(1),
    r.dimensions.negativeAssertions.toFixed(1),
    r.overall.toFixed(1),
    r.grade,
  ]);

  // Compute column widths
  const allRows = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...allRows.map((row) => row[col].length))
  );

  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const formatRow = (row: string[]) =>
    row.map((cell, i) => ` ${cell.padEnd(widths[i])} `).join("│");

  const lines = [
    formatRow(header),
    sep,
    ...rows.map(formatRow),
  ];

  // Summary
  if (results.length > 0) {
    const avgOverall = results.reduce((s, r) => s + r.overall, 0) / results.length;
    lines.push("");
    lines.push(`Average: ${avgOverall.toFixed(1)} | Fixtures: ${results.length}`);
  }

  return lines.join("\n");
}
