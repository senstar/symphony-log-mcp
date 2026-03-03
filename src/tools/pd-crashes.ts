/**
 * pd log parser — handles the PDebug crash dump format.
 *
 * Unlike regular Symphony logs, the pd log emits every stack frame as its own
 * top-level log line with level <All>.  Structure inside one crash block:
 *
 *   HH:MM:SS.mmm  TID <Error> *** new crash
 *   HH:MM:SS.mmm  TID <All>   Saved minidump to PATH ...
 *   HH:MM:SS.mmm  TID <All>   Terminating process PATH (PID NNNN)
 *   HH:MM:SS.mmm  TID <All>   Command line: "..."
 *   HH:MM:SS.mmm  TID <All>   Stack for thread NNNN
 *   HH:MM:SS.mmm  TID <All>   RAX: ...  RBX: ...         <- register dump
 *   HH:MM:SS.mmm  TID <All>   HEXADDR(args) file.cpp(N)+N: DLL at Symbol+off  <- frame
 *   HH:MM:SS.mmm  TID <All>   ADDR <- ADDR <- ...        <- call chain summary
 *   ...repeated for each thread...
 */

import * as fs from "fs/promises";
import * as path from "path";
import { resolveFileRefs } from "../lib/log-reader.js";

interface PdFrame {
  address: string;
  dll: string;
  symbol: string;
}

interface PdThread {
  threadId: string;
  registers: string;
  frames: PdFrame[];
}

interface PdCrash {
  file: string;
  timestamp: string;
  processName: string;
  pid: string;
  minidump: string;
  threads: PdThread[];
}

/** Parse a pd log line into { timestamp, threadId, message } */
function parsePdLine(line: string): { timestamp: string; threadId: string; message: string } | null {
  // Format: "HH:MM:SS.mmm   THREADID <LEVEL   > message"
  const m = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+<\S+\s*>\s+(.*)$/.exec(line);
  if (!m) return null;
  return { timestamp: m[1], threadId: m[2], message: m[3].trim() };
}

/** Extract DLL name and symbol from a pd stack frame message.
 *  e.g. "7FFFB2D6A8C1(0, 0, 0, 0)+0000: C:\Windows\SYSTEM32\ntdll.dll(10.0...) at RtlUserThreadStart()+0021"
 *  Returns { address, dll, symbol }
 */
function parsePdFrame(msg: string): PdFrame | null {
  // Must start with a hex address
  if (!/^[0-9a-fA-F]{10,}/.test(msg)) return null;
  const addrM = /^([0-9a-fA-F]+)/.exec(msg);
  const address = addrM?.[1] ?? "";
  // DLL path after the first colon-space
  const dllM = /:\s*((?:[A-Za-z]:\\|\/)[^\(]+\([\d.]+[^)]*\))/.exec(msg);
  const dll = dllM ? path.basename(dllM[1].split("(")[0].trim()) : "";
  // Symbol: "at Symbol()+offset" or "at Unknown()+offset"
  const symbolM = /\bat\s+(\S+)/.exec(msg);
  const symbol = symbolM?.[1] ?? "";
  // Skip lines that are just a call-chain summary (hex <- hex <- ...)
  if (/^[0-9a-fA-F]+ <- [0-9a-fA-F]+/.test(msg)) return null;
  if (!dll && !symbol) return null;
  return { address, dll, symbol };
}

