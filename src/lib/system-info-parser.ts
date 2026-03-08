/**
 * system-info-parser.ts
 *
 * Parsers for the supplementary (non-log) diagnostic files that Symphony's
 * LogPackage.cs includes in bug report server zips.
 *
 * Each file is plain-text output from a Windows command (sc queryex,
 * tasklist /V, ipconfig /all, netstat, systeminfo, etc.) or a Symphony
 * utility (printshmem, EventViewerConsole).  The parsers extract structured
 * data from these formats.
 */

import * as fs from "fs/promises";

// ─────────────────────────────────────────────────────────────────────────────
// services.txt — output of "sc queryex"
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowsService {
  serviceName: string;
  displayName: string;
  state:       string;   // RUNNING, STOPPED, etc.
  pid:         number;
  type:        string;   // WIN32_OWN_PROCESS, etc.
  startType?:  string;
}

/**
 * Parse `sc queryex` output.  Each service block starts with
 * "SERVICE_NAME:" and contains STATE, PID, TYPE, etc.
 */
export function parseServicesTxt(text: string): WindowsService[] {
  const services: WindowsService[] = [];
  // Split on SERVICE_NAME: lines
  const blocks = text.split(/^SERVICE_NAME:\s*/m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const serviceName = lines[0]?.trim() ?? "";
    if (!serviceName) continue;

    let displayName = "";
    let state = "";
    let pid = 0;
    let type = "";

    for (const line of lines) {
      const kv = line.match(/^\s+(\w[\w\s]*\w)\s*:\s*(.+)/);
      if (!kv) continue;
      const key = kv[1].trim().toUpperCase();
      const val = kv[2].trim();

      if (key === "DISPLAY_NAME") displayName = val;
      else if (key === "STATE") {
        // "4  RUNNING" or "1  STOPPED"
        const m = val.match(/\d+\s+(\w+)/);
        state = m ? m[1] : val;
      }
      else if (key === "PID") pid = parseInt(val) || 0;
      else if (key === "TYPE") {
        const m = val.match(/\w+\s+(\w[\w_]+)/);
        type = m ? m[1] : val;
      }
    }

    services.push({ serviceName, displayName, state, pid, type });
  }
  return services;
}

// ─────────────────────────────────────────────────────────────────────────────
// tasklist.txt — output of "tasklist /V"
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcessInfo {
  imageName:  string;
  pid:        number;
  sessionName: string;
  sessionNum: number;
  memUsageKB: number;
  status:     string;
  userName:   string;
  cpuTime:    string;
  windowTitle: string;
}

/**
 * Parse `tasklist /V` output.  The first non-blank line is the header,
 * followed by a separator line of "=" characters that defines column widths.
 */
export function parseTasklistTxt(text: string): ProcessInfo[] {
  const lines = text.split(/\r?\n/);
  // Find the separator line (=== === ===)
  const sepIdx = lines.findIndex(l => /^=+\s+=+/.test(l));
  if (sepIdx < 1) return [];

  const sepLine = lines[sepIdx];
  // Determine column widths from the separator
  const cols: { start: number; end: number }[] = [];
  let i = 0;
  while (i < sepLine.length) {
    if (sepLine[i] === "=") {
      const start = i;
      while (i < sepLine.length && sepLine[i] === "=") i++;
      cols.push({ start, end: i });
    }
    i++;
  }

  function extract(line: string, idx: number): string {
    if (idx >= cols.length) return "";
    return line.substring(cols[idx].start, cols[idx].end).trim();
  }

  const processes: ProcessInfo[] = [];
  for (let j = sepIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim()) continue;

    const imageName = extract(line, 0);
    if (!imageName) continue;

    const memStr = extract(line, 4).replace(/[,.\s]/g, "").replace(/K$/i, "");

    processes.push({
      imageName,
      pid:         parseInt(extract(line, 1)) || 0,
      sessionName: extract(line, 2),
      sessionNum:  parseInt(extract(line, 3)) || 0,
      memUsageKB:  parseInt(memStr) || 0,
      status:      extract(line, 5),
      userName:    extract(line, 6),
      cpuTime:     extract(line, 7),
      windowTitle: extract(line, 8),
    });
  }
  return processes;
}

