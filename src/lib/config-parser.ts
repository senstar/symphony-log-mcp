/**
 * config-parser.ts
 *
 * Parse hardware and system configuration from Symphony bug report files.
 * Extracts CPU, RAM, OS, disk, NIC, and Symphony service info from
 * serverinfo.txt blocks and other configuration files in bug reports.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BugReport } from "./bug-report.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DiskInfo {
  drive: string;
  label: string;
  totalGB: number;
  freeGB: number;
  usedPercent: number;
}

export interface NicInfo {
  name: string;
  speedMbps: number;
  ipAddresses: string[];
  status: string;
}

export interface ServerHardware {
  serverName: string;
  serverIp: string;
  isMaster: boolean;

  // OS
  osVersion: string;
  osBuild: string;

  // CPU
  cpuModel: string;
  cpuCores: number;
  cpuLogicalProcessors: number;

  // Memory
  totalRamGB: number;
  availableRamGB: number;

  // Disks
  disks: DiskInfo[];

  // Network
  nics: NicInfo[];

  // Symphony
  symphonyVersion: string;
  serviceAccount: string;
  installPath: string;
  databaseServer: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

function getField(body: string, key: string): string {
  const re = new RegExp(`^\\s*${key}\\s*[:=]\\s*(.*)$`, "im");
  const m = re.exec(body);
  return m ? m[1].trim() : "";
}

function getNumber(body: string, key: string): number {
  const v = getField(body, key);
  const n = parseFloat(v.replace(/[,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseDisks(body: string): DiskInfo[] {
  const disks: DiskInfo[] = [];
  // Match lines like: "C: (System)  Total: 237.9 GB  Free: 112.3 GB (47%)"
  // or "D:  Total: 1863.0 GB  Free: 891.2 GB"
  const re = /([A-Z]):\s*(?:\(([^)]*)\))?\s*Total:\s*([\d.]+)\s*GB\s*Free:\s*([\d.]+)\s*GB(?:\s*\((\d+)%\))?/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const totalGB = parseFloat(m[3]);
    const freeGB = parseFloat(m[4]);
    disks.push({
      drive: m[1] + ":",
      label: m[2] ?? "",
      totalGB,
      freeGB,
      usedPercent: m[5] ? parseInt(m[5]) : Math.round(((totalGB - freeGB) / totalGB) * 100),
    });
  }
  return disks;
}

function parseNics(body: string): NicInfo[] {
  const nics: NicInfo[] = [];
  // Look for NIC blocks — format varies, common patterns:
  // "Ethernet0 — 1000 Mbps — 10.60.31.4 — Up"
  // "NIC: Intel I350  Speed: 1000 Mbps  IP: 10.60.31.4  Status: Up"
  const nicRe = /(?:NIC|Adapter|Ethernet\d*|Intel|Broadcom)[^\n]*?(\d+)\s*Mbps[^\n]*?((?:\d{1,3}\.){3}\d{1,3})/gi;
  let m;
  while ((m = nicRe.exec(body)) !== null) {
    nics.push({
      name: m[0].split(/\s*[-—]\s*/)[0]?.trim() ?? "NIC",
      speedMbps: parseInt(m[1]),
      ipAddresses: [m[2]],
      status: /Up|Connected/i.test(m[0]) ? "Up" : "Unknown",
    });
  }
  return nics;
}

/**
 * Parse a single server info block into hardware details.
 */
