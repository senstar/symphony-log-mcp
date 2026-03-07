/**
 * trace-mb-request.ts
 *
 * Traces a named RPC request as it flows from MobileBridge (Mo log) through
 * to InfoService (IS log).  The linkage is the IS sequence number, which both
 * logs share:
 *   Mo:  "Sent Request(Foo)[<guid>] with sequence #N"
 *   IS:  "Invoking request Request(N)[Foo] receieved from 127.0.0.1:<port>"
 *
 * Verified from source code:
 *   Mo sent:     MessageDispatcher.cs:1352 — _logger.Log(LogLevel, MethodName, "Sent {0} with sequence #{1}", exchange, message.SequenceNumber)
 *   Mo received: MessageDispatcher.cs:1227 — _logger.Log(LogLevel, MethodName, "Received response to {0} with sequence #{1}", exchange, sequenceNumber)
 *   IS invoke:   WebServiceRequestProcessor.cs:459 — "Invoking request {0} receieved from {1} with session ID {2}..."
 *   IS done:     WebServiceRequestProcessor.cs:473 — "Invocation of request {0} for {1} took {2}"
 *   IS handler:  AILog.cs Format() → "{FunctionalArea}\t{Class}.{Method}[{Instance}]\t{Message}"
 *
 * The "receieved" typo is confirmed in source code (WebServiceRequestProcessor.cs:459).
 * Sequence numbers are per-MessageDispatcher instance (per-endpoint), simple incrementing int.
 * Exchange.ToString() = "Request({MethodName}{ExtraDetails})[{GUID}]"
 * UserRequest.ToString() = "Request({SequenceNumber})[{MethodName}{ExtraDetails}]"
 * System auth uses SYSTEM_USERNAME = "___$System$___" (CSecurityManagerBase.cs:47).
 */

import * as path from "path";
import { resolveFileRefs, listLogFiles, isInTimeWindow, readRawLinesWithTimeFilter } from "../lib/log-reader.js";

// ──────────────────────────────────────────────────────────────────────────────
// Regex patterns
// ──────────────────────────────────────────────────────────────────────────────

// Mo log — sent side:
//   "Sent Request(GetDeviceGraphCompressed)[f95644eb-…] with sequence #17"
const RE_MO_SENT = /Sent Request\(([^)]+)\)\[([^\]]+)\] with sequence #(\d+)/;

// Mo log — response side:
//   "Received response to Request(GetDeviceGraphCompressed)[f95644eb-…] with sequence #17"
const RE_MO_RECV = /Received response to Request\(([^)]+)\)\[([^\]]+)\] with sequence #(\d+)/;

// IS log — invoke:
//   "Invoking request Request(17)[GetDeviceGraphCompressed] receieved from 127.0.0.1:6172"
const RE_IS_INVOKE = /Invoking request (?:unauthenticated )?Request\((\d+)\)\[([^\]]+)\] receieved from ([^\s]+)/;

// IS log — completion:
//   "Invocation of request Request(17)[GetDeviceGraphCompressed] for 127.0.0.1:6172 took 00:00:00.0322825"
const RE_IS_DONE =
  /Invocation of request (?:unauthenticated )?Request\((\d+)\)\[([^\]]+)\] for [^\s]+ took ([\d:]+\.[\d]+)/;

// IS log — handler invocation line (BasicInfo):
//   "Signals.GetDeviceGraphCompressed[127.0.0.1:6172]  Invoked by ___$System$___: GetDeviceGraphCompressed"
const RE_IS_HANDLER = /(\w[\w.]+)\[([^\]]+)\]\s+Invoked by ([^:]+):\s+(\S+)/;

// Timestamp at start of a log line
const RE_TIMESTAMP = /^(\d{2}:\d{2}:\d{2}\.\d{3})/;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface MoHop {
  requestName: string;
  guid: string;
  seq: number;
  sentAt: string;       // HH:MM:SS.mmm
  recvAt: string | null;
  roundTripMs: number | null;
  sourceFile: string;
}

interface IsHop {
  requestName: string;
  seq: number;
  invokedAt: string;
  completedAt: string | null;
  durationMs: number | null; // from IS timing string
  processingMs: number | null; // derived from timestamps
  invoker: string | null;
  handlerClass: string | null;
  sourcePort: string;
  sessionId: string | null;
  sourceFile: string;
}

