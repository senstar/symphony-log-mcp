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

import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Log directory (or bug report folder) can be overridden by the LOG_DIR
 * environment variable or passed as the first command-line argument.
 */
const LOG_DIR_RAW: string = process.env.LOG_DIR ?? process.argv[2] ?? "C:\\Log";

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

async function getLogContext(): Promise<LogContext> {
  if (_logContext) return _logContext;

  if (await isBugReportFolder(LOG_DIR_RAW)) {
    const bugReport = await extractBugReport(LOG_DIR_RAW);
    const serverDirs = bugReport.servers.filter(s => !s.isClient && s.logDir);
    _logContext = {
      dirs:         serverDirs.map(s => s.logDir),
      serverLabels: serverDirs.map(s => s.label),
      bugReport,
    };
    console.error(
      `symphony-log-mcp: bug report mode — ${serverDirs.length} server(s) from ${LOG_DIR_RAW}`
    );
  } else {
    _logContext = { dirs: LOG_DIR_RAW, bugReport: null };
  }

  return _logContext;
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
    throw new Error(`Unknown resource: ${uri}`);
  });

  // ---- Tools ----
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;
    const ctx = await getLogContext();

    try {
      const result = await dispatchToolCall(name, a, ctx, LOG_DIR_RAW);
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
  console.error(`symphony-log-mcp running. Log directory: ${LOG_DIR_RAW}`);
}
