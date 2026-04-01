import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { toolPermissions } from "../../src/tools/permissions.js";

// ── Mock data helpers ──────────────────────────────────────────────────────

const FARM_SECURITY_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN_SECURITY_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const OPERATOR_SECURITY_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const ADMINS_GROUP_ID = "cccccccc-0000-0000-0000-000000000001";
const OPERATORS_GROUP_ID = "cccccccc-0000-0000-0000-000000000002";
const RESTRICTED_GROUP_ID = "cccccccc-0000-0000-0000-000000000003";

/**
 * Build a minimal ASCII-bordered table dump file that the db-tables parser can read.
 * Each section has a heading line (used as tableName) followed by the bordered table.
 */
function buildTableDump(): string {
  return `
Users
+--------------+----------+-------+----------+-------------------+
| SecurityID   | LoginId  | Nm    | Disabled | ActiveDirectoryID |
+--------------+----------+-------+----------+-------------------+
| ${ADMIN_SECURITY_ID} | admin    | Admin | 0        |                   |
| ${OPERATOR_SECURITY_ID} | operator | Op    | 0        |                   |
+--------------+----------+-------+----------+-------------------+

UserGroup
+--------------+-------------+-------------------+-------------------+---------------------+
| SecurityID   | Name        | Description       | ActiveDirectoryID | ActiveDirectoryName |
+--------------+-------------+-------------------+-------------------+---------------------+
| ${ADMINS_GROUP_ID} | Admins      | Administrator grp |                   |                     |
| ${OPERATORS_GROUP_ID} | Operators   | Operator grp      |                   |                     |
| ${RESTRICTED_GROUP_ID} | Restricted  | Restricted grp    |                   |                     |
+--------------+-------------+-------------------+-------------------+---------------------+

UserToUserGroup
+--------------+--------------+
| UserID       | GroupID      |
+--------------+--------------+
| ${ADMIN_SECURITY_ID} | ${ADMINS_GROUP_ID} |
| ${OPERATOR_SECURITY_ID} | ${OPERATORS_GROUP_ID} |
| ${OPERATOR_SECURITY_ID} | ${RESTRICTED_GROUP_ID} |
+--------------+--------------+

UserGroupToUserGroup
+--------------+--------------+
| GroupID      | ParentGroupID|
+--------------+--------------+
+--------------+--------------+

SecurityProfile
+----+---------+-------------+
| ID | Name    | Description |
+----+---------+-------------+
| 1  | Default | Default     |
+----+---------+-------------+

SecurityRight
+------+-----------+-----------------+-------------+--------------+
| ID   | GroupName | Name            | Description | ResourceType |
+------+-----------+-----------------+-------------+--------------+
| 1000 | Misc      | Connect         | Connect     | Farm         |
| 2003 | Video     | ViewLiveVideo   | View live   | Device       |
| 1024 | Misc      | ExportVideo     | Export      | Farm         |
+------+-----------+-----------------+-------------+--------------+

ResourceRight
+----+--------------+-----------+---------+
| ID | ResourceID   | ProfileID | RightID |
+----+--------------+-----------+---------+
| 1  | ${FARM_SECURITY_ID} | 1         | 1000    |
| 2  | ${FARM_SECURITY_ID} | 1         | 2003    |
| 3  | ${FARM_SECURITY_ID} | 1         | 1024    |
+----+--------------+-----------+---------+

RightPermission
+---------------------------+--------------+------------+
| RightPermissionGroupID    | PrincipalID  | Permission |
+---------------------------+--------------+------------+
| 1                         | ${ADMINS_GROUP_ID} | 1          |
| 2                         | ${ADMINS_GROUP_ID} | 1          |
| 3                         | ${ADMINS_GROUP_ID} | 1          |
| 1                         | ${OPERATORS_GROUP_ID} | 1          |
| 2                         | ${OPERATORS_GROUP_ID} | 1          |
| 3                         | ${RESTRICTED_GROUP_ID} | 0          |
+---------------------------+--------------+------------+
`;
}

// ── Test setup ─────────────────────────────────────────────────────────────

let tmpDir: string;
let bugReport: { folderPath: string };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
  await fs.writeFile(path.join(tmpDir, "Tables-dump.txt"), buildTableDump(), "utf8");
  bugReport = { folderPath: tmpDir };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("toolPermissions — rights mode", () => {
  it("lists all known permission categories", async () => {
    const result = await toolPermissions(null, { mode: "rights" });
    expect(result).toContain("Rights Catalog");
    expect(result).toContain("[Farm]");
    expect(result).toContain("[Device]");
    expect(result).toContain("Connect");
    expect(result).toContain("ViewLiveVideo");
  });
});

describe("toolPermissions — resolve mode", () => {
  it("resolves effective permissions for admin user", async () => {
    const result = await toolPermissions(bugReport, { mode: "resolve", user: "admin" });
    expect(result).toContain("Admin");
    expect(result).toContain("Admins");
    expect(result).toContain("Allow");
  });

  it("requires user parameter", async () => {
    const result = await toolPermissions(bugReport, { mode: "resolve" });
    expect(result).toContain("'user' parameter is required");
  });

  it("reports unknown user", async () => {
    const result = await toolPermissions(bugReport, { mode: "resolve", user: "nonexistent" });
    expect(result).toContain("not found");
  });
});

describe("toolPermissions — groups mode", () => {
  it("lists groups with membership info", async () => {
    const result = await toolPermissions(bugReport, { mode: "groups" });
    expect(result).toContain("Admins");
    expect(result).toContain("Operators");
    expect(result).toContain("Restricted");
  });
});

describe("toolPermissions — check mode", () => {
  it("checks a specific permission for admin (allowed)", async () => {
    const result = await toolPermissions(bugReport, {
      mode: "check",
      user: "admin",
      permission: "Connect",
    });
    expect(result).toContain("Connect");
    // admin is in Admins group which has Allow on Connect
    expect(result).toContain("ALLOWED");
  });

  it("requires permission parameter", async () => {
    const result = await toolPermissions(bugReport, {
      mode: "check",
      user: "admin",
    });
    expect(result).toContain("'permission' parameter is required");
  });
});

describe("toolPermissions — deny-wins", () => {
  it("deny from Restricted overrides allow from Operators for ExportVideo", async () => {
    const result = await toolPermissions(bugReport, {
      mode: "check",
      user: "operator",
      permission: "ExportVideo",
    });
    // operator is in Operators (Allow on RR#3=ExportVideo) AND Restricted (Deny on RR#3=ExportVideo)
    // Deny must win
    expect(result).toContain("DENIED");
  });
});

describe("toolPermissions — raw mode", () => {
  it("shows raw table data found in the dump", async () => {
    const result = await toolPermissions(bugReport, { mode: "raw" });
    expect(result).toContain("Permission Tables");
    expect(result).toContain("Users");
    expect(result).toContain("UserGroup");
    expect(result).toContain("RightPermission");
  });
});

describe("toolPermissions — missing/empty tables", () => {
  it("handles no bug report gracefully", async () => {
    const result = await toolPermissions(null, { mode: "resolve", user: "admin" });
    expect(result).toContain("requires a bug report");
  });

  it("handles empty directory gracefully", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-empty-"));
    try {
      const result = await toolPermissions({ folderPath: emptyDir }, { mode: "resolve", user: "admin" });
      // Should say no table data found or no files
      expect(result).toMatch(/no.*found|no.*table/i);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
