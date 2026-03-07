/**
 * permissions.ts
 *
 * Resolve effective user permissions from Symphony VMS database dumps
 * found in bug report packages.
 *
 * ── Data Model (from Schema.sql) ──────────────────────────────────────────
 *
 * SecurityObject   — universal identity GUID; every user, group, device,
 *                    farm, video wall gets one.
 * Users            — LoginId, Nm, SecurityID (FK→SecurityObject), Disabled,
 *                    ActiveDirectoryID
 * UserGroup        — Name, SecurityID (FK→SecurityObject), Description,
 *                    ActiveDirectoryID/Name, ShowHierarchy, VideoPlaybackMinutes
 * UserToUserGroup  — (UserID, GroupID) composite — user ↔ group membership,
 *                    both FK→SecurityObject
 * UserGroupToUserGroup — (GroupID, ParentGroupID) composite — group nesting
 * SecurityProfile  — ID (int), Name, Description — named permission config
 * SecurityRight    — ID (int), GroupName, Name, Description, ResourceType,
 *                    ControlledByAEM
 * ResourceRight    — ID (int), ResourceID (FK→SecurityObject), ProfileID
 *                    (FK→SecurityProfile), RightID (FK→SecurityRight)
 * RightPermission  — RightPermissionGroupID (FK→ResourceRight), PrincipalID
 *                    (FK→SecurityObject), Permission (BIT NULL:
 *                    0=Deny, 1=Allow, NULL=Unspecified)
 *
 * ── Resolution Algorithm (from ClaimSet.cs) ───────────────────────────────
 *
 *  1. Collect explicit claims for the user + ALL ancestor groups
 *     (UserToUserGroup + recursive UserGroupToUserGroup).
 *  2. For a given resource:
 *     a. Check explicit claims on that resource.
 *        If ANY claim is Deny → immediately Deny (short-circuit).
 *     b. Walk up the resource hierarchy (parents → grandparents).
 *        If any ancestor resolves to Deny → Deny (propagates down).
 *     c. If an explicit Allow exists on the resource → Allow.
 *     d. Else if an ancestor returned Allow → inherit it.
 *     e. Else → null (no claim = effectively Denied).
 *  3. HasRight = claim != null && claim == Allow.
 *     Unspecified is treated as Deny at the API layer.
 *  4. Deny can NEVER be overridden once resolved.
 *
 * ── Rights Catalog ────────────────────────────────────────────────────────
 *
 * ~100+ named rights with integer IDs:
 *   FarmRight       1000–1971 (Connect, ViewLiveVideo, ManageAlarms, etc.)
 *   DeviceRight     2000–2026 (BasicAccess, ViewLiveVideo, ControlPtz, etc.)
 *   DeviceGroupRight 2100–2106 (ViewGroup, EditGroupProperties, etc.)
 *   DioRight        2200–2201 (ViewIOState, ChangeIOState)
 *   MapRight        2400 (ViewMaps)
 *   CarouselRight   2500 (ViewCarousels)
 *   VideoWallRight  3000–3008
 *   VideoWallGroupRight 3100–3106
 *   UserRight       4000–4005
 *   UserGroupRight  4100–4106
 *   PolicyRight     5000–5001
 *   SharedViewRight 6000
 */

import {
  type ParsedTable,
  discoverTableFiles,
  parseAllTables,
  findColumn,
} from "./db-tables.js";

// ─────────────────────────────────────────────────────────────────────────────
// Known rights catalog — from *Right.cs source files
// ─────────────────────────────────────────────────────────────────────────────

interface RightDef {
  id: number;
  name: string;
  resourceType: string;
  group: string;
}

