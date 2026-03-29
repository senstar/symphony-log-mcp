import { describe, it, expect } from "vitest";
import {
  timestampToMs,
  parseTookMs,
  parseLogLine,
  parseLogEntries,
  extractStackTrace,
  isNativeStackFrame,
} from "../../src/lib/log-parser.js";

// ------------------------------------------------------------------ helpers

const MS_PER_DAY = 86_400_000;

function makeLine(
  ts: string,
  threadId: string,
  level8: string,
  body: string,
): string {
  // level8 must be exactly 8 chars
  const padded = (level8 + "        ").slice(0, 8);
  const tid = threadId.padStart(7, " ");
  return `${ts} ${tid} <${padded}> ${body}`;
}

// ================================================================== tests

describe("timestampToMs", () => {
  it("converts a normal timestamp", () => {
    // 01:02:03.456 → 1*3600000 + 2*60000 + 3*1000 + 456
    expect(timestampToMs("01:02:03.456")).toBe(3_723_456);
  });

  it("handles midnight (00:00:00.000)", () => {
    expect(timestampToMs("00:00:00.000")).toBe(0);
  });

  it("handles just before midnight (23:59:59.999)", () => {
    expect(timestampToMs("23:59:59.999")).toBe(MS_PER_DAY - 1);
  });

  it("handles noon", () => {
    expect(timestampToMs("12:00:00.000")).toBe(43_200_000);
  });

  it("handles single-digit fractional part", () => {
    // "10:00:00.5" → frac "5" → padded to "500" → 500 ms
    expect(timestampToMs("10:00:00.5")).toBe(36_000_500);
  });
});

describe("parseTookMs", () => {
  it("parses a standard 'took' duration", () => {
    const msg = "Request completed, took 00:00:05.1230000 for /api/foo";
    expect(parseTookMs(msg)).toBe(5_123);
  });

  it("parses hours and minutes", () => {
    const msg = "took 01:30:00.0000000";
    expect(parseTookMs(msg)).toBe(5_400_000);
  });

  it("returns null when no 'took' pattern", () => {
    expect(parseTookMs("Request completed successfully")).toBeNull();
  });

  it("parses zero duration", () => {
    expect(parseTookMs("took 00:00:00.0000000")).toBe(0);
  });

  it("handles short fractional digits", () => {
    // "took 00:00:01.5" → frac "5" padded to "500" → 500ms
    expect(parseTookMs("took 00:00:01.5")).toBe(1_500);
  });

  it("handles long fractional digits rounding", () => {
    // "took 00:00:00.9999999" → frac "9999999" → first 3 = "999" → 999ms
    expect(parseTookMs("took 00:00:00.9999999")).toBe(999);
  });
});

