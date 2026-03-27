/**
 * tool-dispatch.ts
 *
 * Routes an MCP tool call to the appropriate handler function.
 */

import type { LogContext } from "./types.js";

import { toolTriage } from "./tools/triage.js";
import { toolListLogFiles } from "./tools/list-logs.js";
import { toolSearchErrors } from "./tools/search-errors.js";
import { toolSearchPattern, toolSearchCount, toolSearchAssertAbsent } from "./tools/search-pattern.js";
import { toolGetStackTraces } from "./tools/stack-traces.js";
import { toolGetServiceLifecycle, toolDetectLogGaps } from "./tools/service-lifecycle.js";
import { toolGetUiThreadActivity } from "./tools/ui-thread.js";
import { toolCorrelateTimelines, toolWaveAnalysis } from "./tools/correlate-timeline.js";
import { toolGetProcessLifetimes } from "./tools/process-lifetimes.js";
import { toolGetPdCrashes } from "./tools/pd-crashes.js";
import { toolTraceMbRequest } from "./tools/trace-mb-request.js";
import { toolSearchHttpRequests } from "./tools/search-http-requests.js";
import { toolSummarizeHealth, toolMemoryTrends } from "./tools/summarize-health.js";
import { toolCompareLogs } from "./tools/compare-logs.js";
import { toolDbTables } from "./tools/db-tables.js";
import { toolVideoHealth } from "./tools/video-health.js";
import { toolStorage } from "./tools/storage.js";
import { toolAlarms } from "./tools/alarms.js";
import { toolNetwork } from "./tools/network.js";
import { toolAccessControl } from "./tools/access-control.js";
import { toolPermissions } from "./tools/permissions.js";
import { toolSystemDiag } from "./tools/system-diagnostics.js";
import { toolEventLog } from "./tools/event-log.js";
import { decodePrefix, listKnownPrefixes } from "./lib/prefix-map.js";
import { getHardwareConfig, formatHardwareConfig } from "./lib/config-parser.js";

/**
 * Dispatch a tool call to the matching handler.
 *
 * @param name      MCP tool name (e.g. "sym_info")
 * @param a         Parsed arguments from the MCP request
 * @param ctx       Lazy-initialized log context
 * @param logDirRaw Raw LOG_DIR string for display in messages
 * @returns         Formatted result string
 */
