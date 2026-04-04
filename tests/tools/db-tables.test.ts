import { describe, it, expect } from "vitest";
import {
  discoverTableFiles,
  parseAllTables,
  findColumn,
  tableMatchesDomain,
  type ParsedTable,
} from "../../src/tools/db-tables.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── Helpers ────────────────────────────────────────────────────────────────

async function createTempDir(
  files: Record<string, string>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-db-"));
  for (const [name, content] of Object.entries(files)) {
    const fullPath = path.join(dir, name);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ── Sample table data ──────────────────────────────────────────────────────

const ASCII_TABLE = `
Cameras
+-----+--------+--------+
| ID  | Name   | Status |
+-----+--------+--------+
| 1   | Cam1   | Active |
| 2   | Cam2   | Offline|
+-----+--------+--------+
`;

const SQL_OUTPUT_TABLE = `SELECT * FROM Servers
ServerID    ServerName    IPAddress
--------    ----------    ---------
5001        SERVER1       10.60.31.4
5002        SERVER2       10.60.31.5
`;

const TSV_TABLE = `UserID\tUserName\tRole\tEnabled
1\tadmin\tAdministrator\tTrue
2\toperator\tOperator\tTrue
3\tviewer\tViewer\tFalse
`;

const KEY_VALUE_CONFIG = `[LicenseSettings]
MaxCameras = 64
MaxServers = 4
Edition = Enterprise

[NetworkSettings]
Port = 8398
SSL = True
`;

// ── discoverTableFiles ─────────────────────────────────────────────────────

describe("discoverTableFiles", () => {
  it("discovers files with ASCII-bordered tables", async () => {
    const tmp = await createTempDir({ "db-dump.txt": ASCII_TABLE });
    try {
      const files = await discoverTableFiles(tmp.dir);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]).toContain("db-dump.txt");
    } finally {
      await tmp.cleanup();
    }
  });

  it("discovers files with SQL output tables", async () => {
    const tmp = await createTempDir({ "settings.txt": SQL_OUTPUT_TABLE });
    try {
      const files = await discoverTableFiles(tmp.dir);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await tmp.cleanup();
    }
  });

  it("discovers TSV files", async () => {
    const tmp = await createTempDir({ "config.tsv": TSV_TABLE });
    try {
      const files = await discoverTableFiles(tmp.dir);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await tmp.cleanup();
    }
  });

  it("returns empty for directory with no table files", async () => {
    const tmp = await createTempDir({ "readme.md": "# Hello" });
    try {
      const files = await discoverTableFiles(tmp.dir);
      expect(files).toHaveLength(0);
    } finally {
      await tmp.cleanup();
    }
  });

  it("returns empty for empty directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-db-empty-"));
    try {
      const files = await discoverTableFiles(dir);
      expect(files).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("searches one level of subdirectories", async () => {
    const tmp = await createTempDir({ "subdir/table.txt": ASCII_TABLE });
    try {
      const files = await discoverTableFiles(tmp.dir);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      await tmp.cleanup();
    }
  });
});

// ── parseAllTables ─────────────────────────────────────────────────────────

describe("parseAllTables — ASCII-bordered", () => {
  it("parses +---+---+ bordered tables", async () => {
    const tmp = await createTempDir({ "cameras.txt": ASCII_TABLE });
    try {
      const filePath = path.join(tmp.dir, "cameras.txt");
      const tables = await parseAllTables([filePath]);
      expect(tables.length).toBeGreaterThan(0);
      const t = tables[0];
      expect(t.columns).toContain("ID");
      expect(t.columns).toContain("Name");
      expect(t.rows.length).toBe(2);
      expect(t.rows[0]["Name"]).toBe("Cam1");
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("parseAllTables — SQL output", () => {
  it("parses SQL ---- separated output", async () => {
    const tmp = await createTempDir({ "servers.txt": SQL_OUTPUT_TABLE });
    try {
      const filePath = path.join(tmp.dir, "servers.txt");
      const tables = await parseAllTables([filePath]);
      expect(tables.length).toBeGreaterThan(0);
      const t = tables.find(tbl => tbl.columns.includes("ServerID"));
      expect(t).toBeDefined();
      expect(t!.rows.length).toBe(2);
      expect(t!.rows[0]["ServerName"]).toBe("SERVER1");
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("parseAllTables — TSV", () => {
  it("parses tab-separated tables", async () => {
    const tmp = await createTempDir({ "users.tsv": TSV_TABLE });
    try {
      const filePath = path.join(tmp.dir, "users.tsv");
      const tables = await parseAllTables([filePath]);
      expect(tables.length).toBeGreaterThan(0);
      const t = tables.find(tbl => tbl.columns.includes("UserName"));
      expect(t).toBeDefined();
      expect(t!.rows.length).toBe(3);
      expect(t!.rows[0]["UserName"]).toBe("admin");
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("parseAllTables — key-value", () => {
  it("parses [Section] key=value blocks", async () => {
    const tmp = await createTempDir({ "config.txt": KEY_VALUE_CONFIG });
    try {
      const filePath = path.join(tmp.dir, "config.txt");
      const tables = await parseAllTables([filePath]);
      const licenseTable = tables.find(t => t.tableName === "LicenseSettings");
      expect(licenseTable).toBeDefined();
      expect(licenseTable!.rows.length).toBeGreaterThan(0);
      expect(licenseTable!.rows[0]["MaxCameras"]).toBe("64");
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("parseAllTables — edge cases", () => {
  it("returns empty for no files", async () => {
    const tables = await parseAllTables([]);
    expect(tables).toHaveLength(0);
  });

  it("handles malformed tables gracefully", async () => {
    const malformed = `
+---+
| just a header with no data rows
+---+
Some random text that isn't a table
`;
    const tmp = await createTempDir({ "bad.txt": malformed });
    try {
      const filePath = path.join(tmp.dir, "bad.txt");
      const tables = await parseAllTables([filePath]);
      // Should not crash; may return 0 or some partial tables
      expect(Array.isArray(tables)).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  });

  it("handles empty file", async () => {
    const tmp = await createTempDir({ "empty.txt": "" });
    try {
      const filePath = path.join(tmp.dir, "empty.txt");
      const tables = await parseAllTables([filePath]);
      expect(tables).toHaveLength(0);
    } finally {
      await tmp.cleanup();
    }
  });
});

// ── findColumn ─────────────────────────────────────────────────────────────

describe("findColumn", () => {
  it("finds column by keyword (case-insensitive)", () => {
    expect(findColumn(["ServerID", "ServerName", "IPAddress"], "name")).toBe("ServerName");
  });

  it("returns null when no match", () => {
    expect(findColumn(["ID", "Name"], "email")).toBeNull();
  });
});

// ── tableMatchesDomain ─────────────────────────────────────────────────────

describe("tableMatchesDomain", () => {
  const table: ParsedTable = {
    sourceFile: "dump.txt",
    tableName: "CameraConfig",
    columns: ["CameraID", "Name", "Status"],
    rows: [],
  };

  it("matches by table name", () => {
    expect(tableMatchesDomain(table, ["camera"])).toBe(true);
  });

  it("matches by column name", () => {
    expect(tableMatchesDomain(table, ["status"])).toBe(true);
  });

  it("returns false when no match", () => {
    expect(tableMatchesDomain(table, ["license", "user"])).toBe(false);
  });
});