// ─────────────────────────────────────────────────────────────────────────────
// ipconfig.txt — output of "ipconfig /all"
// ─────────────────────────────────────────────────────────────────────────────

export interface NetworkAdapter {
  adapterName:   string;
  adapterType:   string;   // "Ethernet adapter", "Wireless LAN adapter", etc.
  description:   string;
  macAddress:    string;
  dhcpEnabled:   boolean;
  ipv4Addresses: string[];
  subnetMasks:   string[];
  defaultGateway: string;
  dnsServers:    string[];
  connectionStatus: string;  // "Media disconnected" or "connected" (implied)
}

export interface IpConfigInfo {
  hostname:    string;
  dnsSuffix:   string;
  adapters:    NetworkAdapter[];
}

export function parseIpconfigTxt(text: string): IpConfigInfo {
  const lines = text.split(/\r?\n/);
  let hostname = "";
  let dnsSuffix = "";

  // Global section
  for (const line of lines) {
    const m = line.match(/^\s+Host Name[\s.]*:\s*(.+)/i);
    if (m) { hostname = m[1].trim(); continue; }
    const d = line.match(/^\s+Primary Dns Suffix[\s.]*:\s*(.*)/i);
    if (d) { dnsSuffix = d[1].trim(); }
  }

  // Split into adapter sections
  const adapters: NetworkAdapter[] = [];
  const adapterRe = /^(\w[\w\s]*adapter\s+[^:]+):/im;

  const sections = text.split(adapterRe);
  // sections alternates: preamble, adapterName, body, adapterName, body, ...
  for (let i = 1; i + 1 < sections.length; i += 2) {
    const adapterFull = sections[i].trim();
    const body = sections[i + 1];

    const typeMatch = adapterFull.match(/^(\w[\w\s]*adapter)\s+(.+)/i);
    const adapterType = typeMatch ? typeMatch[1].trim() : "";
    const adapterName = typeMatch ? typeMatch[2].trim() : adapterFull;

    const get = (key: string): string => {
      const re = new RegExp(`^\\s+${key}[\\s.]*:\\s*(.+)`, "im");
      const m = body.match(re);
      return m ? m[1].trim() : "";
    };

    const isDisconnected = /Media disconnected/i.test(body);

    const ipv4: string[] = [];
    const masks: string[] = [];
    const dns: string[] = [];

    // IPv4 addresses — may have multiple
    const ipRe = /IPv4 Address[\s.]*:\s*([\d.]+)/gi;
    let ipM;
    while ((ipM = ipRe.exec(body))) ipv4.push(ipM[1]);
    // Also check "IP Address" (older format)
    const ipRe2 = /IP Address[\s.]*:\s*([\d.]+)/gi;
    while ((ipM = ipRe2.exec(body))) ipv4.push(ipM[1]);

    const maskRe = /Subnet Mask[\s.]*:\s*([\d.]+)/gi;
    while ((ipM = maskRe.exec(body))) masks.push(ipM[1]);

    // DNS servers — first on "DNS Servers" line, subsequent on continuation lines
    const dnsStart = body.match(/DNS Servers[\s.]*:\s*([\d.:a-f]+)/i);
    if (dnsStart) {
      dns.push(dnsStart[1]);
      const dnsIdx = body.indexOf(dnsStart[0]);
      const afterDns = body.substring(dnsIdx + dnsStart[0].length).split(/\r?\n/);
      for (const dl of afterDns) {
        const dm = dl.match(/^\s{20,}([\d.:a-f]+)/);
        if (dm) dns.push(dm[1]);
        else break;
      }
    }

    adapters.push({
      adapterName,
      adapterType,
      description:    get("Description"),
      macAddress:      get("Physical Address"),
      dhcpEnabled:     /yes/i.test(get("DHCP Enabled")),
      ipv4Addresses:   ipv4,
      subnetMasks:     masks,
      defaultGateway:  get("Default Gateway"),
      dnsServers:      dns,
      connectionStatus: isDisconnected ? "Media disconnected" : "Connected",
    });
  }

  return { hostname, dnsSuffix, adapters };
}

// ─────────────────────────────────────────────────────────────────────────────
// netstat.txt — output of "netstat -nao" + "netstat -r"
// ─────────────────────────────────────────────────────────────────────────────