export async function dispatchToolCall(
  name: string,
  a: Record<string, unknown>,
  ctx: LogContext,
  logDirRaw: string,
): Promise<string> {
  switch (name) {
    // ---- sym_triage ----
    case "sym_triage":
      return await toolTriage(ctx.dirs, ctx.bugReport, {
        sccpFiles:      a.sccpFiles      as string[] | undefined,
        errorFiles:     a.errorFiles     as string[] | undefined,
        lifecycleFiles: a.lifecycleFiles as string[] | undefined,
        startTime:      a.startTime      as string | undefined,
        endTime:        a.endTime        as string | undefined,
      });

    // ---- sym_info: bug_report + list_files + decode_prefix + hardware ----
    case "sym_info": {
      const action = a.action as string;
      if (action === "bug_report") {
        const br = ctx.bugReport;
        if (!br) {
          return `Not a bug report package. Log directory: ${logDirRaw}`;
        }
        const lines: string[] = [
          `Bug Report Package: ${br.folderPath}`,
          `Product Version:    ${br.productVersion}`,
          `Farm:               ${br.farmName}`,
          `Log Start:          ${br.logStartTime}`,
          `Log End:            ${br.logEndTime}`,
          `Time of Error:      ${br.timeOfError}`,
          `Problem:            ${br.problemDescription}`,
          "",
          `Servers (${br.servers.length}):`,
        ];
        for (const s of br.servers) {
          if (s.isClient) {
            lines.push(`  Client  (no standard log files)`);
          } else {
            lines.push(`  ${s.label}`);
          }
        }
        return lines.join("\n");
      } else if (action === "list_files") {
        return await toolListLogFiles(ctx.dirs, {
          prefix:       a.prefix       as string | undefined,
          date:         a.date         as string | undefined,
          limit:        a.limit        as number | undefined,
          serverLabels: ctx.serverLabels,
        });
      } else if (action === "decode_prefix") {
        if (!a.prefix) {
          const all = listKnownPrefixes();
          const lines = [
            `${all.length} known prefixes:\n`,
            ...all.map(
              (p) =>
                `  ${p.prefix.padEnd(8)} [${p.side.padEnd(11)}]  ${p.description}`
            ),
          ];
          return lines.join("\n");
        }
        const info = decodePrefix(a.prefix as string);
        return [
          `Prefix:      ${a.prefix}`,
          `Description: ${info.description}`,
          `Category:    ${info.category}`,
          `Side:        ${info.side}`,
          info.notes ? `Notes:       ${info.notes}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      } else if (action === "hardware") {
        const br = ctx.bugReport;
        if (!br) {
          return "Hardware info requires a bug report package (serverinfo.txt). Log directory: " + logDirRaw;
        }
        const hw = await getHardwareConfig(br.folderPath);
        return formatHardwareConfig(hw);
      } else {
        throw new Error(`sym_info: unknown action '${action}'`);
      }
    }

    // ---- sym_search: errors + pattern ----
    case "sym_search": {
      const mode = a.mode as string;
      if (mode === "errors") {
        return await toolSearchErrors(ctx.dirs, {
          files:         a.files         as string[],
          deduplicate:   a.deduplicate   as boolean | undefined,
          includeStacks: a.includeStacks as boolean | undefined,
          startTime:     a.startTime     as string | undefined,
          endTime:       a.endTime       as string | undefined,
          limit:         a.limit         as number | undefined,
        });
      } else if (mode === "pattern") {
        return await toolSearchPattern(ctx.dirs, {
          files:         a.files         as string[],
          pattern:       a.pattern       as string,
          isRegex:       a.isRegex       as boolean | undefined,
          caseSensitive: a.caseSensitive as boolean | undefined,
          contextLines:  a.contextLines  as number | undefined,
          levelFilter:   a.levelFilter   as string[] | undefined,
          startTime:     a.startTime     as string | undefined,
          endTime:       a.endTime       as string | undefined,
          limit:         a.limit         as number | undefined,
        });
      } else if (mode === "count") {
        return await toolSearchCount(ctx.dirs, {
          files:         a.files         as string[],
          pattern:       a.pattern       as string,
          isRegex:       a.isRegex       as boolean | undefined,
          caseSensitive: a.caseSensitive as boolean | undefined,
          levelFilter:   a.levelFilter   as string[] | undefined,
          startTime:     a.startTime     as string | undefined,
          endTime:       a.endTime       as string | undefined,
        });
      } else if (mode === "assert_absent") {
        return await toolSearchAssertAbsent(ctx.dirs, {
          files:         a.files         as string[],
          pattern:       a.pattern       as string,
          isRegex:       a.isRegex       as boolean | undefined,
          caseSensitive: a.caseSensitive as boolean | undefined,
          levelFilter:   a.levelFilter   as string[] | undefined,
          startTime:     a.startTime     as string | undefined,
          endTime:       a.endTime       as string | undefined,
          limit:         a.limit         as number | undefined,
        });
      }
      throw new Error(`sym_search: unknown mode '${mode}'`);
    }

    // ---- sym_crashes: managed + native ----
    case "sym_crashes": {
      const mode = a.mode as string;
      if (mode === "managed") {
        return await toolGetStackTraces(ctx.dirs, {
          files:           a.files           as string[],
          exceptionFilter: a.exceptionFilter as string | undefined,
          limit:           a.limit           as number | undefined,
          includeNative:   a.includeNative   as boolean | undefined,
        });
      } else if (mode === "native") {
        return await toolGetPdCrashes(ctx.dirs, {
          files:           a.files           as string[],
          framesPerThread: a.framesPerThread as number | undefined,
          threadsPerCrash: a.threadsPerCrash as number | undefined,
          limit:           a.limit           as number | undefined,
        });
      }
      throw new Error(`sym_crashes: unknown mode '${mode}'`);
    }

    // ---- sym_lifecycle: services + processes ----
    case "sym_lifecycle": {
      const mode = a.mode as string;
      if (mode === "services") {
        return await toolGetServiceLifecycle(ctx.dirs, {
          files:        a.files        as string[],
          includePings: a.includePings as boolean | undefined,
          startTime:    a.startTime    as string | undefined,
          endTime:      a.endTime      as string | undefined,
          limit:        a.limit        as number | undefined,
        });
      } else if (mode === "processes") {
        return await toolGetProcessLifetimes(ctx.dirs, {
          files:        a.files        as string[],
          symphonyOnly: a.symphonyOnly as boolean | undefined,
          filter:       a.filter       as string | undefined,
          showAll:      a.showAll      as boolean | undefined,
          startTime:    a.startTime    as string | undefined,
          endTime:      a.endTime      as string | undefined,
          limit:        a.limit        as number | undefined,
        });
      } else if (mode === "gaps") {
        return await toolDetectLogGaps(ctx.dirs, {
          files:           a.files           as string[],
          gapThresholdSec: a.gapThresholdSec as number | undefined,
          startTime:       a.startTime       as string | undefined,
          endTime:         a.endTime         as string | undefined,
          limit:           a.limit           as number | undefined,
        });
      }
      throw new Error(`sym_lifecycle: unknown mode '${mode}'`);
    }

    // ---- sym_timeline: correlate + trace_rpc + waves ----
    case "sym_timeline": {
      const mode = a.mode as string;
      if (mode === "correlate") {
        return await toolCorrelateTimelines(ctx.dirs, {
          files:       a.files       as string[],
          levelFilter: a.levelFilter as string[] | undefined,
          startTime:   a.startTime   as string | undefined,
          endTime:     a.endTime     as string | undefined,
          limit:       a.limit       as number | undefined,
        });
      } else if (mode === "trace_rpc") {
        return await toolTraceMbRequest(ctx.dirs, {
          requestName: a.requestName as string,
          moFiles:     a.moFiles    as string[] | undefined,
          isFiles:     a.isFiles    as string[] | undefined,
          startTime:   a.startTime  as string | undefined,
          endTime:     a.endTime    as string | undefined,
          limit:       a.limit      as number | undefined,
        });
      } else if (mode === "waves") {
        return await toolWaveAnalysis(ctx.dirs, {
          files:      a.files      as string[],
          pattern:    a.pattern    as string,
          isRegex:    a.isRegex    as boolean | undefined,
          gapSeconds: a.gapSeconds as number | undefined,
          startTime:  a.startTime  as string | undefined,
          endTime:    a.endTime    as string | undefined,
          limit:      a.limit      as number | undefined,
        });
      }
      throw new Error(`sym_timeline: unknown mode '${mode}'`);
    }

    // ---- standalone tools ----
    case "sym_http":
      return await toolSearchHttpRequests(ctx.dirs, {
        files:              a.files              as string[],
        mode:               a.mode               as "requests" | "slow" | "rates" | "totals" | undefined,
        pathFilter:         a.pathFilter         as string | undefined,
        method:             a.method             as string | undefined,
        minDurationMs:      a.minDurationMs      as number | undefined,
        thresholdMs:        a.thresholdMs        as number | undefined,
        includeRpc:         a.includeRpc         as boolean | undefined,
        slowGroupBy:        a.slowGroupBy        as "request" | undefined,
        clientIp:           a.clientIp           as string | undefined,
        statusFilter:       a.statusFilter       as (number | string)[] | undefined,
        groupBy:            a.groupBy            as "path" | "client" | "status" | "statusClass" | undefined,
        sortBy:             a.sortBy             as "avg" | "max" | "count" | "errors" | "duration" | "time" | undefined,
        rateBy:             a.rateBy             as "minute" | "5min" | "hour" | undefined,
        isAssets:           a.isAssets           as boolean | undefined,
        detectActiveWindow: a.detectActiveWindow as boolean | undefined,
        startTime:          a.startTime          as string | undefined,
        endTime:            a.endTime            as string | undefined,
        limit:              a.limit              as number | undefined,
      });

    case "sym_ui_thread":
      return await toolGetUiThreadActivity(ctx.dirs, {
        files:             a.files             as string[],
        threadId:          a.threadId           as string | undefined,
        lastN:             a.lastN              as number | undefined,
        fullLog:           a.fullLog            as boolean | undefined,
        freezeThresholdMs: a.freezeThresholdMs  as number | undefined,
        startTime:         a.startTime          as string | undefined,
        endTime:           a.endTime            as string | undefined,
      });

    case "sym_health": {
      const mode = (a.mode as string) ?? "dashboard";
      if (mode === "trends") {
        return await toolMemoryTrends(ctx.dirs, {
          sccpFiles: a.sccpFiles as string[],
          filter:    a.filter    as string | undefined,
          startTime: a.startTime as string | undefined,
          endTime:   a.endTime   as string | undefined,
          limit:     a.limit     as number | undefined,
        });
      }
      return await toolSummarizeHealth(ctx.dirs, {
        sccpFiles:  a.sccpFiles  as string[],
        errorFiles: a.errorFiles as string[] | undefined,
        startTime:  a.startTime  as string | undefined,
        endTime:    a.endTime    as string | undefined,
      });
    }

    case "sym_compare":
      return await toolCompareLogs(ctx.dirs, {
        dirA:          a.dirA          as string,
        labelA:        a.labelA        as string | undefined,
        dirB:          a.dirB          as string,
        labelB:        a.labelB        as string | undefined,
        include:       a.include       as string[] | undefined,
        startTimeA:    a.startTimeA    as string | undefined,
        endTimeA:      a.endTimeA      as string | undefined,
        startTimeB:    a.startTimeB    as string | undefined,
        endTimeB:      a.endTimeB      as string | undefined,
        limit:         a.limit         as number | undefined,
        detectWindows: a.detectWindows as boolean | undefined,
        summarize:     a.summarize     as boolean | undefined,
      });

    case "sym_db_tables":
      return await toolDbTables(ctx.bugReport, {
        mode:      a.mode      as "cameras" | "servers" | "settings" | "users" | "licenses" | "raw" | "summary" | "settings_xml",
        tableName: a.tableName as string | undefined,
        section:   a.section   as string | undefined,
        key:       a.key       as string | undefined,
        limit:     a.limit     as number | undefined,
      });

    case "sym_video_health":
      return await toolVideoHealth(ctx.dirs, {
        files:     a.files     as string[] | undefined,
        mode:      a.mode      as "summary" | "events" | "cameras" | undefined,
        startTime: a.startTime as string | undefined,
        endTime:   a.endTime   as string | undefined,
        limit:     a.limit     as number | undefined,
      });

    case "sym_storage":
      return await toolStorage(ctx.dirs, {
        files:     a.files     as string[] | undefined,
        mode:      a.mode      as "summary" | "events" | "timeline" | undefined,
        startTime: a.startTime as string | undefined,
        endTime:   a.endTime   as string | undefined,
        limit:     a.limit     as number | undefined,
      });

    case "sym_alarms":
      return await toolAlarms(ctx.dirs, {
        files:     a.files     as string[] | undefined,
        mode:      a.mode      as "summary" | "events" | "failures" | undefined,
        startTime: a.startTime as string | undefined,
        endTime:   a.endTime   as string | undefined,
        limit:     a.limit     as number | undefined,
      });

    case "sym_network":
      return await toolNetwork(ctx.dirs, {
        files:        a.files        as string[] | undefined,
        mode:         a.mode         as "summary" | "events" | "targets" | "timeouts" | undefined,
        targetFilter: a.targetFilter as string | undefined,
        startTime:    a.startTime    as string | undefined,
        endTime:      a.endTime      as string | undefined,
        limit:        a.limit        as number | undefined,
      });

    case "sym_access_control":
      return await toolAccessControl(ctx.dirs, {
        files:     a.files     as string[] | undefined,
        mode:      a.mode      as "summary" | "events" | "failures" | "sync" | undefined,
        startTime: a.startTime as string | undefined,
        endTime:   a.endTime   as string | undefined,
        limit:     a.limit     as number | undefined,
      });

    case "sym_permissions":
      return await toolPermissions(ctx.bugReport, {
        mode:       a.mode       as "resolve" | "check" | "groups" | "rights" | "raw",
        user:       a.user       as string | undefined,
        permission: a.permission as string | undefined,
        resource:   a.resource   as string | undefined,
        limit:      a.limit      as number | undefined,
      });

    case "sym_system":
      return await toolSystemDiag(ctx.bugReport, {
        mode:         a.mode         as "overview" | "services" | "processes" | "network" | "environment" | "license" | "files" | "db_summary" | "raw",
        filter:       a.filter       as string | undefined,
        symphonyOnly: a.symphonyOnly as boolean | undefined,
        sortBy:       a.sortBy       as "memory" | "cpu" | "name" | undefined,
        port:         a.port         as number | undefined,
        file:         a.file         as string | undefined,
        limit:        a.limit        as number | undefined,
      });

    case "sym_event_log":
      return await toolEventLog(ctx.bugReport, {
        log:     a.log     as "application" | "system" | "both",
        mode:    a.mode    as "entries" | "summary" | undefined,
        level:   a.level   as string | undefined,
        source:  a.source  as string | undefined,
        eventId: a.eventId as number | undefined,
        search:  a.search  as string | undefined,
        limit:   a.limit   as number | undefined,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
