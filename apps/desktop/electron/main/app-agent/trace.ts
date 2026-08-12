import type {
  DesktopAppAgentActionExecutionSummary,
  DesktopAppAgentRefreshTarget,
  DesktopAppAgentTraceEntry,
} from "../../ipc-types.js";

import type { AppAgentActionTrace } from "./types.js";

export function redactTraceText(value: string): string {
  return value
    .replace(/(api[_\s-]?key|authorization|bearer|token|secret)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/(sk-or-v1-)[A-Za-z0-9_-]+/g, "$1[redacted]");
}

export function traceDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  const redacted = redactTraceText(value.trim());
  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted;
}

export function logTraceEntry(entry: DesktopAppAgentTraceEntry): void {
  if (process.env.LETAGENTS_APP_AGENT_DEBUG !== "1") return;
  const parts = [
    `[app-agent] ${entry.status.toUpperCase()} ${entry.label}`,
    entry.actionId ? `action=${entry.actionId}` : null,
    entry.detail ? `detail=${entry.detail}` : null,
  ].filter(Boolean);
  console.info(parts.join(" | "));
}
export function createAppAgentActionTrace(): AppAgentActionTrace {
  const traceEntries: DesktopAppAgentTraceEntry[] = [];
  const executionSummaries: DesktopAppAgentActionExecutionSummary[] = [];
  const refreshTargetSet = new Set<DesktopAppAgentRefreshTarget>();
  let traceId = 0;
  return {
    add: (label, options = {}) => {
      traceId += 1;
      const entry = {
        id: `trace_${traceId}`,
        label: redactTraceText(label),
        status: options.status || "info",
        detail: traceDetail(options.detail),
        actionId: options.actionId || null,
      };
      traceEntries.push(entry);
      logTraceEntry(entry);
    },
    addRefreshTargets: (targets) => {
      for (const target of targets) {
        refreshTargetSet.add(target);
      }
    },
    recordExecution: (summary) => {
      executionSummaries.push({
        ...summary,
        message: redactTraceText(summary.message),
      });
    },
    entries: () => [...traceEntries],
    executions: () => executionSummaries.map((summary) => ({ ...summary })),
    refreshTargets: () => [...refreshTargetSet],
  };
}