function parseServerBlock(name: string, ip: string, isMaster: boolean, body: string): ServerHardware {
  return {
    serverName: name,
    serverIp: ip,
    isMaster,

    osVersion: getField(body, "OS Version") || getField(body, "Operating System") || getField(body, "OS"),
    osBuild: getField(body, "OS Build") || getField(body, "Build"),

    cpuModel: getField(body, "CPU") || getField(body, "Processor"),
    cpuCores: getNumber(body, "Cores") || getNumber(body, "Physical Cores") || getNumber(body, "CPU Cores"),
    cpuLogicalProcessors: getNumber(body, "Logical Processors") || getNumber(body, "Logical CPUs"),

    totalRamGB: getNumber(body, "Total RAM") || getNumber(body, "Total Memory") || getNumber(body, "RAM"),
    availableRamGB: getNumber(body, "Available RAM") || getNumber(body, "Free Memory") || getNumber(body, "Available Memory"),

    disks: parseDisks(body),
    nics: parseNics(body),

    symphonyVersion: getField(body, "Product Version") || getField(body, "Symphony Version"),
    serviceAccount: getField(body, "Service Account") || getField(body, "Run As"),
    installPath: getField(body, "Install Path") || getField(body, "Installation Path"),
    databaseServer: getField(body, "Database Server") || getField(body, "SQL Server") || getField(body, "DB Server"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse serverinfo.txt into an array of ServerHardware records.
 */
export function parseServerInfoForHardware(text: string): ServerHardware[] {
  const results: ServerHardware[] = [];

  // Split on block headers: "--- Server Info (NAME) ---"
  const parts = text.split(/---\s*Server Info\s*\(([^)]+)\)\s*---/i);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    const body = parts[i + 1] ?? "";

    // Find the IP for this server
    const thisServerLine = /IP:\s*([\d.]+)[^\n]*?\(This Server\)/i.exec(body);
    const ip = thisServerLine?.[1] ?? "";
    const isMaster = /\(Master\)/i.test(body.split("\n").find(l => /This Server/i.test(l)) ?? "");

    results.push(parseServerBlock(name, ip, isMaster, body));
  }
  return results;
}

/**
 * Read and parse hardware config from a bug report.
 */
export async function getHardwareConfig(bugReportPath: string): Promise<ServerHardware[]> {
  try {
    const text = await fs.readFile(path.join(bugReportPath, "serverinfo.txt"), "utf8");
    return parseServerInfoForHardware(text);
  } catch {
    return [];
  }
}

/**
 * Format hardware info as human-readable text.
 */
export function formatHardwareConfig(servers: ServerHardware[]): string {
  if (servers.length === 0) return "No hardware configuration available.";

  const out: string[] = [`Hardware Configuration — ${servers.length} server(s)`, ""];

  for (const s of servers) {
    out.push(`═══════════════════════════════════════════════════`);
    out.push(`Server: ${s.serverName}${s.isMaster ? " [MASTER]" : ""}  IP: ${s.serverIp}`);
    out.push(`═══════════════════════════════════════════════════`);

    if (s.osVersion) out.push(`  OS:       ${s.osVersion}${s.osBuild ? ` (Build ${s.osBuild})` : ""}`);
    if (s.cpuModel)  out.push(`  CPU:      ${s.cpuModel}`);
    if (s.cpuCores)  out.push(`  Cores:    ${s.cpuCores} physical${s.cpuLogicalProcessors ? `, ${s.cpuLogicalProcessors} logical` : ""}`);
    if (s.totalRamGB) {
      const availStr = s.availableRamGB ? ` (${s.availableRamGB.toFixed(1)} GB available)` : "";
      out.push(`  RAM:      ${s.totalRamGB.toFixed(1)} GB${availStr}`);
    }

    if (s.disks.length > 0) {
      out.push(`  Disks:`);
      for (const d of s.disks) {
        const label = d.label ? ` (${d.label})` : "";
        out.push(`    ${d.drive}${label}  ${d.totalGB.toFixed(1)} GB total, ${d.freeGB.toFixed(1)} GB free (${d.usedPercent}% used)`);
      }
    }

    if (s.nics.length > 0) {
      out.push(`  NICs:`);
      for (const n of s.nics) {
        out.push(`    ${n.name} — ${n.speedMbps} Mbps — ${n.ipAddresses.join(", ")} — ${n.status}`);
      }
    }

    if (s.symphonyVersion) out.push(`  Symphony: ${s.symphonyVersion}`);
    if (s.installPath)     out.push(`  Install:  ${s.installPath}`);
    if (s.serviceAccount)  out.push(`  Service:  ${s.serviceAccount}`);
    if (s.databaseServer)  out.push(`  Database: ${s.databaseServer}`);

    // Warnings
    if (s.totalRamGB > 0 && s.totalRamGB < 8) {
      out.push(`  ⚠ LOW RAM: ${s.totalRamGB.toFixed(1)} GB — minimum recommended is 8 GB`);
    }
    for (const d of s.disks) {
      if (d.usedPercent >= 90) {
        out.push(`  ⚠ DISK ${d.drive} ${d.usedPercent}% full — only ${d.freeGB.toFixed(1)} GB free`);
      }
    }

    out.push("");
  }

  return out.join("\n");
}
