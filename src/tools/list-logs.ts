import { listLogFiles, formatBytes } from "../lib/log-reader.js";
import { decodePrefix } from "../lib/prefix-map.js";

export async function toolListLogFiles(
  logDir: string | string[],
  args: {
    prefix?: string;
    date?: string;
    limit?: number;
    /** Labels for each dir when logDir is an array (bug-report mode) */
    serverLabels?: string[];
  }
): Promise<string> {
  const files = await listLogFiles(logDir, {
    prefix:       args.prefix,
    date:         args.date,
    limit:        args.limit ?? 200,
    serverLabels: args.serverLabels,
  });

  if (files.length === 0) {
    return "No log files found matching the given criteria.";
  }

  const dirs = Array.isArray(logDir) ? logDir : [logDir];
  const isBugReportMode = dirs.length > 1 || (args.serverLabels && args.serverLabels.length > 0);

  const lines: string[] = [];

  if (isBugReportMode) {
    // Group by server label for bug-report packages
    const byServer = new Map<string, typeof files>();
    for (const f of files) {
      const key = f.serverLabel ?? "(unknown server)";
      if (!byServer.has(key)) byServer.set(key, []);
      byServer.get(key)!.push(f);
    }
    lines.push(`Found ${files.length} log file(s) across ${byServer.size} server(s):`);
    for (const [label, serverFiles] of byServer) {
      lines.push("", `  ── ${label} (${serverFiles.length} files) ──`);
      for (const f of serverFiles) {
        const info = decodePrefix(f.prefix);
        lines.push(
          `    ${f.filename.padEnd(30)} ${formatBytes(f.sizeBytes).padStart(9)}  ${info.description}`
        );
      }
    }
  } else {
    lines.push(`Found ${files.length} log file(s) in ${dirs[0]}:`, "");
    for (const f of files) {
      const info = decodePrefix(f.prefix);
      lines.push(
        `  ${f.filename.padEnd(30)} ${formatBytes(f.sizeBytes).padStart(9)}  ${info.description}`
      );
    }
  }

  return lines.join("\n");
}
