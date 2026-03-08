/**
 * system-diagnostics.ts
 *
 * Analyse the supplementary diagnostic files from a Symphony bug report
 * server zip: services, processes, network config, installed files,
 * environment variables, license info, and system details.
 *
 * These files are the output of Windows commands (sc, tasklist, ipconfig,
 * netstat, systeminfo, set) and Symphony utilities (printshmem) that
 * LogPackage.cs captures alongside the log files.
 */

import type { BugReport, ServerExtras } from "../lib/bug-report.js";
import {
  parseServicesTxt,
  parseTasklistTxt,
  parseIpconfigTxt,
  parseNetstatTxt,
  parseSysteminfoTxt,
  parseLicenseTxt,
  parseDirTxt,
  parseEnvironmentTxt,
  parseDbTxt,
  readFileOrNull,
  type WindowsService,
  type ProcessInfo,
} from "../lib/system-info-parser.js";
import { isSymphonyService } from "../lib/symphony-patterns.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemDiagArgs {
  mode:
    | "overview"      // combined summary across all servers
    | "services"      // Windows services (sc queryex)
    | "processes"     // Running processes (tasklist /V)
    | "network"       // ipconfig + netstat
    | "environment"   // Environment variables
    | "license"       // License info
    | "files"         // Install directory listing
    | "db_summary"    // Database table list with row counts
    | "raw";          // Dump a specific supplementary file as-is

  /** For services: filter by service name substring */
  filter?: string;

  /** For services: only show Symphony-related services */
  symphonyOnly?: boolean;

  /** For processes: sort by memory (default) or cpu */
  sortBy?: "memory" | "cpu" | "name";

  /** For network: filter by port number */
  port?: number;

  /** For raw: which file to dump */
  file?: string;

  limit?: number;
}