describe("parseLogLine", () => {
  it("parses an Error line with functional area, source, context, and message", () => {
    const raw = makeLine(
      "10:30:45.123",
      "42",
      "Error",
      "WebService\tProcessor[ctx123]\tSomething failed",
    );
    const line = parseLogLine(raw, 1);
    expect(line).not.toBeNull();
    expect(line!.timestamp).toBe("10:30:45.123");
    expect(line!.timestampMs).toBe(timestampToMs("10:30:45.123"));
    expect(line!.threadId).toBe("42");
    expect(line!.level).toBe("Error");
    expect(line!.rawLevel).toBe("Error");
    expect(line!.functionalArea).toBe("WebService");
    expect(line!.source).toBe("Processor");
    expect(line!.sourceContext).toBe("ctx123");
    expect(line!.message).toBe("Something failed");
    expect(line!.lineNumber).toBe(1);
    expect(line!.raw).toBe(raw);
  });

  it("parses BasicInfo level", () => {
    const raw = makeLine("00:00:01.000", "1", "BasicInf", "Msg\tBody");
    const line = parseLogLine(raw, 5);
    expect(line!.level).toBe("BasicInfo");
    expect(line!.rawLevel).toBe("BasicInf");
  });

  it("parses MoreInfo level", () => {
    const raw = makeLine("00:00:01.000", "1", "MoreInfo", "Msg\tBody");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("MoreInfo");
  });

  it("parses Diagnostic level", () => {
    const raw = makeLine("12:00:00.000", "1", "Diagnost", "Area\tSrc\tMsg");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("Diagnostic");
    expect(line!.rawLevel).toBe("Diagnost");
  });

  it("parses Verbose level", () => {
    const raw = makeLine("12:00:00.000", "1", "Verbose", "Hello");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("Verbose");
  });

  it("maps sub-diagnostic level Tracker to Verbose", () => {
    const raw = makeLine("12:00:00.000", "99", "Tracker", "Area\tSrc\tTracking info");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("Verbose");
    expect(line!.rawLevel).toBe("Tracker");
  });

  it("maps sub-diagnostic level Classifi to Verbose", () => {
    const raw = makeLine("12:00:00.000", "1", "Classifi", "Message");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("Verbose");
    expect(line!.rawLevel).toBe("Classifi");
  });

  it("maps sub-diagnostic level AccessCo to Verbose", () => {
    const raw = makeLine("12:00:00.000", "1", "AccessCo", "Data");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("Verbose");
    expect(line!.rawLevel).toBe("AccessCo");
  });

  it("maps unknown level to Unknown", () => {
    const raw = makeLine("12:00:00.000", "1", "XxYyZzWw", "Data");
    const line = parseLogLine(raw, 1);
    expect(line!.level).toBe("Unknown");
    expect(line!.rawLevel).toBe("XxYyZzWw");
  });

  it("parses line with source[context] but no functional area (2 tab parts)", () => {
    const raw = makeLine("09:00:00.000", "10", "MoreInfo", "Handler[req42]\tOK done");
    const line = parseLogLine(raw, 1);
    expect(line!.functionalArea).toBe("");
    expect(line!.source).toBe("Handler");
    expect(line!.sourceContext).toBe("req42");
    expect(line!.message).toBe("OK done");
  });

  it("parses line with functional area but no source context (2 tab parts, no bracket)", () => {
    const raw = makeLine("09:00:00.000", "10", "MoreInfo", "Communication\tConnected");
    const line = parseLogLine(raw, 1);
    expect(line!.functionalArea).toBe("Communication");
    expect(line!.source).toBe("");
    expect(line!.message).toBe("Connected");
  });

  it("parses a message-only line (no tabs)", () => {
    const raw = makeLine("09:00:00.000", "10", "Error", "Something bad happened");
    const line = parseLogLine(raw, 1);
    expect(line!.functionalArea).toBe("");
    expect(line!.source).toBe("");
    expect(line!.sourceContext).toBe("");
    expect(line!.message).toBe("Something bad happened");
  });

  it("returns null for non-matching lines", () => {
    expect(parseLogLine("", 1)).toBeNull();
    expect(parseLogLine("Just some random text", 1)).toBeNull();
    expect(parseLogLine("   at System.Something()", 1)).toBeNull();
  });

  it("preserves tabs in message when 3+ tab parts exist", () => {
    const raw = makeLine(
      "09:00:00.000",
      "10",
      "BasicInf",
      "Area\tSrc[c]\tpart1\tpart2",
    );
    const line = parseLogLine(raw, 1);
    expect(line!.message).toBe("part1\tpart2");
  });
});

