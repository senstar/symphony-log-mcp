/**
 * fingerprint.ts
 *
 * Shared message fingerprinting / normalization for deduplication.
 * Used by search-errors.ts, service-lifecycle.ts, and anywhere else that
 * needs to group log messages that differ only in per-instance details.
 */

/**
 * Normalize a log message to a fingerprint for deduplication.
 * Strips GUIDs, memory addresses, request IDs, IP:ports, large numbers,
 * and exceptionGuid= values so structurally identical messages collapse.
 */
export function fingerprint(message: string): string {
  return message
    // GUIDs: 8-4-4-4-12 hex
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<GUID>")
    // exceptionGuid=<value> (may not be standard GUID format)
    .replace(/exceptionGuid=\S+/gi, "exceptionGuid=<GUID>")
    // IP:PORT pairs
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\b/g, "<IP:PORT>")
    // Bare IP addresses (without port)
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>")
    // Hex pointers / addresses
    .replace(/0x[0-9a-fA-F]+/g, "<PTR>")
    // Request(N) per-call IDs
    .replace(/Request\(\d+\)/g, "Request(N)")
    // Port numbers like :8398, :8640 when not already handled
    .replace(/:\d{4,5}\b/g, ":<PORT>")
    // Large numbers (5+ digits) — likely IDs, sizes, PIDs
    .replace(/\b\d{5,}\b/g, "<NUM>")
    // Array/list index notation [123]
    .replace(/\[\d+\]/g, "[N]")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fingerprint with truncation — for restart-cause messages and similar
 * where we want a shorter key for display.
 */
export function fingerprintShort(message: string, maxLength = 120): string {
  return fingerprint(message).slice(0, maxLength);
}
