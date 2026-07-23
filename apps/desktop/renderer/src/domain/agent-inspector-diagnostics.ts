import type { DesktopSupervisorActivityEvent, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import type { AgentInspectorProjection } from "./agent-inspector";

/** Diagnostics is intentionally a small, renderer-only safety boundary. */
export const AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT = 24;
export const AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT = 32_000;

const STRING_LIMIT = 240;
const PAYLOAD_PREVIEW_LIMIT = 800;
const DEPTH_LIMIT = 4;
const NODE_LIMIT = 48;
const COLLECTION_LIMIT = 16;
const SECRET_KEY = /(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)/i;
const SECRET_TEXT = /\b(?:authorization|bearer|token|api[_ -]?key|password|passwd|private[_ -]?key|secret|credential|cookie)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;

export type AgentInspectorDiagnosticsValue = null | boolean | number | string | AgentInspectorDiagnosticsValue[] | { [key: string]: AgentInspectorDiagnosticsValue };

export interface AgentInspectorDiagnosticEvent {
  observedAt: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  summary: string;
  status: DesktopSupervisorActivityEvent["status"];
  payloadPreview: string | null;
  redacted: boolean;
  truncated: boolean;
}

export interface AgentInspectorDiagnosticsProjection {
  identity: { entryId: string; roomId: string; agentKey: string | null; provider: string; model: string | null; createdAt: string };
  runtime: { desiredState: string; observedState: string; bindingState: string; providerPid: number | null; executionGenerationId: string | null; restartCount: number; workplaceLiveness: string; nativeLiveness: string };
  recovery: { condition: string; lastError: string | null; connection: string | null; ingress: string | null; inbox: string | null; turn: string | null; turnControl: string | null };
  activity: AgentInspectorDiagnosticEvent[];
  activityTruncated: boolean;
}

interface SanitizeContext { redacted: boolean; truncated: boolean; nodes: number; seen: WeakSet<object>; }

function newContext(): SanitizeContext { return { redacted: false, truncated: false, nodes: 0, seen: new WeakSet() }; }

function safeText(value: unknown, context: SanitizeContext): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  const redacted = text.replace(SECRET_TEXT, (_match, offset: number, source: string) => {
    context.redacted = true;
    const prefix = source.slice(Math.max(0, offset), offset).match(/(?:authorization|bearer|token|api[_ -]?key|password|passwd|private[_ -]?key|secret|credential|cookie)\s*[:=]\s*$/i)?.[0] ?? "";
    return `${prefix}[REDACTED]`;
  }).replace(JWT, () => { context.redacted = true; return "[REDACTED]"; });
  text = redacted;
  if (text.length > STRING_LIMIT) { context.truncated = true; return `${text.slice(0, STRING_LIMIT)}…`; }
  return text;
}

/** Converts untrusted event payloads into deterministic, serialisable and bounded data. */
export function sanitizeAgentInspectorDiagnosticsValue(value: unknown, context = newContext(), depth = 0): { value: AgentInspectorDiagnosticsValue; redacted: boolean; truncated: boolean } {
  if (context.nodes++ >= NODE_LIMIT || depth > DEPTH_LIMIT) { context.truncated = true; return { value: "[TRUNCATED]", redacted: context.redacted, truncated: true }; }
  if (value === null || value === undefined) return { value: null, redacted: context.redacted, truncated: context.truncated };
  if (typeof value === "string") return { value: safeText(value, context), redacted: context.redacted, truncated: context.truncated };
  if (typeof value === "boolean") return { value, redacted: context.redacted, truncated: context.truncated };
  if (typeof value === "number") return { value: Number.isFinite(value) ? value : "[NON_FINITE_NUMBER]", redacted: context.redacted, truncated: context.truncated };
  const valueType = typeof value;
  if (valueType !== "object") { context.truncated = true; return { value: `[UNSUPPORTED_${valueType.toUpperCase()}]`, redacted: context.redacted, truncated: true }; }
  if (context.seen.has(value)) { context.truncated = true; return { value: "[CIRCULAR]", redacted: context.redacted, truncated: true }; }
  context.seen.add(value);
  if (Array.isArray(value)) {
    const result: AgentInspectorDiagnosticsValue[] = [];
    for (const item of value.slice(0, COLLECTION_LIMIT)) result.push(sanitizeAgentInspectorDiagnosticsValue(item, context, depth + 1).value);
    if (value.length > COLLECTION_LIMIT) { context.truncated = true; result.push("[TRUNCATED]"); }
    return { value: result, redacted: context.redacted, truncated: context.truncated };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) { context.truncated = true; return { value: "[UNSUPPORTED_OBJECT]", redacted: context.redacted, truncated: true }; }
  const result: Record<string, AgentInspectorDiagnosticsValue> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys.slice(0, COLLECTION_LIMIT)) {
    if (SECRET_KEY.test(key) || /durablepayloadref|lastterminal/i.test(key)) { context.redacted = true; result[key] = "[REDACTED]"; continue; }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    result[key] = descriptor?.get ? "[ACCESSOR_OMITTED]" : sanitizeAgentInspectorDiagnosticsValue(descriptor?.value, context, depth + 1).value;
  }
  if (keys.length > COLLECTION_LIMIT) { context.truncated = true; result["[TRUNCATED]"] = `${keys.length - COLLECTION_LIMIT} fields omitted`; }
  return { value: result, redacted: context.redacted, truncated: context.truncated };
}