describe("parseLogEntries", () => {
  it("groups a single entry with no continuations", () => {
    const raw = makeLine("10:00:00.000", "1", "Error", "Boom");
    const entries = parseLogEntries([raw]);
    expect(entries).toHaveLength(1);
    expect(entries[0].line.message).toBe("Boom");
    expect(entries[0].continuationLines).toHaveLength(0);
    expect(entries[0].fullText).toBe(raw);
  });

  it("groups continuation lines (stack trace) with their parent entry", () => {
    const mainLine = makeLine("10:00:00.000", "1", "Error", "NullRef");
    const stack1 = "   at Foo.Bar()";
    const stack2 = "   at Baz.Qux()";
    const entries = parseLogEntries([mainLine, stack1, stack2]);
    expect(entries).toHaveLength(1);
    expect(entries[0].continuationLines).toEqual([stack1, stack2]);
    expect(entries[0].fullText).toBe(`${mainLine}\n${stack1}\n${stack2}`);
  });

  it("handles multiple entries in sequence", () => {
    const line1 = makeLine("10:00:00.000", "1", "BasicInf", "First");
    const line2 = makeLine("10:00:01.000", "1", "BasicInf", "Second");
    const line3 = makeLine("10:00:02.000", "1", "Error", "Third");
    const entries = parseLogEntries([line1, line2, line3]);
    expect(entries).toHaveLength(3);
    expect(entries[0].line.message).toBe("First");
    expect(entries[1].line.message).toBe("Second");
    expect(entries[2].line.message).toBe("Third");
  });

  it("applies midnight rollover offset when timestamp jumps backward >20h", () => {
    const beforeMidnight = makeLine("23:59:59.000", "1", "BasicInf", "Before");
    const afterMidnight = makeLine("00:00:01.000", "1", "BasicInf", "After");

    const entries = parseLogEntries([beforeMidnight, afterMidnight]);
    expect(entries).toHaveLength(2);

    const msBefore = entries[0].line.timestampMs;
    const msAfter = entries[1].line.timestampMs;

    // After midnight should have day offset applied
    expect(msAfter).toBe(timestampToMs("00:00:01.000") + MS_PER_DAY);
    // And it should sort after the before-midnight entry
    expect(msAfter).toBeGreaterThan(msBefore);
  });

  it("does NOT apply rollover for small backward jumps (within 20h)", () => {
    // Out-of-order lines that are close should NOT trigger rollover
    const line1 = makeLine("10:00:00.000", "1", "BasicInf", "Earlier");
    const line2 = makeLine("09:59:59.000", "1", "BasicInf", "Slightly earlier");

    const entries = parseLogEntries([line1, line2]);
    expect(entries).toHaveLength(2);

    // No day offset — just the raw timestamps
    expect(entries[0].line.timestampMs).toBe(timestampToMs("10:00:00.000"));
    expect(entries[1].line.timestampMs).toBe(timestampToMs("09:59:59.000"));
  });

  it("attaches non-matching, non-indented lines as continuations of the previous entry", () => {
    const mainLine = makeLine("10:00:00.000", "1", "Error", "Crash");
    const garbage = "SOME GARBAGE LINE";
    const entries = parseLogEntries([mainLine, garbage]);
    expect(entries).toHaveLength(1);
    expect(entries[0].continuationLines).toContain(garbage);
  });

  it("sets lineNumber to 1-based index", () => {
    const line1 = makeLine("10:00:00.000", "1", "BasicInf", "A");
    const line2 = makeLine("10:00:01.000", "1", "BasicInf", "B");
    const entries = parseLogEntries([line1, line2]);
    expect(entries[0].line.lineNumber).toBe(1);
    expect(entries[1].line.lineNumber).toBe(2);
  });
});

describe("extractStackTrace", () => {
  it("extracts .NET stack frames from continuation lines", () => {
    const mainLine = makeLine("10:00:00.000", "1", "Error", "System.NullReferenceException");
    const stack1 = "   at Foo.Bar() in C:\\src\\Foo.cs:line 42";
    const stack2 = "   at Baz.Qux()";
    const entries = parseLogEntries([mainLine, stack1, stack2]);
    const trace = extractStackTrace(entries[0]);
    expect(trace).not.toBeNull();
    expect(trace).toContain("System.NullReferenceException");
    expect(trace).toContain("at Foo.Bar()");
    expect(trace).toContain("at Baz.Qux()");
  });

  it("returns null when no stack frames in continuation lines", () => {
    const mainLine = makeLine("10:00:00.000", "1", "BasicInf", "All good");
    const entries = parseLogEntries([mainLine]);
    expect(extractStackTrace(entries[0])).toBeNull();
  });

  it("returns null when continuation lines exist but none are 'at' frames", () => {
    const mainLine = makeLine("10:00:00.000", "1", "Error", "Bad stuff");
    const cont = "  some extra detail without a stack frame";
    const entries = parseLogEntries([mainLine, cont]);
    expect(extractStackTrace(entries[0])).toBeNull();
  });

  it("filters out non-frame continuation lines from the trace", () => {
    const mainLine = makeLine("10:00:00.000", "1", "Error", "Boom");
    const extra = "  extra context";
    const frame = "   at MyClass.MyMethod()";
    const entries = parseLogEntries([mainLine, extra, frame]);
    const trace = extractStackTrace(entries[0]);
    expect(trace).not.toBeNull();
    expect(trace).toContain("at MyClass.MyMethod()");
    expect(trace).not.toContain("extra context");
  });
});

describe("isNativeStackFrame", () => {
  it("matches module!0x address pattern", () => {
    expect(isNativeStackFrame("ntdll!0x12345678")).toBe(true);
  });

  it("matches +0x offset pattern", () => {
    expect(isNativeStackFrame("SomeModule.dll+0xABCDEF")).toBe(true);
  });

  it("matches leading hex address (8 digits)", () => {
    expect(isNativeStackFrame("0012FA00 some_function")).toBe(true);
  });

  it("matches leading hex address (16 digits)", () => {
    expect(isNativeStackFrame("0000000012345678 some_function")).toBe(true);
  });

  it("returns false for .NET stack frames", () => {
    expect(isNativeStackFrame("   at System.String.Concat()")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isNativeStackFrame("")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(isNativeStackFrame("Just a regular message")).toBe(false);
  });
});

