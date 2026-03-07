/**
 * db-tables.ts
 *
 * Parse database table dumps from Symphony bug report packages.
 *
 * Bug reports may include SQL table dumps in various formats:
 *   - ASCII-bordered tables (+---------+--------+)
 *   - Tab-separated values (TSV) with header row
 *   - "Key: Value" blocks from config dumps
 *   - SQL SELECT output with column headers and dashes
 *
 * This tool discovers and parses these into structured data,
 * then presents summaries for different modes (cameras, servers,
 * settings, users, licenses).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BugReport } from "../lib/bug-report.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedTable {
  /** Source file this table came from */
  sourceFile: string;
  /** Table name (from CREATE TABLE, heading, or filename) */
  tableName: string;
  /** Column headers */
  columns: string[];
  /** Row data — each row is a map of column→value */
  rows: Record<string, string>[];
}

export interface DbTablesArgs {
  mode: "cameras" | "servers" | "settings" | "users" | "licenses" | "raw" | "summary";
  /** Specific table name to filter (for raw mode) */
  tableName?: string;
  /** Max rows to return */
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table discovery — find files that contain table data
// ─────────────────────────────────────────────────────────────────────────────

/** Patterns that indicate a file contains table/DB dump data */
const TABLE_INDICATORS = [
  /^\+[-+]+\+$/m,                          // ASCII box: +-------+-------+
  /^[-]{3,}\s+[-]{3,}/m,                   // SQL output:  ---- ----
  /\bCREATE TABLE\b/i,                     // DDL
  /\bSELECT\s+.+\s+FROM\b/i,             // SQL query
  /\bINSERT INTO\b/i,                      // Insert statements
];

/** File patterns to scan for table data in bug report folders */
const DB_FILE_PATTERNS = [
  /\.txt$/i,
  /\.csv$/i,
  /\.tsv$/i,
  /\.sql$/i,
  /\.log$/i,
  /db.*dump/i,
  /table/i,
  /config/i,
  /settings/i,
];

/**
 * Scan a bug report folder for files likely containing database tables.
 * Checks the root folder and one level of subdirectories.
 */
export async function discoverTableFiles(folderPath: string): Promise<string[]> {
  const candidates: string[] = [];

  // Check root-level files (bugreport.txt, serverinfo.txt, etc.)
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && DB_FILE_PATTERNS.some(p => p.test(entry.name))) {
        candidates.push(path.join(folderPath, entry.name));
      }
      // Also check one level of subdirectories (extracted server zips may have config files)
      if (entry.isDirectory()) {
        try {
          const subEntries = await fs.readdir(path.join(folderPath, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && DB_FILE_PATTERNS.some(p => p.test(sub.name))) {
              candidates.push(path.join(folderPath, entry.name, sub.name));
            }
          }
        } catch { /* skip unreadable dirs */ }
      }
    }
  } catch { /* skip */ }

  // Filter: read first 4KB of each and check for table indicators
  const results: string[] = [];
  for (const file of candidates) {
    try {
      const fd = await fs.open(file, "r");
      const buf = Buffer.alloc(4096);
      await fd.read(buf, 0, 4096, 0);
      await fd.close();
      const preview = buf.toString("utf8");
      if (TABLE_INDICATORS.some(p => p.test(preview)) || /\t/.test(preview.split("\n")[0] ?? "")) {
        results.push(file);
      }
    } catch { /* skip unreadable */ }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse ASCII-bordered tables:
 * +-----+-------+--------+
 * | ID  | Name  | Status |
 * +-----+-------+--------+
 * | 1   | Cam1  | Active |
 * +-----+-------+--------+
 */
function parseAsciiBorderedTables(text: string, sourceFile: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const borderRe = /^\+[-+]+\+$/;

  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    // Find table start (border line)
    if (!borderRe.test(lines[i].trim())) { i++; continue; }

    const startLine = i;
    // Next line should be header
    i++;
    if (i >= lines.length || !lines[i].includes("|")) { continue; }

    const headerLine = lines[i].trim();
    const columns = headerLine.split("|").filter(c => c.trim()).map(c => c.trim());
    i++;

    // Skip separator border
    if (i < lines.length && borderRe.test(lines[i].trim())) i++;

    // Read data rows until next border or end
    const rows: Record<string, string>[] = [];
    while (i < lines.length) {
      const line = lines[i].trim();
      if (borderRe.test(line)) { i++; break; }
      if (!line.includes("|")) { i++; break; }

      const values = line.split("|").filter(c => c.trim() !== "" || c.length > 0);
      // Filter empties from leading/trailing pipes
      const cleaned = line.split("|").slice(1, -1).map(c => c.trim());
      if (cleaned.length >= columns.length) {
        const row: Record<string, string> = {};
        for (let c = 0; c < columns.length; c++) {
          row[columns[c]] = cleaned[c] ?? "";
        }
        rows.push(row);
      }
      i++;
    }

    if (rows.length > 0) {
      // Try to find a table name from a comment/heading before the border
      let tableName = "Table";
      for (let j = startLine - 1; j >= Math.max(0, startLine - 3); j--) {
        const prev = lines[j].trim();
        if (prev && !borderRe.test(prev) && !prev.startsWith("--")) {
          tableName = prev.replace(/^[-#=\s]+/, "").replace(/[-#=\s]+$/, "").trim() || tableName;
          break;
        }
      }
      tables.push({ sourceFile, tableName, columns, rows });
    }
  }

  return tables;
}

/**
 * Parse SQL-style output:
 * Column1    Column2    Column3
 * --------   --------   --------
 * value1     value2     value3
 */
function parseSqlOutputTables(text: string, sourceFile: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i++) {
    // Look for a line of dashes/spaces that acts as separator
    const nextLine = lines[i + 1];
    if (!/^[-\s]{6,}$/.test(nextLine) || !/\s{2,}/.test(nextLine)) continue;

    // Previous line should be column headers
    const headerLine = lines[i];
    // Split on 2+ spaces
    const columns = headerLine.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
    if (columns.length < 2) continue;

    // Parse separator to find column positions
    const dashGroups: { start: number; end: number }[] = [];
    const dashRe = /(-+)/g;
    let dm;
    while ((dm = dashRe.exec(nextLine)) !== null) {
      dashGroups.push({ start: dm.index, end: dm.index + dm[0].length });
    }

    // Read data rows
    const rows: Record<string, string>[] = [];
    let j = i + 2;
    while (j < lines.length) {
      const line = lines[j];
      if (!line || !line.trim() || /^[-\s]*$/.test(line)) break;
      if (/^\+[-+]+\+$/.test(line.trim())) break;

      const row: Record<string, string> = {};
      for (let c = 0; c < Math.min(columns.length, dashGroups.length); c++) {
        const { start, end } = dashGroups[c];
        // For last column, take rest of line
        const val = c === dashGroups.length - 1
          ? (line.slice(start) ?? "").trim()
          : (line.slice(start, end) ?? "").trim();
        row[columns[c]] = val;
      }
      rows.push(row);
      j++;
    }

    if (rows.length > 0) {
      let tableName = "Query Result";
      // Check for a SELECT ... FROM tablename before the header
      for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
        const fromMatch = /FROM\s+\[?(\w+)\]?/i.exec(lines[k]);
        if (fromMatch) { tableName = fromMatch[1]; break; }
        if (lines[k].trim() && !lines[k].trim().startsWith("--")) {
          tableName = lines[k].trim().replace(/^[-#=\s]+/, "").replace(/[-#=\s]+$/, "") || tableName;
          break;
        }
      }
      tables.push({ sourceFile, tableName, columns, rows });
    }
  }

  return tables;
}

/**
 * Parse TSV (tab-separated values) tables.
 * First line with tabs is the header, subsequent tab-containing lines are data.
 */
function parseTsvTables(text: string, sourceFile: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const lines = text.split(/\r?\n/);

  let inTable = false;
  let columns: string[] = [];
  let rows: Record<string, string>[] = [];
  let tableName = path.basename(sourceFile, path.extname(sourceFile));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inTable) {
      if (line.includes("\t") && line.split("\t").length >= 3) {
        // Looks like a header line
        columns = line.split("\t").map(c => c.trim());
        rows = [];
        inTable = true;

        // Check line above for table name
        if (i > 0 && lines[i - 1].trim() && !lines[i - 1].includes("\t")) {
          tableName = lines[i - 1].trim();
        }
      }
    } else {
      if (!line.includes("\t") || !line.trim()) {
        // End of table
        if (rows.length > 0) {
          tables.push({ sourceFile, tableName, columns, rows });
        }
        inTable = false;
        rows = [];
        columns = [];
        continue;
      }

      const values = line.split("\t").map(c => c.trim());
      const row: Record<string, string> = {};
      for (let c = 0; c < columns.length; c++) {
        row[columns[c]] = values[c] ?? "";
      }
      rows.push(row);
    }
  }

  // Flush last table
  if (inTable && rows.length > 0) {
    tables.push({ sourceFile, tableName, columns, rows });
  }

  return tables;
}