const KNOWN_RIGHTS: RightDef[] = [
  // ── FarmRight (site-level) ────────────────────────────────────────────
  { id: 1000, name: "Connect",                    resourceType: "Farm", group: "Misc" },
  { id: 1001, name: "GetLogs",                    resourceType: "Farm", group: "Misc" },
  { id: 1020, name: "ManageServices",             resourceType: "Farm", group: "Misc" },
  { id: 1021, name: "ChangeIOState",              resourceType: "Farm", group: "Misc" },
  { id: 1022, name: "PlaySounds",                 resourceType: "Farm", group: "Misc" },
  { id: 1023, name: "DeleteFootage",              resourceType: "Farm", group: "Misc" },
  { id: 1024, name: "ExportVideo",                resourceType: "Farm", group: "Misc" },
  { id: 1025, name: "ManageBookmarks",            resourceType: "Farm", group: "Misc" },
  { id: 1026, name: "ConfigureMaps",              resourceType: "Farm", group: "Misc" },
  { id: 1100, name: "ChangeSettings",             resourceType: "Farm", group: "Configuration" },
  { id: 1101, name: "AddDevices",                 resourceType: "Farm", group: "Configuration" },
  { id: 1102, name: "ChangeAccessControl",        resourceType: "Farm", group: "Configuration" },
  { id: 1103, name: "ViewConfiguration",          resourceType: "Farm", group: "Configuration" },
  { id: 1200, name: "ChangeAuthenticationMode",   resourceType: "Farm", group: "Security" },
  { id: 1201, name: "ManageSecurityProfiles",     resourceType: "Farm", group: "Security" },
  { id: 1202, name: "ActivateSecurityProfile",    resourceType: "Farm", group: "Security" },
  { id: 1203, name: "EditSecurity",               resourceType: "Farm", group: "Security" },
  { id: 1204, name: "AllowLoginWithoutReason",    resourceType: "Farm", group: "Security" },
  { id: 1205, name: "ManageSecuritySettings",     resourceType: "Farm", group: "Security" },
  { id: 1290, name: "ViewSubscriptions",          resourceType: "Farm", group: "Subscription" },
  { id: 1291, name: "ChangeSubscriptions",        resourceType: "Farm", group: "Subscription" },
  { id: 1300, name: "Search",                     resourceType: "Farm", group: "Search" },
  { id: 1301, name: "DeleteSearch",               resourceType: "Farm", group: "Search" },
  { id: 1302, name: "ConvertSearch",              resourceType: "Farm", group: "Search" },
  { id: 1350, name: "ExecuteReport",              resourceType: "Farm", group: "Report" },
  { id: 1400, name: "ViewAlarm",                  resourceType: "Farm", group: "Alarm" },
  { id: 1401, name: "MarkAlarm",                  resourceType: "Farm", group: "Alarm" },
  { id: 1402, name: "ManageAlarm",                resourceType: "Farm", group: "Alarm" },
  { id: 1403, name: "AddAlarm",                   resourceType: "Farm", group: "Alarm" },
  { id: 1404, name: "LimitedMaskAlarms",          resourceType: "Farm", group: "Alarm" },
  { id: 1405, name: "UnlimitedMaskAlarms",        resourceType: "Farm", group: "Alarm" },
  { id: 1406, name: "UnmaskAlarms",               resourceType: "Farm", group: "Alarm" },
  { id: 1407, name: "BulkProcessAlarms",          resourceType: "Farm", group: "Alarm" },
  { id: 1452, name: "AddRules",                   resourceType: "Farm", group: "Rule" },
  { id: 1500, name: "BackupDataAndConfig",        resourceType: "Farm", group: "Backup" },
  { id: 1501, name: "RestoreDataAndConfig",       resourceType: "Farm", group: "Backup" },
  { id: 1601, name: "AddUsers",                   resourceType: "Farm", group: "User" },
  { id: 1604, name: "MultipleLogins",             resourceType: "Farm", group: "User" },
  { id: 1700, name: "ViewCarousels",              resourceType: "Farm", group: "UI" },
  { id: 1701, name: "ChangeCarousels",            resourceType: "Farm", group: "UI" },
  { id: 1705, name: "LockUI",                     resourceType: "Farm", group: "UI" },
  { id: 1706, name: "ManageSharedViews",          resourceType: "Farm", group: "UI" },
  { id: 1707, name: "ConfigureVisualTracking",    resourceType: "Farm", group: "UI" },
  { id: 1710, name: "ViewAggregates",             resourceType: "Farm", group: "UI" },
  { id: 1711, name: "ChangeAggregates",           resourceType: "Farm", group: "UI" },
  { id: 1750, name: "VideoWallWS",                resourceType: "Farm", group: "VideoWall" },
  { id: 1751, name: "CreateVideoWalls",           resourceType: "Farm", group: "VideoWall" },
  { id: 1752, name: "ChangeVideoWallController",  resourceType: "Farm", group: "VideoWall" },
  { id: 1800, name: "SendMessage",                resourceType: "Farm", group: "Messenger" },
  { id: 1801, name: "ModifyPreWrittenMessage",    resourceType: "Farm", group: "Messenger" },
  { id: 1900, name: "ViewLicensePlateData",       resourceType: "Farm", group: "LPR" },
  { id: 1901, name: "DeleteLicensePlate",         resourceType: "Farm", group: "LPR" },
  { id: 1902, name: "AddAndEditLicensePlateMetaData", resourceType: "Farm", group: "LPR" },
  { id: 1904, name: "PerformLicensePlateSearch",  resourceType: "Farm", group: "LPR" },
  { id: 1905, name: "ViewLicensePlateLog",        resourceType: "Farm", group: "LPR" },
  { id: 1907, name: "ExportLicensePlateData",     resourceType: "Farm", group: "LPR" },
  { id: 1908, name: "ManageLicensePlateLists",    resourceType: "Farm", group: "LPR" },
  { id: 1909, name: "ManageSpecialCharacters",    resourceType: "Farm", group: "LPR" },
  { id: 1950, name: "ViewFaces",                  resourceType: "Farm", group: "FaceRec" },
  { id: 1951, name: "ChangeFaces",                resourceType: "Farm", group: "FaceRec" },
  { id: 1952, name: "ManageFaceLists",            resourceType: "Farm", group: "FaceRec" },
  { id: 1960, name: "ViewPos",                    resourceType: "Farm", group: "POS" },
  { id: 1961, name: "ChangePos",                  resourceType: "Farm", group: "POS" },
  { id: 1970, name: "ManageBrowsers",             resourceType: "Farm", group: "Browsers" },
  { id: 1971, name: "ViewBrowsers",               resourceType: "Farm", group: "Browsers" },

  // ── DeviceRight (per-camera/device) ───────────────────────────────────
  { id: 2000, name: "BasicAccess",                resourceType: "Device", group: "Misc" },
  { id: 2001, name: "ChangeSettings",             resourceType: "Device", group: "Configuration" },
  { id: 2002, name: "Delete",                     resourceType: "Device", group: "Configuration" },
  { id: 2003, name: "ViewLiveVideo",              resourceType: "Device", group: "Video" },
  { id: 2004, name: "ViewHistoricalVideo",        resourceType: "Device", group: "Video" },
  { id: 2005, name: "SearchFootage",              resourceType: "Device", group: "Search" },
  { id: 2006, name: "ControlPtz",                 resourceType: "Device", group: "PTZ" },
  { id: 2007, name: "ManageAlarms",               resourceType: "Device", group: "Alarm" },
  { id: 2008, name: "ManageRecording",            resourceType: "Device", group: "Video" },
  { id: 2009, name: "ConfigureAnalytics",         resourceType: "Device", group: "Configuration" },
  { id: 2010, name: "ChangeSecurity",             resourceType: "Device", group: "Configuration" },
  { id: 2011, name: "EditMembership",             resourceType: "Device", group: "Configuration" },
  { id: 2012, name: "CalibratePtzCamera",         resourceType: "Device", group: "PTZ" },
  { id: 2013, name: "AudioCanListen",             resourceType: "Device", group: "Audio" },
  { id: 2014, name: "AudioCanTalk",               resourceType: "Device", group: "Audio" },
  { id: 2015, name: "ViewPrivateVideo",           resourceType: "Device", group: "Video" },
  { id: 2016, name: "PtzPresets",                 resourceType: "Device", group: "PTZ" },
  { id: 2017, name: "ViewRestrictedHistoricalVideo", resourceType: "Device", group: "Video" },
  { id: 2018, name: "TriggerAlarm",               resourceType: "Device", group: "Alarm" },
  { id: 2019, name: "EditLicensePlate",           resourceType: "Device", group: "LPR" },
  { id: 2020, name: "Zoom",                       resourceType: "Device", group: "PTZ" },
  { id: 2021, name: "SendCommands",               resourceType: "Device", group: "Misc" },
  { id: 2022, name: "ViewCardHolders",            resourceType: "Device", group: "AccessControl" },
  { id: 2023, name: "ViewAccessAreas",            resourceType: "Device", group: "AccessControl" },
  { id: 2024, name: "LimitedMaskAlarms",          resourceType: "Device", group: "Alarm" },
  { id: 2025, name: "UnlimitedMaskAlarms",        resourceType: "Device", group: "Alarm" },
  { id: 2026, name: "UnmaskAlarms",               resourceType: "Device", group: "Alarm" },

  // ── DeviceGroupRight ──────────────────────────────────────────────────
  { id: 2100, name: "ViewGroup",                  resourceType: "DeviceGroup", group: "Misc" },
  { id: 2101, name: "EditGroupProperties",        resourceType: "DeviceGroup", group: "Configuration" },
  { id: 2102, name: "AddMembersToGroup",           resourceType: "DeviceGroup", group: "Configuration" },
  { id: 2103, name: "RemoveMembersFromGroup",      resourceType: "DeviceGroup", group: "Configuration" },
  { id: 2104, name: "ChangeGroupSecurity",         resourceType: "DeviceGroup", group: "Configuration" },
  { id: 2105, name: "EditMembership",              resourceType: "DeviceGroup", group: "Configuration" },
  { id: 2106, name: "DeleteGroup",                 resourceType: "DeviceGroup", group: "Configuration" },

  // ── DioRight ──────────────────────────────────────────────────────────
  { id: 2200, name: "ViewIOState",                resourceType: "DIO", group: "Misc" },
  { id: 2201, name: "ChangeIOState",              resourceType: "DIO", group: "Configuration" },

  // ── MapRight ──────────────────────────────────────────────────────────
  { id: 2400, name: "ViewMaps",                   resourceType: "Map", group: "Misc" },

  // ── CarouselRight ─────────────────────────────────────────────────────
  { id: 2500, name: "ViewCarousels",              resourceType: "Carousel", group: "Misc" },

  // ── VideoWallRight ────────────────────────────────────────────────────
  { id: 3000, name: "ChangeCameraInPanel",         resourceType: "VideoWall", group: "Misc" },
  { id: 3001, name: "ChangeWindow",                resourceType: "VideoWall", group: "Misc" },
  { id: 3002, name: "MoveWindow",                  resourceType: "VideoWall", group: "Misc" },
  { id: 3003, name: "View",                        resourceType: "VideoWall", group: "Misc" },
  { id: 3004, name: "Modify",                      resourceType: "VideoWall", group: "Configuration" },
  { id: 3005, name: "Delete",                      resourceType: "VideoWall", group: "Configuration" },
  { id: 3006, name: "UsePanelContextMenu",         resourceType: "VideoWall", group: "Misc" },
  { id: 3007, name: "UseWindowContextMenu",        resourceType: "VideoWall", group: "Misc" },
  { id: 3008, name: "EditSecurity",                resourceType: "VideoWall", group: "Configuration" },

  // ── VideoWallGroupRight ───────────────────────────────────────────────
  { id: 3100, name: "ViewGroup",                   resourceType: "VideoWallGroup", group: "Misc" },
  { id: 3101, name: "EditGroupProperties",         resourceType: "VideoWallGroup", group: "Configuration" },
  { id: 3102, name: "AddMembersToGroup",            resourceType: "VideoWallGroup", group: "Configuration" },
  { id: 3103, name: "RemoveMembersFromGroup",       resourceType: "VideoWallGroup", group: "Configuration" },
  { id: 3104, name: "ChangeGroupSecurity",          resourceType: "VideoWallGroup", group: "Configuration" },
  { id: 3105, name: "EditMembership",               resourceType: "VideoWallGroup", group: "Configuration" },
  { id: 3106, name: "DeleteGroup",                  resourceType: "VideoWallGroup", group: "Configuration" },

  // ── UserRight ─────────────────────────────────────────────────────────
  { id: 4000, name: "EditMembership",              resourceType: "User", group: "Configuration" },
  { id: 4001, name: "EditSettings",                resourceType: "User", group: "Configuration" },
  { id: 4002, name: "EditSecurity",                resourceType: "User", group: "Configuration" },
  { id: 4003, name: "ViewUser",                    resourceType: "User", group: "Misc" },
  { id: 4004, name: "DeleteUser",                  resourceType: "User", group: "Configuration" },
  { id: 4005, name: "TerminateSession",            resourceType: "User", group: "Misc" },

  // ── UserGroupRight ────────────────────────────────────────────────────
  { id: 4100, name: "ViewGroup",                   resourceType: "UserGroup", group: "Misc" },
  { id: 4101, name: "EditGroupProperties",         resourceType: "UserGroup", group: "Configuration" },
  { id: 4102, name: "AddMembersToGroup",            resourceType: "UserGroup", group: "Configuration" },
  { id: 4103, name: "RemoveMembersFromGroup",       resourceType: "UserGroup", group: "Configuration" },
  { id: 4104, name: "ChangeGroupSecurity",          resourceType: "UserGroup", group: "Configuration" },
  { id: 4105, name: "EditMembership",               resourceType: "UserGroup", group: "Configuration" },
  { id: 4106, name: "DeleteGroup",                  resourceType: "UserGroup", group: "Configuration" },

  // ── PolicyRight ───────────────────────────────────────────────────────
  { id: 5000, name: "ViewRule",                    resourceType: "Rule", group: "Misc" },
  { id: 5001, name: "ChangeRule",                  resourceType: "Rule", group: "Configuration" },

  // ── SharedViewRight ───────────────────────────────────────────────────
  { id: 6000, name: "ViewSharedView",              resourceType: "SharedView", group: "Misc" },
];