/** Parse all crash blocks from pd log lines */
function parsePdCrashes(rawLines: string[], filename: string): PdCrash[] {
  const crashes: PdCrash[] = [];
  let currentCrash: PdCrash | null = null;
  let currentThread: PdThread | null = null;

  const flush = () => {
    if (currentThread && currentCrash) currentCrash.threads.push(currentThread);
    currentThread = null;
  };

  for (const raw of rawLines) {
    const parsed = parsePdLine(raw);
    if (!parsed) continue;
    const { timestamp, message } = parsed;

    if (/new crash/i.test(message)) {
      flush();
      if (currentCrash) crashes.push(currentCrash);
      currentCrash = { file: filename, timestamp, processName: "", pid: "", minidump: "", threads: [] };
      continue;
    }
    if (!currentCrash) continue;

    if (/Saved minidump to/i.test(message)) {
      const m = /Saved minidump to\s+(.+?)\.\s+Error/i.exec(message);
      currentCrash.minidump = m?.[1].trim() ?? message.slice(0, 80);
      continue;
    }
    if (/Terminating process/i.test(message)) {
      // "Terminating process C:\...trackerapp.exe (PID 8588)"
      const m = /Terminating process\s+(.+?)\s+\(PID\s+(\d+)\)/i.exec(message);
      if (m) {
        currentCrash.processName = path.basename(m[1].trim());
        currentCrash.pid = m[2];
      }
      continue;
    }
    if (/^Stack for thread\s+(\d+)/i.test(message)) {
      flush();
      const m = /Stack for thread\s+(\d+)/i.exec(message);
      currentThread = { threadId: m?.[1] ?? "", registers: "", frames: [] };
      continue;
    }
    if (/^R[A-Z]{2}:\s+[0-9a-fA-F]+/.test(message)) {
      if (currentThread) currentThread.registers = message.slice(0, 120);
      continue;
    }
    // Stack frame line
    const frame = parsePdFrame(message);
    if (frame && currentThread) {
      currentThread.frames.push(frame);
    }
  }

  flush();
  if (currentCrash) crashes.push(currentCrash);
  return crashes;
}

export async function toolGetPdCrashes(
  logDir: string | string[],
  args: {
    files: string[];
    /** Max frames to show per thread (default 8) */
    framesPerThread?: number;
    /** Max threads to show per crash (default 3 — crashing thread + 2 others) */
    threadsPerCrash?: number;
    limit?: number;
  }
): Promise<string> {
  const framesPerThread = args.framesPerThread ?? 8;
  const threadsPerCrash = args.threadsPerCrash ?? 3;
  const limit = args.limit ?? 20;

  const allCrashes: PdCrash[] = [];
  const paths = await resolveFileRefs(args.files, logDir);

  if (paths.length === 0) return "No pd log files found.";

  for (const fullPath of paths) {
    const filename = path.basename(fullPath);
    let raw: string;
    try {
      raw = await fs.readFile(fullPath, "utf8");
    } catch (e) {
      continue;
    }
    // Strip UTF-8 BOM if present
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const lines = raw.split(/\r?\n/);
    const crashes = parsePdCrashes(lines, filename);
    allCrashes.push(...crashes);
  }

  if (allCrashes.length === 0) {
    return "No crash records found. Make sure you are passing pd-*.txt log files.";
  }

  const shown = allCrashes.slice(0, limit);
  const out: string[] = [
    `Found ${allCrashes.length} crash(es) across ${paths.length} file(s) (showing ${shown.length}):`,
    "",
  ];

  for (const crash of shown) {
    out.push(`💥 CRASH  ${crash.processName || "(unknown)"}  PID(${crash.pid})`);
    out.push(`  Time:    ${crash.timestamp}`);
    out.push(`  File:    ${crash.file}`);
    if (crash.minidump) out.push(`  Minidump: ${crash.minidump}`);
    out.push(`  Threads: ${crash.threads.length}`);
    out.push("");

    const threadsToShow = crash.threads.slice(0, threadsPerCrash);
    for (const thread of threadsToShow) {
      out.push(`  Thread ${thread.threadId}:`);
      if (thread.registers) out.push(`    Registers: ${thread.registers.slice(0, 100)}`);
      const frames = thread.frames.slice(0, framesPerThread);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        out.push(`    [${i}] ${f.dll}  ${f.symbol}`);
      }
      if (thread.frames.length > framesPerThread) {
        out.push(`    ... (${thread.frames.length - framesPerThread} more frames)`);
      }
      out.push("");
    }
    if (crash.threads.length > threadsPerCrash) {
      out.push(`  ... (${crash.threads.length - threadsPerCrash} more threads)`);
      out.push("");
    }
  }

  // Process summary
  const byCrashProcess = new Map<string, number>();
  for (const c of allCrashes) {
    const key = c.processName || "(unknown)";
    byCrashProcess.set(key, (byCrashProcess.get(key) ?? 0) + 1);
  }
  if (byCrashProcess.size > 0) {
    out.push("--- Crash Summary by Process ---");
    for (const [proc, count] of [...byCrashProcess.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(count).padStart(3)}x  ${proc}`);
    }
  }

  return out.join("\n");
}
