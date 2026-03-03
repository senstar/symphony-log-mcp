export interface PrefixInfo {
  description: string;
  category: string;
  side: "server" | "client" | "tool" | "integration" | "test";
  notes?: string;
}

/** Known exact-match prefixes */
const EXACT_PREFIXES: Record<string, PrefixInfo> = {
  is:     { description: "Information Service", category: "Server",          side: "server" },
  isac:   { description: "Information Service – Access Control sub-log", category: "Server", side: "server" },
  isbk:   { description: "Information Service – Backup sub-log",         category: "Server", side: "server" },
  ismq:   { description: "Information Service – MQTT sub-log",           category: "Server", side: "server" },
  da:     { description: "Data Access Service",  category: "Server",         side: "server" },
  fe:     { description: "Fusion Engine Service",category: "Server",         side: "server" },
  fs:     { description: "Enterprise Management (Federation Updater)", category: "Server", side: "server" },
  hm:     { description: "Health Monitoring / Watchdog",  category: "Server", side: "server" },
  nu:     { description: "Health Monitor",        category: "Server",        side: "server" },
  sc:     { description: "Scheduler (main)",      category: "Scheduler",     side: "server" },
  scac:   { description: "Scheduler – Actions",   category: "Scheduler",     side: "server" },
  scad:   { description: "Scheduler – Analog Devices", category: "Scheduler", side: "server" },
  scpm:   { description: "Scheduler – PTZ Multiplexer", category: "Scheduler", side: "server" },
  scse:   { description: "Scheduler – Searches", category: "Scheduler",     side: "server" },
  sccp:   { description: "Scheduler – CPU/Memory Stats", category: "Scheduler", side: "server" },
  scis:   { description: "Scheduler – Multicaster (Intelsend)", category: "Scheduler", side: "server" },
  sccl:   { description: "Scheduler – Cleaner",  category: "Scheduler",     side: "server" },
  http:   { description: "Web Host (Seer.Web.Host)", category: "Web",        side: "server" },
  mg:     { description: "Media Gateway",         category: "Web",           side: "server" },
  ne:     { description: "RTSP Server",           category: "Web",           side: "server" },
  wc:     { description: "Web Client",            category: "Web",           side: "client" },
  ht:     { description: "HTTP Server (Seer.Web.Host) – host lifecycle only; individual HTTP requests are in IS logs as RequestLogger entries", category: "Web", side: "server" },
  ae:     { description: "AiraExplorer Client",   category: "Client",        side: "client",
            notes: "Port suffix optional. Main client UI. UI thread analysis applicable." },
  pre:    { description: "AiraExplorer – Preload", category: "Client",       side: "client" },
  am:     { description: "AiraManager",           category: "Client",        side: "client" },
  sm:     { description: "Manager (alternate/OEM)", category: "Client",      side: "client" },
  mo:     { description: "Mobile Bridge",         category: "Client",        side: "client" },
  vp:     { description: "VMS Player (AiraPlayer) – 1 per viewing panel", category: "Video", side: "client",
            notes: "Client-side, one instance per panel showing a camera." },
  vr:     { description: "Video Receive Control (deprecated)", category: "Video", side: "client" },
  vcd:    { description: "VCD Formatter (AIFilters)", category: "Video",     side: "server" },
  tr:     { description: "Transcoder",            category: "Video",         side: "server" },
  f2m:    { description: "Foot2Mpeg",             category: "Video",         side: "server" },
  s2m:    { description: "Aira2Mpeg",             category: "Video",         side: "server" },
  s2:     { description: "Signals2CSV / Seer2Mpeg", category: "Video",       side: "server" },
  hs:     { description: "NetSendHist (main)",    category: "Video History", side: "server" },
  aacl:   { description: "Axis PACS Listener",    category: "Access Control", side: "server" },
  ac:     { description: "Access Control",        category: "Access Control", side: "server" },
  lacl:   { description: "Lenel Access Control Listener", category: "Access Control", side: "server" },
  ga:     { description: "Gallagher Listener",    category: "Access Control", side: "server" },
  ga32:   { description: "Gallagher Listener (32-bit)", category: "Access Control", side: "server" },
  biu:    { description: "Bosch Intrusion Utility", category: "Access Control", side: "server" },
  sso:    { description: "SSO Server",            category: "SSO",           side: "server" },
  ssocl:  { description: "SSO Client",            category: "SSO",           side: "client" },
  os:     { description: "ONVIF Server",          category: "ONVIF",         side: "server" },
  op:     { description: "OPC Server",            category: "OPC",           side: "server" },
  ce:     { description: "Configuration Editor",  category: "Tools",         side: "tool" },
  dl:     { description: "Device Locator",        category: "Tools",         side: "tool" },
  ka:     { description: "KillAllEx",             category: "Tools",         side: "tool" },
  pd:     { description: "Process Debugger",      category: "Tools",         side: "tool" },
  lp:     { description: "LPR",                   category: "Tools",         side: "server" },
  dbs:    { description: "DB Setup",              category: "Tools",         side: "tool" },
  pms:    { description: "Plate Management Service", category: "Integration", side: "integration" },
  alo:    { description: "AutoLogOff",            category: "Integration",   side: "integration" },
  sten:   { description: "Stentofon Client",      category: "Integration",   side: "integration" },
  sir:    { description: "SIRA",                  category: "Integration",   side: "integration" },
  pt:     { description: "PT090 Tester",          category: "Test",          side: "test" },
};