/**
 * Parse key-value config blocks:
 * [SectionName]
 * Key1 = Value1
 * Key2 = Value2
 */
function parseKeyValueBlocks(text: string, sourceFile: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const sectionRe = /^\[([^\]]+)\]/;
  const kvRe = /^([^=\n]+?)\s*=\s*(.*)$/;

  const lines = text.split(/\r?\n/);
  let currentSection = "";
  let rows: Record<string, string>[] = [];
  let currentRow: Record<string, string> = {};
  let hasKv = false;

  for (const line of lines) {
    const sm = sectionRe.exec(line.trim());
    if (sm) {
      if (hasKv && Object.keys(currentRow).length > 0) {
        rows.push(currentRow);
      }
      if (rows.length > 0) {
        const allKeys = new Set<string>();
        rows.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
        tables.push({
          sourceFile,
          tableName: currentSection || "Config",
          columns: [...allKeys],
          rows,
        });
      }
      currentSection = sm[1];
      rows = [];
      currentRow = {};
      hasKv = false;
      continue;
    }

    const kvm = kvRe.exec(line.trim());
    if (kvm) {
      currentRow[kvm[1].trim()] = kvm[2].trim();
      hasKv = true;
    }
  }

  // Flush last section
  if (hasKv && Object.keys(currentRow).length > 0) {
    rows.push(currentRow);
  }
  if (rows.length > 0) {
    const allKeys = new Set<string>();
    rows.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
    tables.push({
      sourceFile,
      tableName: currentSection || "Config",
      columns: [...allKeys],
      rows,
    });
  }

  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser — try all formats