export interface NetConnection {
  protocol:   string;  // TCP or UDP
  localAddr:  string;
  localPort:  number;
  foreignAddr: string;
  foreignPort: number;
  state:      string;
  pid:        number;
}

export interface NetstatInfo {
  connections: NetConnection[];
  /** Listening ports grouped by PID */
  listeners:   NetConnection[];
}

export function parseNetstatTxt(text: string): NetstatInfo {
  const connections: NetConnection[] = [];
  const listeners: NetConnection[] = [];

  // Match lines like: TCP    0.0.0.0:50014    0.0.0.0:0    LISTENING    1234
  const re = /^\s*(TCP|UDP)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\w+)?\s+(\d+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const conn: NetConnection = {
      protocol:    m[1],
      localAddr:   m[2],
      localPort:   parseInt(m[3]),
      foreignAddr: m[4],
      foreignPort: parseInt(m[5]),
      state:       m[6] ?? "",
      pid:         parseInt(m[7]),
    };
    if (conn.state === "LISTENING") {
      listeners.push(conn);
    } else {
      connections.push(conn);
    }
  }
  return { connections, listeners };
}

// ─────────────────────────────────────────────────────────────────────────────
// systeminfo.txt — output of "systeminfo"
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemInfo {
  hostname:       string;
  osName:         string;
  osVersion:      string;
  manufacturer:   string;
  model:          string;
  systemType:     string;
  processors:     string[];
  totalPhysicalMemoryMB: number;
  availablePhysicalMemoryMB: number;
  bootTime:       string;
  installDate:    string;
  hotfixes:       string[];  // KB numbers
  networkCards:   string[];
}

