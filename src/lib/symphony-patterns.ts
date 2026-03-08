/**
 * symphony-patterns.ts
 *
 * Shared patterns for identifying Symphony-related processes and services.
 * Centralised here so that adding a new Symphony component only requires one update.
 *
 * Two pattern sets exist because they operate on different data:
 *
 *   PROCESS_PATTERNS — match the "Name" column from sccp .txt output (exe basenames:
 *     "Tracker(1)", "infoservice.exe", "ae.exe", etc.)
 *
 *   SERVICE_PATTERNS — match Windows service names + display names from services.txt
 *     ("Senstar Symphony InfoService", "TrackerService", etc.)
 */

// ── Process name patterns (for sccp/tasklist) ──────────────────────────────
// Source verified:
//   Tracker(NNNN) — special format from CpuCounter.cpp
//   infoservice.exe, scheduler.exe, ae.exe, seermanager.exe,
//   fusionengineservice.exe, hardwarecontainerservice*.exe,
//   mobilebridge.exe, onvifserver.exe, killall.exe, nssm.exe,
//   surrogateexe.exe, netsendhistmfc.exe
export const SYMPHONY_PROCESS_PATTERNS: RegExp[] = [
  /^Tracker\s*\(/i,
  /^infoservice/i,
  /^ae\.exe/i,
  /^seermanager/i,
  /^scheduler/i,
  /^fusionengineservice/i,
  /^hardwarecontainer/i,
  /^mobilebridge/i,
  /^onvifserver/i,
  /^killall/i,
  /^nssm/i,
  /^surrogateexe/i,
  /^netsendhistmfc/i,
  /^seer\.web/i,
];

/** Test whether a process name (from sccp or tasklist) belongs to Symphony. */
export function isSymphonyProcess(name: string): boolean {
  return SYMPHONY_PROCESS_PATTERNS.some(p => p.test(name));
}

// ── Windows service name patterns (for services.txt) ────────────────────────
export const SYMPHONY_SERVICE_PATTERNS: RegExp[] = [
  /senstar/i, /symphony/i, /aira/i, /tracker/i, /infoservice/i,
  /mobilebridge/i, /pdebug/i, /seer/i, /cleaner/i, /scheduler/i,
  /mediagateway/i, /videocd/i, /dataacc/i, /^ai/i, /rtsp/i,
];

/** Test whether a Windows service belongs to Symphony (matches name OR displayName). */
export function isSymphonyService(name: string, display: string): boolean {
  const combined = `${name} ${display}`;
  return SYMPHONY_SERVICE_PATTERNS.some(p => p.test(combined));
}
