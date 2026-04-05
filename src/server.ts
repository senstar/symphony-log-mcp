import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { isBugReportFolder, extractBugReport } from "./lib/bug-report.js";
import { DOMAIN_KNOWLEDGE } from "./lib/domain-knowledge.js";
import { TOOLS } from "./tool-registry.js";
import { dispatchToolCall } from "./tool-dispatch.js";
import type { LogContext } from "./types.js";
import { listKnownPrefixes } from "./lib/prefix-map.js";
import { triageCache } from "./lib/triage-cache.js";

import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Log directory (or bug report folder).
 *
 * Can be pre-set via LOG_DIR environment variable or the first CLI argument.
 * At runtime, use sym_open to point at a directory — this resets the cached
 * context so all subsequent tool calls use the new path.
 *
 * There is deliberately NO default.  Silently reading from C:\Log (which is
 * often a junction to a live production server) is a safety hazard.
 */
let _currentLogDir: string | null = process.env.LOG_DIR ?? process.argv[2] ?? null;

// ------------------------------------------------------------------ temp cleanup

/** Remove stale temp directories from previous sessions (older than 24 h). */
function cleanStaleTempDirs(): void {
  const tmpRoot = os.tmpdir();
  const maxAge = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // symphony-mcp/{hash} — from bug-report extraction
  const mcpDir = path.join(tmpRoot, "symphony-mcp");
  try {
    for (const entry of fs.readdirSync(mcpDir)) {
      const full = path.join(mcpDir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory() && now - stat.mtimeMs > maxAge) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
  } catch { /* directory may not exist */ }

  // symphony-log-{hash} — from compare-logs extraction
  try {
    for (const entry of fs.readdirSync(tmpRoot)) {
      if (!entry.startsWith("symphony-log-")) continue;
      const full = path.join(tmpRoot, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory() && now - stat.mtimeMs > maxAge) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ lazy log context

let _logContext: LogContext | null = null;

/**
 * Compute a fresh LogContext for a given directory.
 */
async function computeLogContext(dir: string): Promise<LogContext> {
  if (await isBugReportFolder(dir)) {
    const bugReport = await extractBugReport(dir);
    const serverDirs = bugReport.servers.filter(s => !s.isClient && s.logDir);
    return {
      dirs:         serverDirs.map(s => s.logDir),
      serverLabels: serverDirs.map(s => s.label),
      bugReport,
    };
  }
  // Auto-detect Log/ or Logs/ subdirectory (common in extracted log packages)
  const resolved = await resolveLogSubdir(dir);
  return { dirs: resolved, bugReport: null };
}

/**
 * If `dir` itself contains Symphony log files, return it as-is.
 * Otherwise check for a `Log/` or `Logs/` child (common layout in
 * extracted server log packages) and return that instead.
 */
async function resolveLogSubdir(dir: string): Promise<string> {
  // Quick check: does the directory itself contain any log-formatted files?
  try {
    const entries = fs.readdirSync(dir);
    const hasLogs = entries.some(e => /^[a-zA-Z]+-\d{6}_\d+\.txt$/i.test(e));
    if (hasLogs) return dir;
  } catch { /* ignore */ }

  // Try Log/ then Logs/ subdirectories
  for (const sub of ["Log", "Logs"]) {
    const candidate = path.join(dir, sub);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch { /* not found */ }
  }
  return dir;
}

/**
 * Return the active LogContext, computing it lazily on first use.
 *
 * @param overrideDir  If provided, compute a one-shot context for this
 *                     directory without touching the session-level cache.
 */
async function getLogContext(overrideDir?: string): Promise<LogContext> {
  // Per-call override — compute fresh, don't cache
  if (overrideDir) {
    return await computeLogContext(overrideDir);
  }

  // Session-level directory must be set
  if (!_currentLogDir) {
    throw new Error(
      "No log directory configured. Call sym_open with a directory path, " +
      "or set the LOG_DIR environment variable."
    );
  }

  if (_logContext) return _logContext;

  _logContext = await computeLogContext(_currentLogDir);
  return _logContext;
}

/**
 * Set (or change) the session-level log directory.  Clears the cached context
 * so the next tool call will re-initialize from the new path.
 */
export function setLogDir(newDir: string): void {
  _currentLogDir = newDir;
  _logContext = null;
  triageCache.clear();
}

/** Return the current session-level log directory (may be null). */
export function getCurrentLogDir(): string | null {
  return _currentLogDir;
}

// ------------------------------------------------------------------ server

export function createServer(): Server {
  const server = new Server(
    { name: "symphony-log-mcp", version },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ---- Resources: static domain knowledge ----
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "symphony://domain-knowledge",
        name: "Symphony VMS Domain Knowledge",
        description:
          "Log format specification, service architecture, dependency graph, " +
          "diagnostic playbooks, and known error signatures for Symphony VMS. " +
          "Read this first to understand how to use the analysis tools effectively.",
        mimeType: "text/markdown",
      },
      {
        uri: "symphony://log-prefixes",
        name: "Symphony Log File Prefixes",
        description:
          "Complete map of Symphony log file prefix codes to service names, " +
          "categories, and roles. Use to identify which service produced a log file.",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === "symphony://domain-knowledge") {
      return {
        contents: [
          { uri, text: DOMAIN_KNOWLEDGE, mimeType: "text/markdown" },
        ],
      };
    }
    if (uri === "symphony://log-prefixes") {
      return {
        contents: [
          { uri, text: JSON.stringify(listKnownPrefixes(), null, 2), mimeType: "application/json" },
        ],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // ---- Tools ----
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      // sym_open is handled directly — it doesn't require an existing LogContext
      if (name === "sym_open") {
        const dir = typeof a.logDir === "string" ? a.logDir.trim() : "";
        if (!dir) {
          if (_currentLogDir) {
            return {
              content: [{ type: "text", text: `Current log directory: ${_currentLogDir}` }],
            };
          }
          return {
            content: [{ type: "text", text: "Error: logDir parameter is required." }],
            isError: true,
          };
        }
        // Validate path exists
        try {
          const stat = fs.statSync(dir);
          if (!stat.isDirectory()) {
            return {
              content: [{ type: "text", text: `Error: '${dir}' is not a directory.` }],
              isError: true,
            };
          }
        } catch {
          return {
            content: [{ type: "text", text: `Error: '${dir}' does not exist or is not accessible.` }],
            isError: true,
          };
        }
        setLogDir(dir);
        // Eagerly initialize to report mode and file count
        const ctx = await getLogContext();
        const resolvedDir = Array.isArray(ctx.dirs) ? ctx.dirs[0] : ctx.dirs;
        const wasRedirected = resolvedDir !== dir;
        const fileCount = Array.isArray(ctx.dirs)
          ? ctx.dirs.length + " server directories"
          : "single directory";
        const mode = ctx.bugReport ? "bug report" : "log directory";
        return {
          content: [{
            type: "text",
            text: `Opened ${mode}: ${dir} (${fileCount}).` +
              (wasRedirected ? `\nAuto-detected log subdirectory: ${resolvedDir}` : "") +
              (ctx.bugReport
                ? `\nProduct: ${ctx.bugReport.productVersion}, Farm: ${ctx.bugReport.farmName}\nServers: ${ctx.bugReport.servers.filter(s => !s.isClient).map(s => s.label).join(", ")}`
                : "") +
              "\nAll sym_* tools will now use this directory.",
          }],
        };
      }

      // Per-call logDir override
      const overrideDir = typeof a.logDir === "string" && a.logDir.trim()
        ? a.logDir.trim()
        : undefined;

      const ctx = await getLogContext(overrideDir);
      const logDirDisplay = overrideDir ?? _currentLogDir ?? "(not set)";
      const result = await dispatchToolCall(name, a, ctx, logDirDisplay);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function main() {
  cleanStaleTempDirs();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `symphony-log-mcp v${version} running. ` +
    (_currentLogDir ? `Log directory: ${_currentLogDir}` : "No log directory set — use sym_open.")
  );
}
