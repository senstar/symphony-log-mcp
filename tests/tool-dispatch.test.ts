import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatchToolCall } from "../src/tool-dispatch.js";
import { createTestLogDir, type TestLogDir } from "./test-helpers.js";

describe("dispatchToolCall", () => {
  let test: TestLogDir;

  beforeEach(async () => {
    test = await createTestLogDir();
  });

  afterEach(async () => {
    await test.cleanup();
  });

  // ── 1. Known tool dispatch (sym_triage) ──

  it("dispatches sym_triage and returns a string", async () => {
    const result = await dispatchToolCall("sym_triage", {}, test.ctx, test.dir);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // ── 2. sym_info action=list_files ──

  it("dispatches sym_info list_files and returns file listing", async () => {
    const result = await dispatchToolCall(
      "sym_info",
      { action: "list_files" },
      test.ctx,
      test.dir,
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("is-260302_00.txt");
  });

  // ── 3. sym_info action=decode_prefix (all prefixes) ──

  it("dispatches sym_info decode_prefix without prefix and returns mappings", async () => {
    const result = await dispatchToolCall(
      "sym_info",
      { action: "decode_prefix" },
      test.ctx,
      test.dir,
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("known prefixes");
  });

  // ── 4. sym_info action=bug_report when not a bug report ──

  it("returns not-a-bug-report message when bugReport is null", async () => {
    const result = await dispatchToolCall(
      "sym_info",
      { action: "bug_report" },
      test.ctx,
      test.dir,
    );
    expect(result).toContain("Not a bug report package");
  });

  // ── 5. sym_search mode=errors ──

  it("dispatches sym_search errors and returns a string", async () => {
    const result = await dispatchToolCall(
      "sym_search",
      { mode: "errors", files: "all" },
      test.ctx,
      test.dir,
    );
    expect(typeof result).toBe("string");
  });

  // ── 6. sym_search unknown mode ──

  it("throws for sym_search with unknown mode", async () => {
    await expect(
      dispatchToolCall("sym_search", { mode: "nonexistent" }, test.ctx, test.dir),
    ).rejects.toThrow("sym_search: unknown mode 'nonexistent'");
  });

  // ── 7. Unknown tool name ──

  it("throws for unknown tool name", async () => {
    await expect(
      dispatchToolCall("sym_nonexistent", {}, test.ctx, test.dir),
    ).rejects.toThrow("Unknown tool: sym_nonexistent");
  });

  // ── 8. sym_crashes unknown mode ──

  it("throws for sym_crashes with unknown mode", async () => {
    await expect(
      dispatchToolCall("sym_crashes", { mode: "bogus" }, test.ctx, test.dir),
    ).rejects.toThrow("sym_crashes: unknown mode 'bogus'");
  });

  // ── 9. sym_lifecycle unknown mode ──

  it("throws for sym_lifecycle with unknown mode", async () => {
    await expect(
      dispatchToolCall("sym_lifecycle", { mode: "bogus" }, test.ctx, test.dir),
    ).rejects.toThrow("sym_lifecycle: unknown mode 'bogus'");
  });

  // ── 10. sym_timeline unknown mode ──

  it("throws for sym_timeline with unknown mode", async () => {
    await expect(
      dispatchToolCall("sym_timeline", { mode: "bogus" }, test.ctx, test.dir),
    ).rejects.toThrow("sym_timeline: unknown mode 'bogus'");
  });

  // ── 11. Return type consistency for several known tools ──

  it("returns string for sym_network", async () => {
    const result = await dispatchToolCall("sym_network", {}, test.ctx, test.dir);
    expect(typeof result).toBe("string");
  });

  it("returns string for sym_alarms", async () => {
    const result = await dispatchToolCall("sym_alarms", {}, test.ctx, test.dir);
    expect(typeof result).toBe("string");
  });

  it("returns string for sym_video_health", async () => {
    const result = await dispatchToolCall("sym_video_health", {}, test.ctx, test.dir);
    expect(typeof result).toBe("string");
  });

  it("returns string for sym_storage", async () => {
    const result = await dispatchToolCall("sym_storage", {}, test.ctx, test.dir);
    expect(typeof result).toBe("string");
  });

  // ── sym_info unknown action ──

  it("throws for sym_info with unknown action", async () => {
    await expect(
      dispatchToolCall("sym_info", { action: "bogus" }, test.ctx, test.dir),
    ).rejects.toThrow("sym_info: unknown action 'bogus'");
  });
});