// ─────────────────────────────────────────────────────────────────────────────

export async function parseAllTables(filePaths: string[]): Promise<ParsedTable[]> {
  const allTables: ParsedTable[] = [];

  for (const filePath of filePaths) {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch { continue; }

    const source = path.basename(filePath);

    // Try each parser — they're designed to coexist (different formats)
    allTables.push(...parseAsciiBorderedTables(text, source));
    allTables.push(...parseSqlOutputTables(text, source));
    allTables.push(...parseTsvTables(text, source));
    allTables.push(...parseKeyValueBlocks(text, source));
  }

  // Deduplicate — same tableName + same column set = merge
  const merged = new Map<string, ParsedTable>();
  for (const t of allTables) {
    const key = `${t.tableName}::${t.columns.sort().join(",")}`;
    const existing = merged.get(key);
    if (existing) {
      existing.rows.push(...t.rows);
    } else {
      merged.set(key, { ...t });
    }
  }

  return [...merged.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Column name matching helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Case-insensitive search for a column matching any of the given keywords */
export function findColumn(columns: string[], ...keywords: string[]): string | null {
  for (const col of columns) {
    const lower = col.toLowerCase();
    if (keywords.some(k => lower.includes(k.toLowerCase()))) return col;
  }
  return null;
}

/** Check if a table likely contains data about a specific domain */
export function tableMatchesDomain(table: ParsedTable, keywords: string[]): boolean {
  const nameMatch = keywords.some(k => table.tableName.toLowerCase().includes(k));
  const colMatch = keywords.some(k => table.columns.some(c => c.toLowerCase().includes(k)));
  return nameMatch || colMatch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode handlers
// ─────────────────────────────────────────────────────────────────────────────

function formatCameras(tables: ParsedTable[], limit: number): string {
  const cameraTables = tables.filter(t =>
    tableMatchesDomain(t, ["camera", "device", "tracker", "cam", "channel", "video"])
  );

  if (cameraTables.length === 0) return "No camera/device tables found in bug report.";

  const out: string[] = ["Camera Configuration", "═".repeat(50), ""];

  for (const table of cameraTables) {
    out.push(`Table: ${table.tableName} (${table.rows.length} rows, from ${table.sourceFile})`);

    const idCol = findColumn(table.columns, "id", "cameraid", "deviceid", "number");
    const nameCol = findColumn(table.columns, "name", "description", "label", "title");
    const serverCol = findColumn(table.columns, "server", "host", "machine", "ip");
    const resCol = findColumn(table.columns, "resolution", "width", "height", "quality");
    const fpsCol = findColumn(table.columns, "fps", "framerate", "frame");
    const statusCol = findColumn(table.columns, "status", "enabled", "active", "state");
    const codecCol = findColumn(table.columns, "codec", "encoding", "format");

    const shown = table.rows.slice(0, limit);
    for (const row of shown) {
      const parts: string[] = [];
      if (idCol) parts.push(`#${row[idCol]}`);
      if (nameCol) parts.push(row[nameCol]);
      if (serverCol) parts.push(`@ ${row[serverCol]}`);
      if (resCol) parts.push(row[resCol]);
      if (fpsCol) parts.push(`${row[fpsCol]} fps`);
      if (codecCol) parts.push(row[codecCol]);
      if (statusCol) parts.push(`[${row[statusCol]}]`);
      out.push(`  ${parts.join("  |  ")}`);
    }
    if (table.rows.length > limit) {
      out.push(`  ... and ${table.rows.length - limit} more`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatServers(tables: ParsedTable[], limit: number): string {
  const serverTables = tables.filter(t =>
    tableMatchesDomain(t, ["server", "machine", "farm", "node", "host", "computer"])
  );

  if (serverTables.length === 0) return "No server/farm tables found in bug report.";

  const out: string[] = ["Server Configuration", "═".repeat(50), ""];

  for (const table of serverTables) {
    out.push(`Table: ${table.tableName} (${table.rows.length} rows, from ${table.sourceFile})`);

    const nameCol = findColumn(table.columns, "name", "hostname", "machine", "computer");
    const ipCol = findColumn(table.columns, "ip", "address");
    const roleCol = findColumn(table.columns, "role", "type", "master", "function");
    const statusCol = findColumn(table.columns, "status", "state", "online");

    const shown = table.rows.slice(0, limit);
    for (const row of shown) {
      const parts: string[] = [];
      if (nameCol) parts.push(row[nameCol]);
      if (ipCol) parts.push(row[ipCol]);
      if (roleCol) parts.push(`(${row[roleCol]})`);
      if (statusCol) parts.push(`[${row[statusCol]}]`);

      if (parts.length === 0) {
        // Fall back to showing all columns
        parts.push(table.columns.map(c => `${c}: ${row[c]}`).join(", "));
      }
      out.push(`  ${parts.join("  |  ")}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatSettings(tables: ParsedTable[], limit: number): string {
  const settingTables = tables.filter(t =>
    tableMatchesDomain(t, ["setting", "config", "option", "preference", "parameter", "feature", "flag"])
  );

  if (settingTables.length === 0) return "No settings/configuration tables found in bug report.";

  const out: string[] = ["System Settings", "═".repeat(50), ""];

  for (const table of settingTables) {
    out.push(`Table: ${table.tableName} (${table.rows.length} entries, from ${table.sourceFile})`);

    const keyCol = findColumn(table.columns, "key", "name", "setting", "parameter", "property");
    const valCol = findColumn(table.columns, "value", "data", "setting");

    const shown = table.rows.slice(0, limit);
    for (const row of shown) {
      if (keyCol && valCol && keyCol !== valCol) {
        out.push(`  ${row[keyCol]} = ${row[valCol]}`);
      } else {
        out.push(`  ${table.columns.map(c => `${c}: ${row[c]}`).join("  |  ")}`);
      }
    }
    if (table.rows.length > limit) {
      out.push(`  ... and ${table.rows.length - limit} more`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatUsers(tables: ParsedTable[], limit: number): string {
  const userTables = tables.filter(t =>
    tableMatchesDomain(t, ["user", "account", "login", "operator", "principal", "auth"])
  );

  if (userTables.length === 0) return "No user/account tables found in bug report.";

  const out: string[] = ["User Accounts", "═".repeat(50), ""];

  for (const table of userTables) {
    out.push(`Table: ${table.tableName} (${table.rows.length} rows, from ${table.sourceFile})`);

    const nameCol = findColumn(table.columns, "name", "username", "login", "account", "user");
    const roleCol = findColumn(table.columns, "role", "group", "level", "permission", "privilege");
    const authCol = findColumn(table.columns, "auth", "type", "method", "provider", "domain");
    const statusCol = findColumn(table.columns, "status", "active", "enabled", "locked");

    const shown = table.rows.slice(0, limit);
    for (const row of shown) {
      const parts: string[] = [];
      if (nameCol) parts.push(row[nameCol]);
      if (roleCol) parts.push(`role: ${row[roleCol]}`);
      if (authCol) parts.push(`auth: ${row[authCol]}`);
      if (statusCol) parts.push(`[${row[statusCol]}]`);
      if (parts.length === 0) parts.push(table.columns.map(c => `${c}: ${row[c]}`).join(", "));
      out.push(`  ${parts.join("  |  ")}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatLicenses(tables: ParsedTable[], limit: number): string {
  const licenseTables = tables.filter(t =>
    tableMatchesDomain(t, ["license", "licence", "entitlement", "feature", "module"])
  );

  if (licenseTables.length === 0) return "No license tables found in bug report.";

  const out: string[] = ["Licenses", "═".repeat(50), ""];

  for (const table of licenseTables) {
    out.push(`Table: ${table.tableName} (${table.rows.length} rows, from ${table.sourceFile})`);

    const shown = table.rows.slice(0, limit);
    for (const row of shown) {
      out.push(`  ${table.columns.map(c => `${c}: ${row[c]}`).join("  |  ")}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatRaw(tables: ParsedTable[], tableName: string | undefined, limit: number): string {
  let filtered = tables;
  if (tableName) {
    filtered = tables.filter(t => t.tableName.toLowerCase().includes(tableName.toLowerCase()));
  }

  if (filtered.length === 0) {
    return tableName
      ? `No tables matching '${tableName}' found.`
      : "No tables found in bug report.";
  }

  const out: string[] = [`Found ${filtered.length} table(s)`, ""];

  for (const table of filtered) {
    out.push(`═══ ${table.tableName} ═══  (${table.rows.length} rows, from ${table.sourceFile})`);
    out.push(`Columns: ${table.columns.join(", ")}`);
    out.push("");

    const shown = table.rows.slice(0, limit);
    // Format as aligned columns
    const colWidths = new Map<string, number>();
    for (const col of table.columns) {
      colWidths.set(col, Math.max(col.length, ...shown.map(r => (r[col] ?? "").length).slice(0, 20)));
    }
    // Header
    out.push(table.columns.map(c => c.padEnd(Math.min(colWidths.get(c)! + 2, 30))).join(""));
    out.push(table.columns.map(c => "-".repeat(Math.min(colWidths.get(c)!, 28)) + "  ").join(""));
    // Rows
    for (const row of shown) {
      out.push(table.columns.map(c => (row[c] ?? "").padEnd(Math.min(colWidths.get(c)! + 2, 30))).join(""));
    }
    if (table.rows.length > limit) {
      out.push(`... and ${table.rows.length - limit} more rows`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatSummary(tables: ParsedTable[]): string {
  if (tables.length === 0) return "No database tables found in bug report.";

  const cameraTables = tables.filter(t => tableMatchesDomain(t, ["camera", "device", "tracker", "cam", "channel"]));
  const serverTables = tables.filter(t => tableMatchesDomain(t, ["server", "machine", "farm", "node", "host"]));
  const settingTables = tables.filter(t => tableMatchesDomain(t, ["setting", "config", "option", "preference"]));
  const userTables = tables.filter(t => tableMatchesDomain(t, ["user", "account", "login", "operator"]));
  const licenseTables = tables.filter(t => tableMatchesDomain(t, ["license", "licence", "entitlement"]));

  const cameraCount = cameraTables.reduce((s, t) => s + t.rows.length, 0);
  const serverCount = serverTables.reduce((s, t) => s + t.rows.length, 0);
  const settingCount = settingTables.reduce((s, t) => s + t.rows.length, 0);
  const userCount = userTables.reduce((s, t) => s + t.rows.length, 0);

  const out: string[] = [
    "Database Tables Summary",
    "═".repeat(50),
    "",
    `Found ${tables.length} table(s) across bug report files:`,
    "",
  ];

  if (cameraCount > 0) out.push(`  📷 Cameras/Devices: ${cameraCount} entries in ${cameraTables.length} table(s)`);
  if (serverCount > 0) out.push(`  🖥  Servers:         ${serverCount} entries in ${serverTables.length} table(s)`);
  if (settingCount > 0) out.push(`  ⚙  Settings:        ${settingCount} entries in ${settingTables.length} table(s)`);
  if (userCount > 0) out.push(`  👤 Users:           ${userCount} entries in ${userTables.length} table(s)`);
  if (licenseTables.length > 0) out.push(`  🔑 Licenses:        ${licenseTables.reduce((s, t) => s + t.rows.length, 0)} entries`);

  // List uncategorized tables
  const categorized = new Set([...cameraTables, ...serverTables, ...settingTables, ...userTables, ...licenseTables]);
  const other = tables.filter(t => !categorized.has(t));
  if (other.length > 0) {
    out.push(`  📋 Other tables:    ${other.length}`);
    for (const t of other.slice(0, 10)) {
      out.push(`     - ${t.tableName} (${t.rows.length} rows, ${t.columns.length} cols) from ${t.sourceFile}`);
    }
  }

  out.push("");
  out.push("Use mode 'cameras', 'servers', 'settings', 'users', 'licenses', or 'raw' for details.");

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function toolDbTables(
  bugReport: { folderPath: string } | null,
  args: DbTablesArgs,
): Promise<string> {
  if (!bugReport) {
    return "sym_db_tables requires a bug report package. Point LOG_DIR at a bug report folder.";
  }

  const limit = args.limit ?? 100;

  // Discover and parse all table data
  const tableFiles = await discoverTableFiles(bugReport.folderPath);
  if (tableFiles.length === 0) {
    return "No files containing database table data found in the bug report.";
  }

  const tables = await parseAllTables(tableFiles);
  if (tables.length === 0) {
    return `Scanned ${tableFiles.length} file(s) but found no parseable table data.`;
  }

  switch (args.mode) {
    case "cameras":  return formatCameras(tables, limit);
    case "servers":  return formatServers(tables, limit);
    case "settings": return formatSettings(tables, limit);
    case "users":    return formatUsers(tables, limit);
    case "licenses": return formatLicenses(tables, limit);
    case "raw":      return formatRaw(tables, args.tableName, limit);
    case "summary":  return formatSummary(tables);
    default:
      return `Unknown mode: ${args.mode}. Use: cameras, servers, settings, users, licenses, raw, summary.`;
  }
}