/** Dynamic-prefix patterns (checked after exact match fails) */
const DYNAMIC_PREFIXES: Array<{
  pattern: RegExp;
  describe: (m: RegExpMatchArray) => PrefixInfo;
}> = [
  {
    // cs01, cs3, cs123 — Tracker for camera N
    pattern: /^cs(\d+)$/,
    describe: (m) => ({
      description: `Tracker for camera ${parseInt(m[1])} (server-side, 1 per camera)`,
      category: "Tracker",
      side: "server",
    }),
  },
  {
    // se00A, se1, seABC — Surrogate/OPX client panel viewer
    pattern: /^se(.+)$/,
    describe: (m) => ({
      description: `Surrogate/OPX viewing panel (client-side, ID=${m[1]})`,
      category: "Video",
      side: "client",
      notes: "One per panel actively displaying a camera feed.",
    }),
  },
  {
    // hcs1, hcs2 — Hardware Container Service instance
    pattern: /^hcs(\d+)$/,
    describe: (m) => ({
      description: `Hardware Container Service instance ${m[1]}`,
      category: "Server",
      side: "server",
    }),
  },
  {
    // hs01, hs02 — NetSendHistChild instance
    pattern: /^hs(\d+)$/,
    describe: (m) => ({
      description: `NetSendHistChild instance ${m[1]}`,
      category: "Video History",
      side: "server",
    }),
  },
  {
    // ae_8000 — AiraExplorer with port
    pattern: /^ae_(\d+)$/,
    describe: (m) => ({
      description: `AiraExplorer Client (listening port ${m[1]})`,
      category: "Client",
      side: "client",
      notes: "Main client UI. UI thread analysis applicable.",
    }),
  },
];

export function decodePrefix(prefix: string): PrefixInfo {
  const lower = prefix.toLowerCase().replace(/-$/, ""); // strip trailing dash from "se-"

  // Special case: bare "se" with dash suffix in filename = Setup Wizard
  if (lower === "se") {
    return {
      description: "Setup Wizard (bare 'se-' prefix) OR Surrogate/OPX",
      category: "Setup",
      side: "tool",
      notes:
        "If the filename is 'se-YYMMDD_nn.txt' (no ID), it is Setup Wizard. If 'se{ID}-...', it is Surrogate/OPX.",
    };
  }

  if (EXACT_PREFIXES[lower]) return EXACT_PREFIXES[lower];

  for (const { pattern, describe } of DYNAMIC_PREFIXES) {
    const m = lower.match(pattern);
    if (m) return describe(m);
  }

  return {
    description: "Unknown prefix",
    category: "Unknown",
    side: "server",
  };
}

/** All known static prefixes (for listing/autocomplete) */
export function listKnownPrefixes(): Array<{ prefix: string } & PrefixInfo> {
  return Object.entries(EXACT_PREFIXES).map(([prefix, info]) => ({
    prefix,
    ...info,
  }));
}
