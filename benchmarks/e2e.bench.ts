import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { toolTriage } from "../src/tools/triage.js";
import { toolSearchErrors } from "../src/tools/search-errors.js";
import { toolGetServiceLifecycle } from "../src/tools/service-lifecycle.js";
import { toolSummarizeHealth } from "../src/tools/summarize-health.js";
import {
  scoreIssueDetection,
  scoreSeverityAccuracy,
  scoreFalsePositives,
  scoreKeywordCoverage,
  scoreCompleteness,
  scoreNegativeAssertions,
  computeWeightedScore,
  formatScoreReport,
  type GroundTruth,
  type DimensionScores,
  type BenchmarkResult,
} from "./score.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");
const groundTruthDir = join(__dirname, "ground-truth");

const fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const allResults: BenchmarkResult[] = [];

describe("E2E Benchmarks", { timeout: 30_000 }, () => {
  for (const fixtureName of fixtureNames) {
    describe(fixtureName, () => {
      const gtPath = join(groundTruthDir, `${fixtureName}.json`);
      let gt: GroundTruth;
      try {
        gt = JSON.parse(readFileSync(gtPath, "utf-8"));
      } catch {
        // Skip fixtures without ground truth
        it.skip("no ground truth file", () => {});
        return;
      }

      const fixtureDir = join(fixturesDir, fixtureName);

      let triageOutput = "";
      let errorsOutput = "";
      let lifecycleOutput = "";
      let healthOutput = "";

      beforeAll(async () => {
        const [triage, errors, lifecycle, health] = await Promise.all([
          toolTriage(fixtureDir, null, {}),
          toolSearchErrors(fixtureDir, { files: ["is", "ae", "sccp"] }).catch(() => ""),
          toolGetServiceLifecycle(fixtureDir, { files: ["is", "sc"] }).catch(() => ""),
          toolSummarizeHealth(fixtureDir, { sccpFiles: ["sccp"], errorFiles: ["is"] }).catch(() => ""),
        ]);
        triageOutput = triage;
        errorsOutput = errors;
        lifecycleOutput = lifecycle;
        healthOutput = health;
      });

      const outputs = () => ({
        triage: triageOutput,
        errors: errorsOutput,
        lifecycle: lifecycleOutput,
        health: healthOutput,
      });

      it("triage runs without error", () => {
        expect(triageOutput).toBeTruthy();
      });

      it("issue detection score >= 7", () => {
        const score = scoreIssueDetection(triageOutput, gt);
        console.log(`  [${fixtureName}] Issue Detection: ${score.toFixed(1)}/10`);
        expect(score).toBeGreaterThanOrEqual(7);
      });

      it("severity accuracy score >= 7", () => {
        const score = scoreSeverityAccuracy(triageOutput, gt);
        console.log(`  [${fixtureName}] Severity Accuracy: ${score.toFixed(1)}/10`);
        expect(score).toBeGreaterThanOrEqual(7);
      });

      it("false positives score >= 7", () => {
        const score = scoreFalsePositives(triageOutput, gt);
        console.log(`  [${fixtureName}] False Positives: ${score.toFixed(1)}/10`);
        expect(score).toBeGreaterThanOrEqual(7);
      });

      it("keyword coverage score >= 7", () => {
        const score = scoreKeywordCoverage(outputs(), gt);
        console.log(`  [${fixtureName}] Keyword Coverage: ${score.toFixed(1)}/10`);
        expect(score).toBeGreaterThanOrEqual(7);
      });

      it("completeness score >= 7", () => {
        const score = scoreCompleteness(outputs(), gt);
        console.log(`  [${fixtureName}] Completeness: ${score.toFixed(1)}/10`);
        expect(score).toBeGreaterThanOrEqual(7);
      });

      it("negative assertions score >= 7", () => {
        const score = scoreNegativeAssertions(outputs(), gt);
        console.log(`  [${fixtureName}] Negative Assertions: ${score.toFixed(1)}/10`);
        expect(score).toBeGreaterThanOrEqual(7);
      });

      it("overall weighted score >= 7.0", () => {
        const dimensions: DimensionScores = {
          issueDetection: scoreIssueDetection(triageOutput, gt),
          severityAccuracy: scoreSeverityAccuracy(triageOutput, gt),
          falsePositives: scoreFalsePositives(triageOutput, gt),
          keywordCoverage: scoreKeywordCoverage(outputs(), gt),
          completeness: scoreCompleteness(outputs(), gt),
          negativeAssertions: scoreNegativeAssertions(outputs(), gt),
        };
        const result = computeWeightedScore(dimensions);
        console.log(`  [${fixtureName}] Overall: ${result.overall.toFixed(1)}/10 (${result.grade})`);

        allResults.push({
          fixture: fixtureName,
          dimensions,
          overall: result.overall,
          grade: result.grade,
        });

        expect(result.overall).toBeGreaterThanOrEqual(7.0);
      });
    });
  }

  it("benchmark summary", () => {
    if (allResults.length > 0) {
      console.log("\n" + formatScoreReport(allResults));
    }
    console.log(`Benchmark complete — ${allResults.length} fixture(s) scored.`);
    expect(allResults.length).toBeGreaterThan(0);
  });
});