// Symphony service patterns imported from ../lib/symphony-patterns.ts

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function toolSystemDiag(
  bugReport: BugReport | null,
  args: SystemDiagArgs,
): Promise<string> {
  if (!bugReport) {
    return "System diagnostics require a bug report package (not a plain log directory). " +
           "These files (services.txt, tasklist.txt, etc.) are only present in bug report server zips.";
  }

  const servers = bugReport.servers.filter(s => !s.isClient && s.extras);
  if (servers.length === 0) {
    return "No server data with supplementary files found in this bug report.";
  }

  const { mode } = args;
  const limit = args.limit ?? 100;

  switch (mode) {
    case "overview":
      return await renderOverview(servers.map(s => ({ label: s.label, extras: s.extras! })));

    case "services":
      return await renderServices(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
        args.filter,
        args.symphonyOnly ?? false,
        limit,
      );

    case "processes":
      return await renderProcesses(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
        args.filter,
        args.sortBy ?? "memory",
        limit,
      );

    case "network":
      return await renderNetwork(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
        args.port,
        limit,
      );

    case "environment":
      return await renderEnvironment(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
        args.filter,
      );

    case "license":
      return await renderLicense(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
      );

    case "files":
      return await renderFiles(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
        args.filter,
        limit,
      );

    case "db_summary":
      return await renderDbSummary(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
      );

    case "raw":
      return await renderRaw(
        servers.map(s => ({ label: s.label, extras: s.extras! })),
        args.file,
        limit,
      );

    default:
      throw new Error(`sym_system: unknown mode '${mode}'`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────

type ServerCtx = { label: string; extras: ServerExtras };

async function renderOverview(servers: ServerCtx[]): Promise<string> {
  const out: string[] = [`System Diagnostics Overview — ${servers.length} server(s)\n`];

  for (const srv of servers) {
    out.push(`\n═══ ${srv.label} ═══`);

    // systeminfo
    const sysText = await readFileOrNull(srv.extras.systeminfoTxt);
    if (sysText) {
      const si = parseSysteminfoTxt(sysText);
      out.push(`  OS:          ${si.osName} ${si.osVersion}`);
      out.push(`  Hardware:    ${si.manufacturer} ${si.model} (${si.systemType})`);
      if (si.processors.length) out.push(`  CPU:         ${si.processors[0]}`);
      out.push(`  RAM:         ${si.totalPhysicalMemoryMB} MB total, ${si.availablePhysicalMemoryMB} MB free`);
      out.push(`  Boot:        ${si.bootTime}`);
      out.push(`  Hotfixes:    ${si.hotfixes.length} installed`);
    }

    // services — Symphony only
    const svcText = await readFileOrNull(srv.extras.servicesTxt);
    if (svcText) {
      const svcs = parseServicesTxt(svcText);
      const symSvcs = svcs.filter(s => isSymphonyService(s.serviceName, s.displayName));
      const running = symSvcs.filter(s => s.state === "RUNNING");
      const stopped = symSvcs.filter(s => s.state === "STOPPED");
      out.push(`  Symphony Services: ${running.length} running, ${stopped.length} stopped`);
      if (stopped.length > 0) {
        out.push(`    STOPPED: ${stopped.map(s => s.serviceName).join(", ")}`);
      }
    }

    // network — listening ports
    const nsText = await readFileOrNull(srv.extras.netstatTxt);
    if (nsText) {
      const ns = parseNetstatTxt(nsText);
      const knownPorts = [50000, 50001, 50002, 50014, 5432, 3306, 554, 8443];
      const listening = ns.listeners.filter(l => knownPorts.includes(l.localPort));
      if (listening.length > 0) {
        out.push(`  Key Ports:   ${listening.map(l => `${l.localPort}/${l.protocol}`).join(", ")}`);
      }
      out.push(`  Connections: ${ns.connections.length} active, ${ns.listeners.length} listening`);
    }

    // license
    const licText = await readFileOrNull(srv.extras.licenseTxt);
    if (licText) {
      const lic = parseLicenseTxt(licText);
      out.push(`  License:     ${lic.summary}`);
    }

    // db summary
    const dbText = await readFileOrNull(srv.extras.dbTxt);
    if (dbText) {
      const tables = parseDbTxt(dbText);
      const totalRows = tables.reduce((s, t) => s + t.rowCount, 0);
      out.push(`  Database:    ${tables.length} tables, ${totalRows.toLocaleString()} total rows`);
    }

    // Available supplementary files
    const available: string[] = [];
    if (srv.extras.servicesTxt) available.push("services");
    if (srv.extras.tasklistTxt) available.push("tasklist");
    if (srv.extras.ipconfigTxt) available.push("ipconfig");
    if (srv.extras.netstatTxt) available.push("netstat");
    if (srv.extras.systeminfoTxt) available.push("systeminfo");
    if (srv.extras.environmentTxt) available.push("environment");
    if (srv.extras.eventLogAppTxt) available.push("eventlog-app");
    if (srv.extras.eventLogSysTxt) available.push("eventlog-sys");
    if (srv.extras.licenseTxt) available.push("license");
    if (srv.extras.dirTxt) available.push("dir");
    if (srv.extras.dbTxt) available.push("db");
    if (srv.extras.tableSettingsXml) available.push("settings.xml");
    if (srv.extras.printshmemTxt) available.push("printshmem");
    if (srv.extras.tableFiles?.length) available.push(`${srv.extras.tableFiles.length} table dumps`);
    out.push(`  Files:       ${available.join(", ")}`);
  }

  return out.join("\n");
}

async function renderServices(
  servers: ServerCtx[], filter?: string, symphonyOnly = false, limit = 100,
): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    const text = await readFileOrNull(srv.extras.servicesTxt);
    if (!text) { out.push(`${srv.label}: services.txt not available`); continue; }

    let svcs = parseServicesTxt(text);

    if (symphonyOnly) {
      svcs = svcs.filter(s => isSymphonyService(s.serviceName, s.displayName));
    }
    if (filter) {
      const f = filter.toLowerCase();
      svcs = svcs.filter(s =>
        s.serviceName.toLowerCase().includes(f) ||
        s.displayName.toLowerCase().includes(f)
      );
    }

    out.push(`\n═══ ${srv.label} — ${svcs.length} service(s) ═══\n`);
    const display = svcs.slice(0, limit);
    for (const s of display) {
      const pid = s.pid ? ` PID=${s.pid}` : "";
      out.push(`  ${s.state.padEnd(10)} ${s.serviceName.padEnd(35)} ${s.displayName}${pid}`);
    }
    if (svcs.length > limit) out.push(`  ... and ${svcs.length - limit} more`);
  }

  return out.join("\n");
}

async function renderProcesses(
  servers: ServerCtx[], filter?: string, sortBy = "memory", limit = 100,
): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    const text = await readFileOrNull(srv.extras.tasklistTxt);
    if (!text) { out.push(`${srv.label}: tasklist.txt not available`); continue; }

    let procs = parseTasklistTxt(text);

    if (filter) {
      const f = filter.toLowerCase();
      procs = procs.filter(p => p.imageName.toLowerCase().includes(f));
    }

    if (sortBy === "memory") {
      procs.sort((a, b) => b.memUsageKB - a.memUsageKB);
    } else if (sortBy === "name") {
      procs.sort((a, b) => a.imageName.localeCompare(b.imageName));
    }

    out.push(`\n═══ ${srv.label} — ${procs.length} process(es) ═══\n`);
    const display = procs.slice(0, limit);
    for (const p of display) {
      const memMB = Math.round(p.memUsageKB / 1024);
      out.push(`  PID=${String(p.pid).padEnd(7)} ${p.imageName.padEnd(35)} ${String(memMB).padStart(6)} MB  ${p.cpuTime}  ${p.userName}`);
    }
    if (procs.length > limit) out.push(`  ... and ${procs.length - limit} more`);
  }

  return out.join("\n");
}