export function parseSysteminfoTxt(text: string): SystemInfo {
  const get = (key: string): string => {
    const re = new RegExp(`^${key}:\\s+(.+)`, "im");
    const m = text.match(re);
    return m ? m[1].trim() : "";
  };

  const parseMB = (s: string): number => {
    const m = s.match(/([\d,]+)\s*MB/i);
    return m ? parseInt(m[1].replace(/,/g, "")) : 0;
  };

  // Processors — multi-line after "Processor(s):"
  const processors: string[] = [];
  const procMatch = text.match(/Processor\(s\):\s+(\d+).*?\n([\s\S]*?)(?=\n\S|\n\s*$)/i);
  if (procMatch) {
    const procLines = procMatch[2].split(/\r?\n/);
    for (const pl of procLines) {
      const pm = pl.match(/\[\d+\]:\s*(.+)/);
      if (pm) processors.push(pm[1].trim());
    }
  }

  // Hotfixes
  const hotfixes: string[] = [];
  const hfMatch = text.match(/Hotfix\(s\):\s+(\d+).*?\n([\s\S]*?)(?=\n\S|\n\s*$)/i);
  if (hfMatch) {
    const hfLines = hfMatch[2].split(/\r?\n/);
    for (const hl of hfLines) {
      const hm = hl.match(/\[\d+\]:\s*(KB\d+)/i);
      if (hm) hotfixes.push(hm[1]);
    }
  }

  // Network cards
  const networkCards: string[] = [];
  const ncMatch = text.match(/Network Card\(s\):\s+(\d+).*?\n([\s\S]*?)$/i);
  if (ncMatch) {
    const ncLines = ncMatch[2].split(/\r?\n/);
    for (const nl of ncLines) {
      const nm = nl.match(/\[\d+\]:\s*(.+)/);
      if (nm) networkCards.push(nm[1].trim());
    }
  }

  return {
    hostname:                get("Host Name"),
    osName:                  get("OS Name"),
    osVersion:               get("OS Version"),
    manufacturer:            get("System Manufacturer"),
    model:                   get("System Model"),
    systemType:              get("System Type"),
    processors,
    totalPhysicalMemoryMB:   parseMB(get("Total Physical Memory")),
    availablePhysicalMemoryMB: parseMB(get("Available Physical Memory")),
    bootTime:                get("System Boot Time"),
    installDate:             get("Original Install Date"),
    hotfixes,
    networkCards,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EventLogApplication.txt / EventLogSystem.txt
// ─────────────────────────────────────────────────────────────────────────────

export interface EventLogEntry {
  timestamp:   string;
  level:       string;   // Error, Warning, Information
  source:      string;
  eventId:     number;
  message:     string;
}

/**
 * EventType numeric values from Windows Event Log API, as written by
 * Symphony's custom EventViewerConsole.exe (_Tools/EventViewerConsole.exe).
 */
const EVENT_TYPE_MAP: Record<number, string> = {
  1: "Error",
  2: "Warning",
  4: "Information",
  8: "AuditSuccess",
  16: "AuditFailure",
};

/**
 * Parse Windows Event Log text export from EventViewerConsole.exe.
 *
 * Verified format (from LogPackage.cs → EventViewerConsole.exe "Application 14"):
 *
 *   2026/03/08 10:34:21 ID: 0x0000000B EventType:  4 Source: docker
 *           String1: sending event String2: module=libcontainerd ...
 *
 * Each entry starts with a timestamp line containing hex ID, numeric EventType,
 * and source name. Continuation lines are tab-indented and contain StringN:
 * insertion strings. Entries are in reverse chronological order.
 */
export function parseEventLogTxt(text: string): EventLogEntry[] {
  const entries: EventLogEntry[] = [];
  const lines = text.split(/\r?\n/);

  // Primary format: EventViewerConsole.exe output
  // Line 1: yyyy/MM/dd HH:mm:ss ID: 0xHEX EventType:  N Source: <name>
  // Line 2+: \tStringN: <text> (continuation, may be on same line or next)
  const headerRe = /^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+ID:\s*(0x[0-9a-fA-F]+)\s+EventType:\s*(\d+)\s+Source:\s*(.+)/;

  let i = 0;
  while (i < lines.length) {
    const hm = headerRe.exec(lines[i]);
    if (!hm) { i++; continue; }

    const timestamp = hm[1];
    const eventIdHex = hm[2];
    const eventType = parseInt(hm[3]);
    const source = hm[4].trim();

    // Collect continuation lines (tab-indented StringN: lines)
    const msgParts: string[] = [];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      // Continuation lines start with tab or spaces and contain StringN:
      if (/^[\t ]/.test(line) && !headerRe.test(line)) {
        // Extract string values, stripping the StringN: prefix
        const cleaned = line.replace(/^\s+/, "").replace(/String\d+:\s*/g, "");
        if (cleaned.trim()) msgParts.push(cleaned.trim());
        i++;
      } else {
        break;
      }
    }

    entries.push({
      timestamp,
      source,
      eventId:   parseInt(eventIdHex, 16),
      level:     EVENT_TYPE_MAP[eventType] ?? `Type${eventType}`,
      message:   msgParts.join(" ").substring(0, 1000),
    });
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// license.txt — Symphony licensing status report
// ─────────────────────────────────────────────────────────────────────────────

export interface LicenseInfo {
  /** Raw key-value pairs extracted from the license report */
  fields: Record<string, string>;
  /** Quick summary line */
  summary: string;
}

/**
 * Parse license.txt — Symphony licensing status report.
 *
 * Verified format: generated by LicensingStatusReportWriter.WriteReport()
 * (Xnet.Server/Registration/LicensingStatusReportWriter.cs).
 *
 * Multi-section report containing:
 *   1. Server Registration table (ID, Machine Name, OS Key, DSN, MACs)
 *   2. License Information (farm, security ID, version, trial, periods, registered servers/MACs)
 *   3. Included Licenses (counts by type with capabilities)
 *   4. Current License Allocations (device, VMS flag, requested vs allocated)
 *   5. Raw License and Registration Data (XML profiles, redacted license text)
 *
 * Uses "Key : Value" format for many fields, plus custom tables.
 */
export function parseLicenseTxt(text: string): LicenseInfo {
  const fields: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  // Extract key-value pairs (supports "Key : Value" and "Key: Value")
  for (const line of lines) {
    const m = line.match(/^\s*(.+?)\s*:\s+(.+)/);
    if (m && !m[1].startsWith("---") && !m[1].startsWith("===")) {
      const key = m[1].trim();
      // Skip table header-like lines and XML
      if (key.includes("<") || key.includes(">") || key.length > 40) continue;
      fields[key] = m[2].trim();
    }
  }

  // Extract license counts from "N <Type> license(s)" lines
  const licenseCounts: string[] = [];
  for (const line of lines) {
    const lm = line.match(/^\s*(\d+)\s+(.+?)\s+license\(s\)/i);
    if (lm) {
      licenseCounts.push(`${lm[1]} ${lm[2]}`);
    }
  }

  // Detect trial vs full
  const trialLine = lines.find(l => /Trial License\s*:/i.test(l));
  const isTrial = trialLine ? /True/i.test(trialLine) : false;

  // Build summary from verified field names
  const parts: string[] = [];
  if (isTrial) parts.push("TRIAL");
  if (fields["License version"]) parts.push(`v${fields["License version"]}`);
  if (fields["Software version"]) parts.push(`Build ${fields["Software version"]}`);
  if (licenseCounts.length > 0) parts.push(licenseCounts.join(", "));
  if (fields["License Period"]) parts.push(`Period: ${fields["License Period"]}`);
  if (fields["Maintenance Period"]) parts.push(`Maintenance: ${fields["Maintenance Period"]}`);

  // Check validation status
  const validIdx = lines.findIndex(l => /License Validation Status/i.test(l));
  if (validIdx >= 0) {
    for (let i = validIdx + 1; i < Math.min(validIdx + 5, lines.length); i++) {
      const t = lines[i].trim();
      if (t && !t.startsWith("---")) {
        parts.push(`Status: ${t}`);
        break;
      }
    }
  }

  return {
    fields,
    summary: parts.join(" | ") || "License info available (see raw fields)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// dir.txt — directory listing from GenerateFileList
// ─────────────────────────────────────────────────────────────────────────────

export interface DirEntry {
  sizeMB:     number;
  modified:   string;
  version:    string;
  path:       string;
}

/**
 * Parse dir.txt generated by LogPackage.cs GenerateFileList().
 *
 * Verified format (from LogPackage.cs GetFileSummary):
 *   sLength.PadLeft(8) + " " + lastWriteTime("yyyy/MM/dd HH:mm:ss") + " " + version.PadRight(16) + " " + fullPath
 *
 * Size uses human-readable format from GetFileSizeText():
 *   ≥ 9 MB → "N MB"  (e.g. "   3 MB")
 *   ≥ 9 KB → "N KB"  (e.g. "  42 KB")
 *   < 9 KB → "N  B"  (e.g. "8,192  B")  — two spaces before B
 *
 * Examples:
 *      3 MB 2026/02/15 09:22:41 7.3.2.1          C:\Program Files\Symphony\InfoService.exe
 *    42 KB 2026/02/15 09:22:41                  C:\Program Files\Symphony\config.xml
 *  8,192  B 2026/01/10 14:05:00                  C:\Program Files\Symphony\data.dat
 */
export function parseDirTxt(text: string): { totalFiles: number; totalSizeMB: number; entries: DirEntry[] } {
  const entries: DirEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    // Match the verified format: size(padleft 8) + space + yyyy/MM/dd HH:mm:ss + space + version(padright 16) + space + path
    // Size patterns: "   3 MB", "  42 KB", "8,192  B", or error messages
    const m = line.match(/^\s*([\d,]+)\s*(MB|KB|B)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.{16})\s*(.*)/)
           || line.match(/^\s*([\d,]+)\s*(MB|KB|B)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)/); // short version line
    if (m) {
      const sizeNum = parseInt(m[1].replace(/,/g, "")) || 0;
      const sizeUnit = m[2];
      let sizeMB: number;
      if (sizeUnit === "MB") sizeMB = sizeNum;
      else if (sizeUnit === "KB") sizeMB = Math.round(sizeNum / 1024 * 100) / 100;
      else sizeMB = Math.round(sizeNum / 1048576 * 100) / 100; // bytes

      const modified = m[3];
      // In the 5-group match, group 4 is the 16-char version field, group 5 is the path
      // In the 4-group match, group 4 is everything after the timestamp
      let version: string;
      let filePath: string;
      if (m[5] !== undefined) {
        version = m[4].trim();
        filePath = m[5].trim();
      } else {
        // Try to split the remainder into version + path
        const rem = m[4];
        const verMatch = rem.match(/^([\d.]+\s+)(.+)/);
        if (verMatch) {
          version = verMatch[1].trim();
          filePath = verMatch[2].trim();
        } else {
          version = "";
          filePath = rem.trim();
        }
      }

      if (filePath) {
        entries.push({ sizeMB, modified, version, path: filePath });
      }
    }
  }

  const totalSizeMB = Math.round(entries.reduce((s, e) => s + e.sizeMB, 0) * 100) / 100;
  return { totalFiles: entries.length, totalSizeMB, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// environment.txt — output of "set"
// ─────────────────────────────────────────────────────────────────────────────

export function parseEnvironmentTxt(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      env[line.substring(0, eq)] = line.substring(eq + 1);
    }
  }
  return env;
}

// ─────────────────────────────────────────────────────────────────────────────
// db.txt — table list with row counts
// ─────────────────────────────────────────────────────────────────────────────

export interface DbTableSummary {
  tableName: string;
  rowCount:  number;
}

/**
 * Parse db.txt — table list with row counts.
 *
 * Verified format: generated by LogPackageDAL.GenerateLogPackageDatabaseTables()
 * using DataTable.WriteTable() (DataTableExtensions.cs) with columns "Tbl" and "Count".
 *
 * Output looks like:
 *   Tbl                                      Count
 *   ---------------------------------------- -----
 *   Device                                   42
 *   DeviceGroup                              5
 *   Settings                                 1823
 *
 * We skip the header row ("Tbl" and "Count") and the dash separator line.
 */
export function parseDbTxt(text: string): DbTableSummary[] {
  const tables: DbTableSummary[] = [];
  const lines = text.split(/\r?\n/);
  let pastHeader = false;

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Skip header line (contains "Tbl" and "Count")
    if (/^\s*Tbl\s+Count/i.test(line)) {
      continue;
    }

    // Skip dash separator line
    if (/^\s*-+\s+-+/.test(line)) {
      pastHeader = true;
      continue;
    }

    // Data rows: table name followed by row count
    const m = line.match(/^\s*(\S+)\s+(\d+)\s*$/);
    if (m) {
      tables.push({ tableName: m[1], rowCount: parseInt(m[2]) });
    }
  }
  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// TableSettings.xml — full Settings table serialised by XmlSerializer
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsEntry {
  type:    string;
  id:      string;
  section: string;
  key:     string;
  value:   string;
}

/**
 * Parse TableSettings.xml — the full Settings table serialised by C# XmlSerializer.
 *
 * Verified format (from LogPackage.cs → XmlSerializer on CSetting[]):
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <ArrayOfCSetting xmlns:xsi="..." xmlns:xsd="...">
 *     <CSetting xmlns="http://schemas.aimetis.com/SharedTypes">
 *       <Type>Server</Type>
 *       <Section>General</Section>
 *       <ID>1</ID>
 *       <Key>SomeKey</Key>
 *       <Value>SomeValue</Value>
 *       <IsDeleted>false</IsDeleted>
 *       <SequenceID>42</SequenceID>
 *       <UniqueID>-1</UniqueID>
 *     </CSetting>
 *   </ArrayOfCSetting>
 *
 * CSetting class is at BaseLibCS/CSetting.cs with [XmlType(Namespace = "http://schemas.aimetis.com/SharedTypes")].
 * We use simple regex rather than a full XML parser to avoid a dependency.
 */
export function parseTableSettingsXml(text: string): SettingsEntry[] {
  const entries: SettingsEntry[] = [];

  // Each setting is wrapped in a <CSetting> element
  const rowRe = /<CSetting[^>]*>([\s\S]*?)<\/CSetting>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(text))) {
    const row = rowMatch[1];
    const get = (tag: string): string => {
      const m = row.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };

    // CSetting properties: Type, Section, ID, Key, Value, IsDeleted, SequenceID, UniqueID
    const key = get("Key");
    const value = get("Value");
    const isDeleted = get("IsDeleted");

    // Skip deleted settings
    if (isDeleted.toLowerCase() === "true") continue;
    if (!key && !value) continue;

    entries.push({
      type:    get("Type"),
      id:      get("ID"),
      section: get("Section"),
      key,
      value,
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: read a file with graceful failure
// ─────────────────────────────────────────────────────────────────────────────

export async function readFileOrNull(filePath: string | undefined): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