function boundedEvent(event: DesktopSupervisorActivityEvent): AgentInspectorDiagnosticEvent {
  const context = newContext();
  const provider = safeText(event.provider, context);
  const kind = safeText(event.kind, context);
  const method = safeText(event.method, context);
  const summary = safeText(event.summary, context);
  const payload = event.payload === null ? null : sanitizeAgentInspectorDiagnosticsValue(event.payload, context).value;
  let payloadPreview = payload === null ? null : JSON.stringify(payload);
  if (payloadPreview && payloadPreview.length > PAYLOAD_PREVIEW_LIMIT) { payloadPreview = `${payloadPreview.slice(0, PAYLOAD_PREVIEW_LIMIT)}…`; context.truncated = true; }
  return { observedAt: safeText(event.observedAt, context), sequence: event.sequence, provider, kind, method, summary, status: event.status, payloadPreview, redacted: event.payloadRedacted || context.redacted, truncated: event.payloadTruncated || context.truncated };
}

function orderedEvents(events: readonly DesktopSupervisorActivityEvent[]): DesktopSupervisorActivityEvent[] {
  return [...events].sort((a, b) => b.sequence - a.sequence || b.observedAt.localeCompare(a.observedAt) || b.method.localeCompare(a.method));
}

function stableProjection(entry: DesktopSupervisorManifestEntry): Omit<AgentInspectorDiagnosticsProjection, "activity" | "activityTruncated"> {
  const context = newContext();
  const room = entry.roomAgentState;
  return {
    identity: { entryId: safeText(entry.id, context), roomId: safeText(entry.roomId, context), agentKey: entry.agentKey ? safeText(entry.agentKey, context) : null, provider: safeText(entry.provider, context), model: entry.model ? safeText(entry.model, context) : null, createdAt: safeText(entry.createdAt, context) },
    runtime: { desiredState: entry.desiredState, observedState: entry.observedState, bindingState: entry.agentSessionBindingState, providerPid: entry.providerPid, executionGenerationId: entry.executionGenerationId ? safeText(entry.executionGenerationId, context) : null, restartCount: entry.restartCount, workplaceLiveness: entry.workplaceLiveness.state, nativeLiveness: entry.nativeLiveness.state },
    recovery: { condition: entry.condition, lastError: entry.lastError ? safeText(entry.lastError, context) : null, connection: room?.connection.state ?? null, ingress: room?.ingress.state ?? null, inbox: room?.inbox.state ?? null, turn: room?.turn.state ?? null, turnControl: entry.turnControl?.status ?? null },
  };
}

export function projectAgentInspectorDiagnostics(projection: Pick<AgentInspectorProjection, "entry">): AgentInspectorDiagnosticsProjection {
  const ordered = orderedEvents(projection.entry.activity);
  return { ...stableProjection(projection.entry), activity: ordered.slice(0, AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT).map(boundedEvent), activityTruncated: ordered.length > AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT };
}

/** The copy payload is built solely from the safe diagnostics projection. */
export function agentInspectorDiagnosticsReport(projection: AgentInspectorDiagnosticsProjection): string {
  const compose = (activity: readonly AgentInspectorDiagnosticEvent[]) => JSON.stringify({ format: "letagents-agent-diagnostics-v1", identity: projection.identity, runtime: projection.runtime, recovery: projection.recovery, recentActivity: activity, activityTruncated: projection.activityTruncated || activity.length < projection.activity.length }, null, 2);
  for (const count of [projection.activity.length, 16, 8, 0]) { const report = compose(projection.activity.slice(0, count)); if (report.length <= AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT) return report; }
  return JSON.stringify({ format: "letagents-agent-diagnostics-v1", identity: projection.identity, runtime: projection.runtime, recovery: projection.recovery, recentActivity: [], activityTruncated: true }, null, 2);
}