async function renderNetwork(
  servers: ServerCtx[], portFilter?: number, limit = 100,
): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    out.push(`\n═══ ${srv.label} ═══`);

    // ipconfig
    const ipText = await readFileOrNull(srv.extras.ipconfigTxt);
    if (ipText) {
      const ip = parseIpconfigTxt(ipText);
      out.push(`\n  Hostname: ${ip.hostname}`);
      if (ip.dnsSuffix) out.push(`  DNS Suffix: ${ip.dnsSuffix}`);
      out.push(`  Adapters: ${ip.adapters.length}`);
      for (const a of ip.adapters) {
        const ips = a.ipv4Addresses.join(", ") || "(none)";
        out.push(`    ${a.adapterName}: ${ips} [${a.connectionStatus}]`);
        if (a.defaultGateway) out.push(`      Gateway: ${a.defaultGateway}`);
        if (a.dnsServers.length) out.push(`      DNS: ${a.dnsServers.join(", ")}`);
      }
    }

    // netstat
    const nsText = await readFileOrNull(srv.extras.netstatTxt);
    if (nsText) {
      const ns = parseNetstatTxt(nsText);

      let listeners = ns.listeners;
      let connections = ns.connections;

      if (portFilter) {
        listeners = listeners.filter(l => l.localPort === portFilter);
        connections = connections.filter(c =>
          c.localPort === portFilter || c.foreignPort === portFilter
        );
      }

      out.push(`\n  Listening Ports (${listeners.length}):`);
      const displayL = listeners.slice(0, limit);
      for (const l of displayL) {
        out.push(`    ${l.protocol.padEnd(5)} ${l.localAddr}:${l.localPort}  PID=${l.pid}`);
      }

      if (!portFilter) {
        // Summarise connections by state
        const byState = new Map<string, number>();
        for (const c of connections) {
          byState.set(c.state, (byState.get(c.state) ?? 0) + 1);
        }
        const stateStr = [...byState.entries()]
          .map(([s, n]) => `${s}=${n}`)
          .join(", ");
        out.push(`\n  Active Connections: ${connections.length} (${stateStr})`);
      } else {
        out.push(`\n  Connections on port ${portFilter}: ${connections.length}`);
        for (const c of connections.slice(0, limit)) {
          out.push(`    ${c.protocol} ${c.localAddr}:${c.localPort} → ${c.foreignAddr}:${c.foreignPort} ${c.state} PID=${c.pid}`);
        }
      }
    }
  }

  return out.join("\n");
}

async function renderEnvironment(servers: ServerCtx[], filter?: string): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    const text = await readFileOrNull(srv.extras.environmentTxt);
    if (!text) { out.push(`${srv.label}: environment.txt not available`); continue; }

    const env = parseEnvironmentTxt(text);
    let entries = Object.entries(env);

    if (filter) {
      const f = filter.toLowerCase();
      entries = entries.filter(([k, v]) =>
        k.toLowerCase().includes(f) || v.toLowerCase().includes(f)
      );
    }

    out.push(`\n═══ ${srv.label} — ${entries.length} variable(s) ═══\n`);
    for (const [k, v] of entries) {
      out.push(`  ${k}=${v}`);
    }
  }

  return out.join("\n");
}

async function renderLicense(servers: ServerCtx[]): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    out.push(`\n═══ ${srv.label} ═══`);

    const licText = await readFileOrNull(srv.extras.licenseTxt);
    if (licText) {
      const lic = parseLicenseTxt(licText);
      out.push(`\n  Summary: ${lic.summary}\n`);
      for (const [k, v] of Object.entries(lic.fields)) {
        out.push(`  ${k}: ${v}`);
      }
    } else {
      out.push("  license.txt not available");
    }

    const shmText = await readFileOrNull(srv.extras.printshmemTxt);
    if (shmText) {
      out.push("\n  Shared Memory (printshmem):");
      const lines = shmText.split(/\r?\n/).filter(l => l.trim()).slice(0, 30);
      for (const l of lines) out.push(`    ${l}`);
    }
  }

  return out.join("\n");
}

async function renderFiles(
  servers: ServerCtx[], filter?: string, limit = 100,
): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    const text = await readFileOrNull(srv.extras.dirTxt);
    if (!text) { out.push(`${srv.label}: dir.txt not available`); continue; }

    const dir = parseDirTxt(text);
    let entries = dir.entries;

    if (filter) {
      const f = filter.toLowerCase();
      entries = entries.filter(e => e.path.toLowerCase().includes(f));
    }

    out.push(`\n═══ ${srv.label} — ${dir.totalFiles} files, ${dir.totalSizeMB} MB total ═══\n`);
    const display = entries.slice(0, limit);
    for (const e of display) {
      const ver = e.version ? `  v${e.version}` : "";
      out.push(`  ${String(e.sizeMB).padStart(8)} MB  ${e.modified}${ver}  ${e.path}`);
    }
    if (entries.length > limit) out.push(`  ... and ${entries.length - limit} more`);
  }

  return out.join("\n");
}

