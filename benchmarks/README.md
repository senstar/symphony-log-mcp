# E2E Benchmarks for symphony-log-mcp

Ground-truth scoring of `sym_*` tools against realistic log fixtures. Each fixture is a directory of Symphony log files paired with a JSON file that defines expected findings, severities, keywords, and negative assertions. The benchmark runs the tools against each fixture and scores the output across multiple dimensions.

## Running

```bash
npx vitest run --config benchmarks/vitest.config.ts
```

## Directory Structure

```
benchmarks/
  vitest.config.ts    # Vitest config for benchmarks
  e2e.bench.ts        # Test file — discovers fixtures, runs tools, scores output
  score.ts            # Pure scoring functions and grade computation
  fixtures/           # One subdirectory per fixture (contains log files)
  ground-truth/       # One JSON file per fixture (defines expected results)
```

## Adding a New Fixture

1. Create a directory under `fixtures/` with a descriptive name (e.g. `license-failure`).
2. Place representative Symphony log files inside it (InfoService, AE, SCCP, etc.).
3. Create `ground-truth/<fixture-name>.json` matching the `GroundTruth` interface in `score.ts`:
   - `expectedIssues` — issues the tools should detect, with severity, category, and key phrases.
   - `triage.expectedSeverity` — overall severity the triage tool should report.
   - `triage.mustContain` / `mustNotContain` — keywords that must or must not appear.
   - `errors.expectedCount` — min/max error count range.
   - `errors.expectedPatterns` — error patterns that should be found.
   - `lifecycle.expectedRestarts` — min/max restart count range.
   - `lifecycle.expectedEvents` — lifecycle events that should appear.
   - `health.expectedRating` — expected health rating.
   - `health.crashLoopProcesses` — processes expected to be in crash loops.

## Scoring Dimensions

| Dimension            | Weight | Description                                              |
|----------------------|--------|----------------------------------------------------------|
| Issue Detection      | 25%    | Were expected issues found (via key phrases)?            |
| Severity Accuracy    | 20%    | Does reported severity match expected? (partial credit)  |
| False Positives      | 15%    | Were mustNotContain phrases absent from triage output?   |
| Keyword Coverage     | 20%    | Were mustContain keywords present across all tool output?|
| Completeness         | 10%    | Category coverage, error/restart counts in range         |
| Negative Assertions  | 10%    | Were mustNotContain phrases absent across all outputs?   |

## Grade Scale

| Grade | Score Range |
|-------|-------------|
| A     | 9.0 – 10.0  |
| B     | 8.0 – 8.9   |
| C     | 7.0 – 7.9   |
| D     | 6.0 – 6.9   |
| F     | < 6.0       |

All individual dimension tests and the overall weighted score require >= 7.0 to pass.

## Expected Output

```
 ✓ E2E Benchmarks > service-restart > triage runs without error
 ✓ E2E Benchmarks > service-restart > issue detection score >= 7
 ✓ E2E Benchmarks > service-restart > severity accuracy score >= 7
 ✓ E2E Benchmarks > service-restart > false positives score >= 7
 ✓ E2E Benchmarks > service-restart > keyword coverage score >= 7
 ✓ E2E Benchmarks > service-restart > completeness score >= 7
 ✓ E2E Benchmarks > service-restart > negative assertions score >= 7
 ✓ E2E Benchmarks > service-restart > overall weighted score >= 7.0

Fixture      Detection  Severity  FalsePos  Keywords  Complete  NegAssert  Overall  Grade
service-restart  10.0      10.0      10.0      8.5       9.0       10.0       9.6      A

Benchmark complete — 1 fixture(s) scored.
```