const RIGHTS_BY_ID = new Map<number, RightDef>(KNOWN_RIGHTS.map(r => [r.id, r]));
const RIGHTS_BY_NAME = new Map<string, RightDef[]>();
for (const r of KNOWN_RIGHTS) {
  const key = r.name.toLowerCase();
  if (!RIGHTS_BY_NAME.has(key)) RIGHTS_BY_NAME.set(key, []);
  RIGHTS_BY_NAME.get(key)!.push(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PermissionsArgs {
  mode: "resolve" | "groups" | "check" | "rights" | "raw";
  /** User login or display name (required for resolve & check) */
  user?: string;
  /** Right name to check, fuzzy-matched against known rights catalog (for check) */
  permission?: string;
  /** Resource name to scope check to (for check) — fuzzy matched */
  resource?: string;
  /** Max rows in output */
  limit?: number;
}

/** Three-state permission matching the C# enum */
type PermissionValue = "Allow" | "Deny" | "Unspecified";

/** A row from the Users table */
interface UserRow {
  securityId: string;
  loginId: string;
  name: string;
  disabled: string;
  adId: string;
}

/** A row from the UserGroup table */
interface GroupRow {
  securityId: string;
  name: string;
  description: string;
  adId: string;
  adName: string;
}

/** User ↔ Group membership (UserToUserGroup) */
interface Membership { userId: string; groupId: string; }

/** Group nesting (UserGroupToUserGroup) */
interface GroupNesting { groupId: string; parentGroupId: string; }

/** A row from SecurityRight */
interface RightRow {
  id: number;
  groupName: string;
  name: string;
  description: string;
  resourceType: string;
}

/** A row from ResourceRight */
interface ResourceRightRow {
  id: number;
  resourceId: string;
  profileId: number;
  rightId: number;
}

/** A row from RightPermission */
interface RightPermissionRow {
  rightPermissionGroupId: number;
  principalId: string;
  permission: PermissionValue;
}

/** Resolved effective permission */
interface EffectiveRight {
  rightId: number;
  rightName: string;
  resourceType: string;
  rightGroup: string;
  resourceId: string;
  resourceLabel: string;
  profileId: number;
  profileName: string;
  permission: PermissionValue;
  /** Which principals (user directly or groups) contributed */
  sources: { principalId: string; principalLabel: string; permission: PermissionValue }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table finders — locate the exact Symphony tables by name/columns
// ─────────────────────────────────────────────────────────────────────────────

function findTableByName(tables: ParsedTable[], ...names: string[]): ParsedTable | null {
  for (const name of names) {
    const lower = name.toLowerCase();
    const exact = tables.find(t => t.tableName.toLowerCase() === lower);
    if (exact) return exact;
  }
  // Fallback: substring match
  for (const name of names) {
    const lower = name.toLowerCase();
    const partial = tables.find(t => t.tableName.toLowerCase().includes(lower));
    if (partial) return partial;
  }
  return null;
}

function normalizeGuid(v: string): string {
  return (v ?? "").trim().toLowerCase().replace(/[{}]/g, "");
}

function colVal(row: Record<string, string>, ...candidates: string[]): string {
  for (const c of candidates) {
    const lower = c.toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === lower) return (row[key] ?? "").trim();
    }
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract rows from parsed tables into our typed records
// ─────────────────────────────────────────────────────────────────────────────

function extractUsers(table: ParsedTable | null): UserRow[] {
  if (!table) return [];
  return table.rows.map(r => ({
    securityId: normalizeGuid(colVal(r, "SecurityID", "SecurityId")),
    loginId: colVal(r, "LoginId", "LoginID", "Login"),
    name: colVal(r, "Nm", "Name", "DisplayName"),
    disabled: colVal(r, "Disabled"),
    adId: colVal(r, "ActiveDirectoryID", "ActiveDirectoryId"),
  })).filter(u => u.securityId || u.loginId);
}

function extractGroups(table: ParsedTable | null): GroupRow[] {
  if (!table) return [];
  return table.rows.map(r => ({
    securityId: normalizeGuid(colVal(r, "SecurityID", "SecurityId")),
    name: colVal(r, "Name", "GroupName"),
    description: colVal(r, "Description", "Descr"),
    adId: colVal(r, "ActiveDirectoryID"),
    adName: colVal(r, "ActiveDirectoryName"),
  })).filter(g => g.securityId || g.name);
}

function extractMemberships(table: ParsedTable | null): Membership[] {
  if (!table) return [];
  return table.rows.map(r => ({
    userId: normalizeGuid(colVal(r, "UserID", "UserId")),
    groupId: normalizeGuid(colVal(r, "GroupID", "GroupId")),
  })).filter(m => m.userId && m.groupId);
}

function extractGroupNesting(table: ParsedTable | null): GroupNesting[] {
  if (!table) return [];
  return table.rows.map(r => ({
    groupId: normalizeGuid(colVal(r, "GroupID", "GroupId")),
    parentGroupId: normalizeGuid(colVal(r, "ParentGroupID", "ParentGroupId")),
  })).filter(n => n.groupId && n.parentGroupId);
}

function extractSecurityRights(table: ParsedTable | null): RightRow[] {
  if (!table) return [];
  return table.rows.map(r => ({
    id: parseInt(colVal(r, "ID", "Id", "RightID"), 10) || 0,
    groupName: colVal(r, "GroupName"),
    name: colVal(r, "Name"),
    description: colVal(r, "Description"),
    resourceType: colVal(r, "ResourceType"),
  })).filter(r => r.id > 0);
}

function extractResourceRights(table: ParsedTable | null): ResourceRightRow[] {
  if (!table) return [];
  return table.rows.map(r => ({
    id: parseInt(colVal(r, "ID", "Id"), 10) || 0,
    resourceId: normalizeGuid(colVal(r, "ResourceID", "ResourceId")),
    profileId: parseInt(colVal(r, "ProfileID", "ProfileId"), 10) || 0,
    rightId: parseInt(colVal(r, "RightID", "RightId"), 10) || 0,
  })).filter(r => r.id > 0);
}

function extractRightPermissions(table: ParsedTable | null): RightPermissionRow[] {
  if (!table) return [];
  return table.rows.map(r => {
    const raw = colVal(r, "Permission");
    let permission: PermissionValue;
    if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "deny") {
      permission = "Deny";
    } else if (raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "allow") {
      permission = "Allow";
    } else {
      permission = "Unspecified"; // NULL or empty
    }
    return {
      rightPermissionGroupId: parseInt(colVal(r, "RightPermissionGroupID", "RightPermissionGroupId"), 10) || 0,
      principalId: normalizeGuid(colVal(r, "PrincipalID", "PrincipalId")),
      permission,
    };
  }).filter(r => r.rightPermissionGroupId > 0 && r.principalId);
}

function extractProfiles(table: ParsedTable | null): { id: number; name: string }[] {
  if (!table) return [];
  return table.rows.map(r => ({
    id: parseInt(colVal(r, "ID", "Id"), 10) || 0,
    name: colVal(r, "Name"),
  })).filter(p => p.id > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution engine — mirrors ClaimSet.GetClaim logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all ancestor group SecurityIDs for a user (direct groups + parent groups
 * recursively via UserGroupToUserGroup).
 */
function getAncestorGroupIds(
  userSecurityId: string,
  memberships: Membership[],
  nesting: GroupNesting[],
): Set<string> {
  // Direct groups
  const directGroups = new Set(
    memberships.filter(m => m.userId === userSecurityId).map(m => m.groupId)
  );

  // Recurse up parent groups
  const allGroups = new Set(directGroups);
  const queue = [...directGroups];
  while (queue.length > 0) {
    const gid = queue.pop()!;
    for (const n of nesting) {
      if (n.groupId === gid && !allGroups.has(n.parentGroupId)) {
        allGroups.add(n.parentGroupId);
        queue.push(n.parentGroupId);
      }
    }
  }
  return allGroups;
}

/**
 * Resolve effective permissions for a user.
 *
 * For each (resource, right, profile) tuple defined in ResourceRight:
 *   1. Collect all RightPermission rows where principal is the user OR any of
 *      the user's ancestor groups.
 *   2. Apply deny-wins: if ANY source says Deny → effective is Deny.
 *      Else if ANY says Allow → Allow.
 *      Else → Unspecified (= effectively Deny).
 */
function resolveEffective(
  userSecurityId: string,
  ancestorGroupIds: Set<string>,
  resourceRights: ResourceRightRow[],
  rightPermissions: RightPermissionRow[],
  rightsById: Map<number, RightRow | RightDef>,
  profilesById: Map<number, string>,
  groupsById: Map<string, GroupRow>,
): EffectiveRight[] {
  // Index: ResourceRight.ID → RightPermission[]
  const permsByRRId = new Map<number, RightPermissionRow[]>();
  for (const rp of rightPermissions) {
    if (!permsByRRId.has(rp.rightPermissionGroupId))
      permsByRRId.set(rp.rightPermissionGroupId, []);
    permsByRRId.get(rp.rightPermissionGroupId)!.push(rp);
  }

  // Set of all principal IDs to check (user + all ancestor groups)
  const principalIds = new Set([userSecurityId, ...ancestorGroupIds]);

  const results: EffectiveRight[] = [];

  for (const rr of resourceRights) {
    const perms = permsByRRId.get(rr.id);
    if (!perms) continue;

    // Filter to permissions for our user's principals
    const relevant = perms.filter(p => principalIds.has(p.principalId));
    if (relevant.length === 0) continue;

    const rightDef = rightsById.get(rr.rightId);
    const rightName = rightDef ? ("name" in rightDef ? rightDef.name : "") : `Right#${rr.rightId}`;
    const resourceType = rightDef ? ("resourceType" in rightDef ? rightDef.resourceType : "") : "";
    const rightGroup = rightDef ? ("group" in rightDef ? rightDef.group : "") : "";

    // Collect sources and apply deny-wins
    const sources: EffectiveRight["sources"] = [];
    let hasDeny = false;
    let hasAllow = false;

    for (const rp of relevant) {
      const isUser = rp.principalId === userSecurityId;
      const group = groupsById.get(rp.principalId);
      const label = isUser ? "(direct)" : (group?.name ?? rp.principalId);

      sources.push({
        principalId: rp.principalId,
        principalLabel: label,
        permission: rp.permission,
      });

      if (rp.permission === "Deny") hasDeny = true;
      if (rp.permission === "Allow") hasAllow = true;
    }

    // Deny wins over everything (ClaimSet invariant)
    let effective: PermissionValue;
    if (hasDeny) effective = "Deny";
    else if (hasAllow) effective = "Allow";
    else effective = "Unspecified";

    results.push({
      rightId: rr.rightId,
      rightName,
      resourceType,
      rightGroup,
      resourceId: rr.resourceId,
      resourceLabel: rr.resourceId, // will be enriched later
      profileId: rr.profileId,
      profileName: profilesById.get(rr.profileId) ?? `Profile#${rr.profileId}`,
      permission: effective,
      sources,
    });
  }

  // Sort: Deny first, then by right name
  const order: Record<string, number> = { Deny: 0, Allow: 1, Unspecified: 2 };
  results.sort((a, b) => {
    const o = (order[a.permission] ?? 9) - (order[b.permission] ?? 9);
    if (o !== 0) return o;
    return a.rightName.localeCompare(b.rightName);
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// User lookup
// ─────────────────────────────────────────────────────────────────────────────

function findUser(users: UserRow[], query: string): UserRow | null {
  const q = query.toLowerCase().trim();
  return (
    users.find(u => u.loginId.toLowerCase() === q) ??
    users.find(u => u.name.toLowerCase() === q) ??
    users.find(u => u.loginId.toLowerCase().includes(q)) ??
    users.find(u => u.name.toLowerCase().includes(q)) ??
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatResolve(
  user: UserRow,
  directGroups: GroupRow[],
  allGroupIds: Set<string>,
  groups: GroupRow[],
  nesting: GroupNesting[],
  effective: EffectiveRight[],
): string {
  const out: string[] = [];
  out.push(`Effective Permissions for: ${user.name || user.loginId}`);
  out.push("═".repeat(70));
  out.push("");
  out.push(`  Login:      ${user.loginId}`);
  out.push(`  Name:       ${user.name || "(not set)"}`);
  out.push(`  SecurityID: ${user.securityId}`);
  if (user.disabled) out.push(`  Disabled:   ${user.disabled}`);
  if (user.adId) out.push(`  AD ID:      ${user.adId}`);
  out.push("");

  // Show group membership with nesting
  out.push("Group Memberships:");
  out.push("─".repeat(70));
  if (directGroups.length === 0) {
    out.push("  (no group memberships found)");
  } else {
    for (const g of directGroups) {
      // Find parent groups of this group
      const parentIds = nesting.filter(n => n.groupId === g.securityId).map(n => n.parentGroupId);
      const parentNames = parentIds.map(pid => {
        const pg = groups.find(g2 => g2.securityId === pid);
        return pg?.name ?? pid;
      });
      const parentSuffix = parentNames.length > 0 ? ` (child of: ${parentNames.join(", ")})` : "";
      out.push(`  • ${g.name}${parentSuffix}`);
    }
    // Show inherited (non-direct) groups
    const directIds = new Set(directGroups.map(g => g.securityId));
    const inheritedGroups = groups.filter(g => allGroupIds.has(g.securityId) && !directIds.has(g.securityId));
    if (inheritedGroups.length > 0) {
      out.push(`  Inherited via nesting:`);
      for (const g of inheritedGroups) {
        out.push(`    ↳ ${g.name}`);
      }
    }
  }
  out.push("");

  // Separate by permission state
  const denied = effective.filter(e => e.permission === "Deny");
  const allowed = effective.filter(e => e.permission === "Allow");
  const unspecified = effective.filter(e => e.permission === "Unspecified");

  out.push(`Summary: ${allowed.length} Allow, ${denied.length} Deny, ${unspecified.length} Unspecified (= Deny)`);
  out.push(`Profile: ${effective.length > 0 ? effective[0].profileName : "(unknown)"}`);
  out.push("");

  // DENIED — most important for support
  if (denied.length > 0) {
    out.push("DENIED (explicit Deny from a group — overrides any Allow):");
    out.push("─".repeat(70));
    for (const e of denied) {
      const scope = e.resourceId !== e.resourceLabel ? ` on ${e.resourceLabel}` : ` on resource ${e.resourceId.slice(0, 8)}…`;
      out.push(`  ✗ ${e.rightName} [${e.resourceType}]${scope}`);
      const denySources = e.sources.filter(s => s.permission === "Deny");
      const allowSources = e.sources.filter(s => s.permission === "Allow");
      out.push(`    Denied by:  ${denySources.map(s => s.principalLabel).join(", ")}`);
      if (allowSources.length > 0) {
        out.push(`    (Also granted by: ${allowSources.map(s => s.principalLabel).join(", ")} — but Deny wins)`);
      }
    }
    out.push("");
  }

  // ALLOWED
  if (allowed.length > 0) {
    out.push("ALLOWED:");
    out.push("─".repeat(70));
    // Group by resource type
    const byType = new Map<string, EffectiveRight[]>();
    for (const e of allowed) {
      const key = e.resourceType || "Other";
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(e);
    }
    for (const [type, rights] of byType) {
      out.push(`  [${type}]`);
      for (const e of rights) {
        const via = e.sources.filter(s => s.permission === "Allow").map(s => s.principalLabel).join(", ");
        out.push(`    ✓ ${e.rightName}  (via: ${via})`);
      }
    }
    out.push("");
  }

  // UNSPECIFIED (effectively denied — no entry at all)
  if (unspecified.length > 0) {
    out.push(`UNSPECIFIED (${unspecified.length} — treated as Deny, no group grants or denies):`);
    out.push("─".repeat(70));
    const shown = unspecified.slice(0, 30);
    for (const e of shown) {
      out.push(`  – ${e.rightName} [${e.resourceType}]`);
    }
    if (unspecified.length > 30) out.push(`  … and ${unspecified.length - 30} more`);
    out.push("");
  }

  out.push("Note: This analysis is based on data found in the bug report dump.");
  out.push("Resource hierarchy inheritance (parent device groups) cannot be fully");
  out.push("resolved from dump data — the above shows direct claims only.");

  return out.join("\n");
}

function formatGroups(
  groups: GroupRow[],
  users: UserRow[],
  memberships: Membership[],
  nesting: GroupNesting[],
  rightPermissions: RightPermissionRow[],
  resourceRights: ResourceRightRow[],
  rightsById: Map<number, RightRow | RightDef>,
): string {
  if (groups.length === 0) return "No UserGroup table found in the bug report.";

  const out: string[] = [];
  out.push(`Security Groups (${groups.length})`);
  out.push("═".repeat(70));
  out.push("");

  // Index: principalId → RightPermission[]
  const permsByPrincipal = new Map<string, RightPermissionRow[]>();
  for (const rp of rightPermissions) {
    if (!permsByPrincipal.has(rp.principalId)) permsByPrincipal.set(rp.principalId, []);
    permsByPrincipal.get(rp.principalId)!.push(rp);
  }

  for (const g of groups) {
    out.push(`▸ ${g.name}  (${g.securityId.slice(0, 8)}…)`);
    if (g.description) out.push(`  Description: ${g.description}`);
    if (g.adName) out.push(`  AD Group:    ${g.adName}`);

    // Members
    const memberIds = memberships.filter(m => m.groupId === g.securityId).map(m => m.userId);
    const memberNames = memberIds.map(uid => {
      const u = users.find(u => u.securityId === uid);
      return u ? `${u.name || u.loginId} (${u.loginId})` : uid.slice(0, 8) + "…";
    });
    out.push(`  Members (${memberNames.length}): ${memberNames.join(", ") || "(none)"}`);

    // Child groups
    const childIds = nesting.filter(n => n.parentGroupId === g.securityId).map(n => n.groupId);
    if (childIds.length > 0) {
      const childNames = childIds.map(cid => {
        const cg = groups.find(g2 => g2.securityId === cid);
        return cg?.name ?? cid.slice(0, 8) + "…";
      });
      out.push(`  Child groups: ${childNames.join(", ")}`);
    }

    // Parent groups
    const parentIds = nesting.filter(n => n.groupId === g.securityId).map(n => n.parentGroupId);
    if (parentIds.length > 0) {
      const parentNames = parentIds.map(pid => {
        const pg = groups.find(g2 => g2.securityId === pid);
        return pg?.name ?? pid.slice(0, 8) + "…";
      });
      out.push(`  Parent groups: ${parentNames.join(", ")}`);
    }

    // Permission stats
    const groupPerms = permsByPrincipal.get(g.securityId) ?? [];
    const allows = groupPerms.filter(p => p.permission === "Allow").length;
    const denies = groupPerms.filter(p => p.permission === "Deny").length;
    out.push(`  Permissions: ${allows} Allow, ${denies} Deny, ${groupPerms.length} total`);

    // Show deny rights (most interesting for support)
    if (denies > 0) {
      const denyPerms = groupPerms.filter(p => p.permission === "Deny");
      // Resolve right names via ResourceRight → SecurityRight
      const rrIndex = new Map(resourceRights.map(rr => [rr.id, rr]));
      const denyNames = denyPerms
        .map(dp => {
          const rr = rrIndex.get(dp.rightPermissionGroupId);
          if (!rr) return null;
          const rd = rightsById.get(rr.rightId);
          return rd ? ("name" in rd ? rd.name : `Right#${rr.rightId}`) : `Right#${rr.rightId}`;
        })
        .filter(Boolean);
      const unique = [...new Set(denyNames)];
      if (unique.length > 0) {
        out.push(`  Denied rights: ${unique.join(", ")}`);
      }
    }

    out.push("");
  }

  return out.join("\n");
}

function formatCheck(
  user: UserRow,
  directGroups: GroupRow[],
  allGroupIds: Set<string>,
  groups: GroupRow[],
  effective: EffectiveRight[],
  permQuery: string,
  resourceQuery?: string,
): string {
  const out: string[] = [];

  // Fuzzy match query against right names (or known catalog)
  const pLower = permQuery.toLowerCase();

  // Search effective permissions
  let matches = effective.filter(e =>
    e.rightName.toLowerCase().includes(pLower) ||
    e.rightId.toString() === permQuery
  );

  // Also try known rights catalog if nothing found
  if (matches.length === 0) {
    const knownMatches: RightDef[] = [];
    for (const [name, defs] of RIGHTS_BY_NAME) {
      if (name.includes(pLower)) knownMatches.push(...defs);
    }
    if (knownMatches.length > 0) {
      out.push(`Permission Check: "${permQuery}" for user ${user.name || user.loginId}`);
      out.push("═".repeat(70));
      out.push("");
      out.push(`No explicit permission entries found for "${permQuery}".`);
      out.push(`This means no group explicitly grants or denies this right → effectively DENIED.`);
      out.push("");
      out.push(`Matching rights from catalog:`);
      for (const r of knownMatches) {
        out.push(`  #${r.id} ${r.name} [${r.resourceType}]`);
      }
      out.push("");
      out.push(`User's groups: ${directGroups.map(g => g.name).join(", ") || "(none)"}`);
      return out.join("\n");
    }
  }

  if (resourceQuery) {
    const rLower = resourceQuery.toLowerCase();
    const resourceMatches = matches.filter(e =>
      e.resourceLabel.toLowerCase().includes(rLower) ||
      e.resourceId.toLowerCase().includes(rLower)
    );
    if (resourceMatches.length > 0) matches = resourceMatches;
  }

  out.push(`Permission Check: "${permQuery}"${resourceQuery ? ` on "${resourceQuery}"` : ""} for ${user.name || user.loginId}`);
  out.push("═".repeat(70));
  out.push("");
  out.push(`User groups: ${directGroups.map(g => g.name).join(", ") || "(none)"}`);
  out.push("");

  if (matches.length === 0) {
    out.push(`No permission matching "${permQuery}" found.`);
    out.push("This means no group explicitly grants or denies this right → effectively DENIED.");
    out.push("");
    out.push("Available rights in this dump:");
    const allNames = [...new Set(effective.map(e => e.rightName))].sort();
    for (const n of allNames.slice(0, 40)) out.push(`  - ${n}`);
    if (allNames.length > 40) out.push(`  … and ${allNames.length - 40} more`);
  } else {
    for (const m of matches) {
      const scope = ` on resource ${m.resourceId.slice(0, 8)}…`;
      if (m.permission === "Deny") {
        out.push(`  ✗ ${m.rightName} [${m.resourceType}]${scope} → DENIED`);
        const denySources = m.sources.filter(s => s.permission === "Deny");
        out.push(`    Denied by: ${denySources.map(s => s.principalLabel).join(", ")}`);
        const allowSources = m.sources.filter(s => s.permission === "Allow");
        if (allowSources.length > 0) {
          out.push(`    Also granted by: ${allowSources.map(s => s.principalLabel).join(", ")} — but Deny ALWAYS wins.`);
        }
        out.push(`    (Profile: ${m.profileName})`);
      } else if (m.permission === "Allow") {
        out.push(`  ✓ ${m.rightName} [${m.resourceType}]${scope} → ALLOWED`);
        const allowSources = m.sources.filter(s => s.permission === "Allow");
        out.push(`    Granted by: ${allowSources.map(s => s.principalLabel).join(", ")}`);
        out.push(`    (Profile: ${m.profileName})`);
      } else {
        out.push(`  – ${m.rightName} [${m.resourceType}]${scope} → EFFECTIVELY DENIED (Unspecified)`);
        out.push(`    No group explicitly grants or denies.`);
      }
      out.push("");
    }
  }

  return out.join("\n");
}

function formatRights(): string {
  const out: string[] = [];
  out.push(`Symphony VMS Rights Catalog (${KNOWN_RIGHTS.length} rights)`);
  out.push("═".repeat(70));
  out.push("");

  const byType = new Map<string, RightDef[]>();
  for (const r of KNOWN_RIGHTS) {
    if (!byType.has(r.resourceType)) byType.set(r.resourceType, []);
    byType.get(r.resourceType)!.push(r);
  }

  for (const [type, rights] of byType) {
    out.push(`[${type}] (${rights.length} rights)`);
    for (const r of rights) {
      out.push(`  #${r.id.toString().padEnd(5)} ${r.name.padEnd(35)} (${r.group})`);
    }
    out.push("");
  }

  out.push("Resolution rules:");
  out.push("  1. Permission is BIT NULL in DB: 0=Deny, 1=Allow, NULL=Unspecified");
  out.push("  2. Deny ALWAYS wins — if any group denies, the right is denied");
  out.push("  3. Unspecified = effectively Deny (no entry = no access)");
  out.push("  4. Permissions are scoped to specific resources via ResourceRight");
  out.push("  5. Group nesting: UserGroupToUserGroup allows groups within groups");
  out.push("  6. SecurityProfile: multiple named configs can exist, only one active");

  return out.join("\n");
}

function formatRaw(
  tUsers: ParsedTable | null,
  tGroups: ParsedTable | null,
  tMembership: ParsedTable | null,
  tNesting: ParsedTable | null,
  tProfiles: ParsedTable | null,
  tRights: ParsedTable | null,
  tResRights: ParsedTable | null,
  tPermissions: ParsedTable | null,
  limit: number,
): string {
  const tables: { label: string; table: ParsedTable | null; dbName: string }[] = [
    { label: "Users", table: tUsers, dbName: "Users" },
    { label: "UserGroup", table: tGroups, dbName: "UserGroup" },
    { label: "UserToUserGroup", table: tMembership, dbName: "UserToUserGroup" },
    { label: "UserGroupToUserGroup", table: tNesting, dbName: "UserGroupToUserGroup" },
    { label: "SecurityProfile", table: tProfiles, dbName: "SecurityProfile" },
    { label: "SecurityRight", table: tRights, dbName: "SecurityRight" },
    { label: "ResourceRight", table: tResRights, dbName: "ResourceRight" },
    { label: "RightPermission", table: tPermissions, dbName: "RightPermission" },
  ];

  const out: string[] = ["Permission Tables from Bug Report Dump", "═".repeat(70), ""];

  for (const { label, table, dbName } of tables) {
    if (!table) {
      out.push(`${label} (${dbName}): NOT FOUND`);
      out.push("");
      continue;
    }

    out.push(`${label} (matched: "${table.tableName}", ${table.rows.length} rows, from ${table.sourceFile})`);
    out.push(`  Columns: ${table.columns.join(", ")}`);

    const shown = table.rows.slice(0, limit);
    for (const row of shown) {
      out.push(`    ${table.columns.map(c => `${c}: ${row[c] ?? ""}`).join(" | ")}`);
    }
    if (table.rows.length > limit) {
      out.push(`    … and ${table.rows.length - limit} more rows`);
    }
    out.push("");
  }

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function toolPermissions(
  bugReport: { folderPath: string } | null,
  args: PermissionsArgs,
): Promise<string> {
  // "rights" mode doesn't need a bug report
  if (args.mode === "rights") {
    return formatRights();
  }

  if (!bugReport) {
    return "sym_permissions requires a bug report package. Point LOG_DIR at a bug report folder.";
  }

  const limit = args.limit ?? 50;

  // Discover and parse all tables from the bug report
  const tableFiles = await discoverTableFiles(bugReport.folderPath);
  if (tableFiles.length === 0) {
    return "No files containing database table data found in the bug report.";
  }
  const allTables = await parseAllTables(tableFiles);
  if (allTables.length === 0) {
    return `Scanned ${tableFiles.length} file(s) but found no parseable table data.`;
  }

  // ── Locate specific tables by their known names ──
  const tUsers      = findTableByName(allTables, "Users");
  const tGroups     = findTableByName(allTables, "UserGroup");
  const tMembership = findTableByName(allTables, "UserToUserGroup");
  const tNesting    = findTableByName(allTables, "UserGroupToUserGroup");
  const tProfiles   = findTableByName(allTables, "SecurityProfile");
  const tRights     = findTableByName(allTables, "SecurityRight");
  const tResRights  = findTableByName(allTables, "ResourceRight");
  const tPermissions = findTableByName(allTables, "RightPermission");

  // Raw mode — just show what tables we found
  if (args.mode === "raw") {
    return formatRaw(tUsers, tGroups, tMembership, tNesting, tProfiles, tRights, tResRights, tPermissions, limit);
  }

  // ── Extract typed records ──
  const users = extractUsers(tUsers);
  const groups = extractGroups(tGroups);
  const memberships = extractMemberships(tMembership);
  const nesting = extractGroupNesting(tNesting);
  const profiles = extractProfiles(tProfiles);
  const dbRights = extractSecurityRights(tRights);
  const resourceRights = extractResourceRights(tResRights);
  const rightPermissions = extractRightPermissions(tPermissions);

  // Build lookup maps
  // Rights: prefer DB rows (they may have custom rights), fall back to known catalog
  const rightsById = new Map<number, RightRow | RightDef>();
  for (const r of KNOWN_RIGHTS) rightsById.set(r.id, r);
  for (const r of dbRights) rightsById.set(r.id, r); // override with actual DB data
  const profilesById = new Map(profiles.map(p => [p.id, p.name]));
  const groupsById = new Map(groups.map(g => [g.securityId, g]));

  // Warnings
  const warnings: string[] = [];
  if (!tUsers) warnings.push("⚠ Users table not found");
  if (!tGroups) warnings.push("⚠ UserGroup table not found");
  if (!tMembership) warnings.push("⚠ UserToUserGroup table not found — cannot determine group memberships");
  if (!tPermissions) warnings.push("⚠ RightPermission table not found — cannot resolve permissions");
  if (!tResRights) warnings.push("⚠ ResourceRight table not found — cannot link permissions to rights");
  const warningBlock = warnings.length > 0
    ? warnings.join("\n") + "\n\nTip: Use mode 'raw' to see which tables were found and their actual names.\n\n"
    : "";

  // Groups mode
  if (args.mode === "groups") {
    return warningBlock + formatGroups(groups, users, memberships, nesting, rightPermissions, resourceRights, rightsById);
  }

  // Resolve & check need a user
  if (!args.user) {
    const userList = users.length > 0
      ? "\n\nAvailable users:\n" + users.map(u => `  - ${u.name || u.loginId} (${u.loginId})`).join("\n")
      : "\n\n(No Users table found in dump)";
    return `The 'user' parameter is required for mode '${args.mode}'.${userList}`;
  }

  const user = findUser(users, args.user);
  if (!user) {
    const userList = users.map(u => `  - ${u.name || u.loginId} (${u.loginId})`).join("\n");
    return `User "${args.user}" not found.\n\nAvailable users:\n${userList || "(none)"}`;
  }

  // Get ancestor groups
  const allGroupIds = getAncestorGroupIds(user.securityId, memberships, nesting);
  const directGroupIds = new Set(memberships.filter(m => m.userId === user.securityId).map(m => m.groupId));
  const directGroups = groups.filter(g => directGroupIds.has(g.securityId));

  // Resolve effective permissions
  const effective = resolveEffective(
    user.securityId, allGroupIds,
    resourceRights, rightPermissions,
    rightsById, profilesById, groupsById,
  );

  if (args.mode === "check") {
    if (!args.permission) {
      return `The 'permission' parameter is required for 'check' mode.\n\nExample: sym_permissions mode="check" user="${user.loginId}" permission="ViewLiveVideo"`;
    }
    return warningBlock + formatCheck(user, directGroups, allGroupIds, groups, effective, args.permission, args.resource);
  }

  // resolve mode
  return warningBlock + formatResolve(user, directGroups, allGroupIds, groups, nesting, effective);
}