async function renderDbSummary(servers: ServerCtx[]): Promise<string> {
  const out: string[] = [];

  for (const srv of servers) {
    const text = await readFileOrNull(srv.extras.dbTxt);
    if (!text) { out.push(`${srv.label}: db.txt not available`); continue; }

    const tables = parseDbTxt(text);
    tables.sort((a, b) => b.rowCount - a.rowCount);
    const totalRows = tables.reduce((s, t) => s + t.rowCount, 0);

    out.push(`\n═══ ${srv.label} — ${tables.length} tables, ${totalRows.toLocaleString()} total rows ═══\n`);
    for (const t of tables) {
      out.push(`  ${t.tableName.padEnd(40)} ${t.rowCount.toLocaleString().padStart(10)} rows`);
    }
  }

  return out.join("\n");
}

async function renderRaw(
  servers: ServerCtx[], fileName?: string, limit = 200,
): Promise<string> {
  if (!fileName) {
    // List available raw files
    const out: string[] = ["Available supplementary files:\n"];
    const fileKeys: (keyof ServerExtras)[] = [
      "servicesTxt", "tasklistTxt", "ipconfigTxt", "netstatTxt",
      "systeminfoTxt", "environmentTxt", "printshmemTxt",
      "eventLogAppTxt", "eventLogSysTxt", "licenseTxt",
      "dirTxt", "dbTxt", "tableSettingsXml",
    ];
    const nameMap: Record<string, string> = {
      servicesTxt: "services", tasklistTxt: "tasklist", ipconfigTxt: "ipconfig",
      netstatTxt: "netstat", systeminfoTxt: "systeminfo", environmentTxt: "environment",
      printshmemTxt: "printshmem", eventLogAppTxt: "eventlog-app",
      eventLogSysTxt: "eventlog-sys", licenseTxt: "license",
      dirTxt: "dir", dbTxt: "db", tableSettingsXml: "settings-xml",
    };
    for (const srv of servers) {
      out.push(`  ${srv.label}:`);
      for (const k of fileKeys) {
        if (srv.extras[k]) out.push(`    ${nameMap[k]}`);
      }
      if (srv.extras.tableFiles?.length) {
        for (const tf of srv.extras.tableFiles) {
          const base = tf.replace(/.*[/\\]/, "").replace(/\.\w+$/, "");
          out.push(`    ${base}`);
        }
      }
    }
    out.push("\nUse file='<name>' to dump a specific file.");
    return out.join("\n");
  }

  const f = fileName.toLowerCase().replace(/\.(txt|xml|reg)$/i, "");
  const out: string[] = [];

  for (const srv of servers) {
    // First check named extras
    const nameToKey: Record<string, keyof ServerExtras> = {
      services: "servicesTxt", tasklist: "tasklistTxt", ipconfig: "ipconfigTxt",
      netstat: "netstatTxt", systeminfo: "systeminfoTxt", environment: "environmentTxt",
      printshmem: "printshmemTxt", "eventlog-app": "eventLogAppTxt",
      "eventlog-sys": "eventLogSysTxt", "eventlogapplication": "eventLogAppTxt",
      "eventlogsystem": "eventLogSysTxt", license: "licenseTxt",
      dir: "dirTxt", db: "dbTxt",
      "settings-xml": "tableSettingsXml", "tablesettings": "tableSettingsXml",
    };

    let filePath: string | undefined;
    const key = nameToKey[f];
    if (key) {
      filePath = srv.extras[key] as string | undefined;
    }

    // Check table files
    if (!filePath && srv.extras.tableFiles) {
      filePath = srv.extras.tableFiles.find(
        tf => tf.toLowerCase().replace(/.*[/\\]/, "").replace(/\.\w+$/, "").toLowerCase() === f
      );
    }

    if (!filePath) continue;

    const text = await readFileOrNull(filePath);
    if (!text) continue;

    out.push(`\n═══ ${srv.label} — ${fileName} ═══\n`);
    const lines = text.split(/\r?\n/).slice(0, limit);
    out.push(lines.join("\n"));
    const totalLines = text.split(/\r?\n/).length;
    if (totalLines > limit) out.push(`\n... (${totalLines - limit} more lines, use limit= to see more)`);
  }

  return out.length > 0 ? out.join("\n") : `File '${fileName}' not found in any server package.`;
}