interface RequestTrace {
  requestName: string;
  moHops: MoHop[];
  isHops: IsHop[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseTs(ts: string): number {
  const [h, m, s] = ts.split(":").map(Number);
  const [sec, ms] = (s.toString()).split(".");
  return h * 3_600_000 + m * 60_000 + Number(sec) * 1_000 + Number((s % 1).toFixed(3).slice(2));
}

function tsToMs(ts: string): number {
  const [hh, mm, ss] = ts.split(":");
  const [sec, frac] = ss.split(".");
  return (
    parseInt(hh) * 3_600_000 +
    parseInt(mm) * 60_000 +
    parseInt(sec) * 1_000 +
    parseInt((frac ?? "0").padEnd(3, "0").slice(0, 3))
  );
}

function durationStrToMs(dur: string): number {
  // "00:00:00.0322825" → ms
  const parts = dur.split(":");
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const sv = parts[2];
  const [s, frac] = sv.split(".");
  return h * 3_600_000 + m * 60_000 + parseInt(s) * 1_000 + Math.round(parseFloat("0." + (frac ?? "0")) * 1000);
}

// ──────────────────────────────────────────────────────────────────────────────
// Parse Mo log for all occurrences of a request
// ──────────────────────────────────────────────────────────────────────────────

async function parseMoHops(
  fullPath: string,
  requestName: string,
  startTime?: string,
  endTime?: string
): Promise<MoHop[]> {
  let lines: string[];
  try {
    lines = await readRawLinesWithTimeFilter(fullPath, startTime, endTime);
  } catch { return []; }

  const filename = path.basename(fullPath);

  // Map guid → MoHop (started but awaiting recv)
  const pending = new Map<string, MoHop>();
  const completed: MoHop[] = [];

  for (const line of lines) {
    const tsMatch = RE_TIMESTAMP.exec(line);
    if (!tsMatch) continue;
    const ts = tsMatch[1];
    if (startTime && endTime && !isInTimeWindow(ts, startTime, endTime)) continue;

    const sentMatch = RE_MO_SENT.exec(line);
    if (sentMatch) {
      const [, name, guid, seqStr] = sentMatch;
      if (requestName && name.toLowerCase() !== requestName.toLowerCase()) continue;
      pending.set(guid, {
        requestName: name,
        guid,
        seq: parseInt(seqStr),
        sentAt: ts,
        recvAt: null,
        roundTripMs: null,
        sourceFile: filename,
      });
      continue;
    }

    const recvMatch = RE_MO_RECV.exec(line);
    if (recvMatch) {
      const [, name, guid] = recvMatch;
      if (requestName && name.toLowerCase() !== requestName.toLowerCase()) continue;
      const hop = pending.get(guid);
      if (hop) {
        hop.recvAt = ts;
        hop.roundTripMs = tsToMs(ts) - tsToMs(hop.sentAt);
        completed.push(hop);
        pending.delete(guid);
      }
    }
  }

  // Any pending (no response yet) also included
  for (const hop of pending.values()) {
    completed.push(hop);
  }

  return completed;
}

// ──────────────────────────────────────────────────────────────────────────────
// Parse IS log for all occurrences of a request (matched by seq or name)
// ──────────────────────────────────────────────────────────────────────────────

async function parseIsHops(
  fullPath: string,
  requestName: string,
  seqNumbers: Set<number>,
  startTime?: string,
  endTime?: string
): Promise<IsHop[]> {
  let lines: string[];
  try {
    lines = await readRawLinesWithTimeFilter(fullPath, startTime, endTime);
  } catch { return []; }

  const filename = path.basename(fullPath);

  const pending = new Map<number, IsHop>(); // seq → IsHop
  const completed: IsHop[] = [];

  // Also collect handler lines (BasicInfo "Invoked by …")
  // keyed by sequence number from timestamp proximity
  // Strategy: after seeing invoke, look for the next matching handler line on same thread

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tsMatch = RE_TIMESTAMP.exec(line);
    if (!tsMatch) continue;
    const ts = tsMatch[1];
    if (startTime && endTime && !isInTimeWindow(ts, startTime, endTime)) continue;

    const invokeMatch = RE_IS_INVOKE.exec(line);
    if (invokeMatch) {
      const [, seqStr, name, src] = invokeMatch;
      const seq = parseInt(seqStr);
      if (requestName && name.toLowerCase() !== requestName.toLowerCase()) continue;
      if (seqNumbers.size > 0 && !seqNumbers.has(seq)) continue;

      // Extract session ID from line
      const sessionMatch = /session ID ([0-9a-f-]+)/i.exec(line);
      pending.set(seq, {
        requestName: name,
        seq,
        invokedAt: ts,
        completedAt: null,
        durationMs: null,
        processingMs: null,
        invoker: null,
        handlerClass: null,
        sourcePort: src,
        sessionId: sessionMatch ? sessionMatch[1] : null,
        sourceFile: filename,
      });
      continue;
    }

    const doneMatch = RE_IS_DONE.exec(line);
    if (doneMatch) {
      const [, seqStr, name, durStr] = doneMatch;
      const seq = parseInt(seqStr);
      if (requestName && name.toLowerCase() !== requestName.toLowerCase()) continue;
      const hop = pending.get(seq);
      if (hop) {
        hop.completedAt = ts;
        hop.durationMs = durationStrToMs(durStr);
        hop.processingMs = tsToMs(ts) - tsToMs(hop.invokedAt);
        completed.push(hop);
        pending.delete(seq);
      }
      continue;
    }

    // BasicInfo handler invocation line — attach to the most recent pending hop with same seq
    const handlerMatch = RE_IS_HANDLER.exec(line);
    if (handlerMatch) {
      const [, handlerClass, , invoker, methodName] = handlerMatch;
      if (requestName && methodName.toLowerCase() !== requestName.toLowerCase()) continue;
      // Find the most recently added pending hop matching this request name
      for (const [, hop] of pending) {
        if (hop.requestName.toLowerCase() === methodName.toLowerCase() && hop.invoker === null) {
          hop.invoker = invoker.trim();
          hop.handlerClass = handlerClass;
          break;
        }
      }
    }
  }

  // Include any still-pending
  for (const hop of pending.values()) {
    completed.push(hop);
  }

  return completed;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main tool
// ──────────────────────────────────────────────────────────────────────────────

export interface TraceMbArgs {
  requestName: string;
  moFiles?: string[];   // defaults to all Mo-* files for the date
  isFiles?: string[];   // defaults to all is-* files for the date
  startTime?: string;   // HH:MM:SS
  endTime?: string;
  limit?: number;       // max number of trace instances to show
}

export async function toolTraceMbRequest(
  logDir: string | string[],
  args: TraceMbArgs
): Promise<string> {
  const { requestName, startTime, endTime, limit = 5 } = args;

  // Resolve files: default Mo-* and is-*
  const moFiles  = args.moFiles?.length
    ? await resolveFileRefs(args.moFiles,  logDir)
    : (await listLogFiles(logDir)).filter(f => f.prefix === "mo").map(f => f.fullPath);

  const isFiles  = args.isFiles?.length
    ? await resolveFileRefs(args.isFiles,  logDir)
    : (await listLogFiles(logDir)).filter(f => f.prefix === "is").map(f => f.fullPath);

  if (moFiles.length === 0 && isFiles.length === 0) {
    return `No Mo or IS log files found in ${logDir}`;
  }

  // ── Step 1: collect Mo hops ────────────────────────────────────────────────
  const allMoHops: MoHop[] = [];
  for (const fp of moFiles) {
    const hops = await parseMoHops(fp, requestName, startTime, endTime);
    allMoHops.push(...hops);
  }

  // Limit early
  const moHops = allMoHops.slice(0, limit * 2); // ×2 because two sessions

  if (moHops.length === 0) {
    return `No MobileBridge "${requestName}" entries found in Mo log(s).\n` +
           `Mo files searched: ${moFiles.map(p => path.basename(p)).join(", ") || "none"}`;
  }

  // ── Step 2: collect IS hops (filtered to seq numbers we care about) ─────────
  // Widen the IS time window by ±30 s around the earliest/latest Mo hop to
  // avoid matching reused sequence numbers from different client connections.
  const seqSet = new Set(moHops.map(h => h.seq));
  const moTimes = moHops.map(h => tsToMs(h.sentAt));
  const minMoMs = Math.min(...moTimes);
  const maxMoMs = Math.max(...moTimes);
  const PAD_MS = 30_000;

  function msToHhMmSs(ms: number): string {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  const isStart = msToHhMmSs(Math.max(0, minMoMs - PAD_MS));
  const isEnd   = msToHhMmSs(maxMoMs + PAD_MS);

  const allIsHops: IsHop[] = [];
  for (const fp of isFiles) {
    const hops = await parseIsHops(fp, requestName, seqSet, isStart, isEnd);
    allIsHops.push(...hops);
  }

  // ── Step 3: pair Mo ↔ IS by sequence number ─────────────────────────────────
  const traces: RequestTrace[] = [];

  // Group Mo hops by seq
  const moBySeq = new Map<number, MoHop[]>();
  for (const h of moHops) {
    const arr = moBySeq.get(h.seq) ?? [];
    arr.push(h);
    moBySeq.set(h.seq, arr);
  }

  // Group IS hops by seq
  const isBySeq = new Map<number, IsHop[]>();
  for (const h of allIsHops) {
    const arr = isBySeq.get(h.seq) ?? [];
    arr.push(h);
    isBySeq.set(h.seq, arr);
  }

  // Build traces (one per unique seq, ordered by sentAt)
  const seqList = [...seqSet].sort((a, b) => {
    const moA = moBySeq.get(a)?.[0]?.sentAt ?? "";
    const moB = moBySeq.get(b)?.[0]?.sentAt ?? "";
    return moA.localeCompare(moB);
  });

  for (const seq of seqList.slice(0, limit * 2)) {
    const mo = moBySeq.get(seq) ?? [];
    const is = isBySeq.get(seq) ?? [];
    if (mo.length === 0 && is.length === 0) continue;
    traces.push({ requestName, moHops: mo, isHops: is });
  }

  if (traces.length === 0) {
    return `Collected ${moHops.length} Mo hops but could not build any traces.`;
  }

  // ── Step 4: render ──────────────────────────────────────────────────────────
  const out: string[] = [
    `Request trace: "${requestName}"`,
    `Mo files: ${moFiles.map(p => path.basename(p)).join(", ")}`,
    `IS files: ${isFiles.map(p => path.basename(p)).join(", ").slice(0, 120)}${isFiles.length > 5 ? "…" : ""}`,
    `Showing ${Math.min(traces.length, limit)} of ${traces.length} trace instance(s)`,
    "",
  ];

  let shown = 0;
  for (const trace of traces) {
    if (shown >= limit) break;

    // Skip duplicate sessions (same seq but different session) unless first
    const firstMo = trace.moHops[0];
    if (!firstMo) continue;

    out.push(`─── Instance @ ${firstMo.sentAt}  seq #${firstMo.seq} ───`);

    // Mo sent
    out.push(`  [${firstMo.sentAt}] Mo → IS  Sent Request(${trace.requestName})  guid=${firstMo.guid.slice(0, 8)}…  seq=#${firstMo.seq}`);

    // IS invoke + handler
    const isHop = trace.isHops[0];
    if (isHop) {
      const networkMs = tsToMs(isHop.invokedAt) - tsToMs(firstMo.sentAt);
      out.push(`  [${isHop.invokedAt}] IS recv  Request(${isHop.seq})[${isHop.requestName}] from ${isHop.sourcePort}  net_latency=+${networkMs}ms`);
      if (isHop.sessionId && isHop.sessionId !== "00000000-0000-0000-0000-000000000000") {
        out.push(`           session=${isHop.sessionId}`);
      }
      if (isHop.invoker) {
        out.push(`           invoker="${isHop.invoker}"  handler=${isHop.handlerClass ?? "(unknown)"}`);
      }

      if (isHop.completedAt) {
        out.push(`  [${isHop.completedAt}] IS done  duration=${isHop.durationMs}ms`);
      }
    } else {
      out.push(`  IS hop: not found in IS logs (request may be in a different IS file)`);
    }

    // Mo recv
    if (firstMo.recvAt) {
      out.push(`  [${firstMo.recvAt}] Mo recv  Response received  round_trip=${firstMo.roundTripMs}ms`);
    } else {
      out.push(`  Mo recv: (response not yet seen in log)`);
    }

    // Parallel sessions note
    if (trace.moHops.length > 1) {
      out.push(`  ⚑ MB has ${trace.moHops.length} parallel farm sessions — request issued on each`);
    }

    out.push("");
    shown++;
  }

  // Summary stats
  const allRts = traces
    .flatMap(t => t.moHops)
    .filter(h => h.roundTripMs !== null)
    .map(h => h.roundTripMs as number);

  if (allRts.length > 1) {
    const avg = Math.round(allRts.reduce((a, b) => a + b, 0) / allRts.length);
    const max = Math.max(...allRts);
    const min = Math.min(...allRts);
    out.push(`── Round-trip stats (${allRts.length} samples) ──`);
    out.push(`   min=${min}ms  avg=${avg}ms  max=${max}ms`);
  }

  return out.join("\n");
}
