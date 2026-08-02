import type { DesktopReasoningSession } from "../../../electron/ipc-types";
import { displayNameFromActor, normalizeAgentKey } from "./agents";
import { timestampValue } from "./time";

export interface ReasoningAgentTarget {
  actorLabel: string | null;
  displayName: string;
  ideLabel?: string | null;
  sender: string;
  agentKey?: string | null;
  agentSessionId?: string | null;
}

export function latestReasoningSessionForTarget(
  target: ReasoningAgentTarget,
  sessions: readonly DesktopReasoningSession[],
): DesktopReasoningSession | null {
  const keys = reasoningAgentTargetKeys(target);
  if (!keys.length) return null;
  return sessions
    .filter((session) => reasoningSessionAgentKeys(session).some((key) => keys.includes(key)))
    .sort((left, right) =>
      timestampValue(right.updatedAt || right.createdAt) - timestampValue(left.updatedAt || left.createdAt)
      || String(right.id).localeCompare(String(left.id))
    )[0] || null;
}

/**
 * Inspector parity without presentation-label identity joins. When both
 * durable identifiers are present, the same reasoning stream must satisfy
 * both of them.
 */
export function latestReasoningSessionForExactIdentity(
  identity: Pick<ReasoningAgentTarget, "agentSessionId" | "agentKey">,
  sessions: readonly DesktopReasoningSession[],
): DesktopReasoningSession | null {
  const sessionId = normalizeAgentKey(identity.agentSessionId);
  const agentKey = specificAgentKey(identity.agentKey);
  if (!sessionId && !agentKey) return null;
  return sessions
    .filter((session) => {
      const sessionIdMatches = !sessionId
        || normalizeAgentKey(session.agentSessionId) === sessionId;
      const keyMatches = !agentKey
        || specificAgentKey(session.agentKey) === agentKey;
      return sessionIdMatches && keyMatches;
    })
    .sort((left, right) =>
      timestampValue(right.updatedAt || right.createdAt) - timestampValue(left.updatedAt || left.createdAt)
      || String(right.id).localeCompare(String(left.id))
    )[0] || null;
}

export function reasoningAgentTargetKeys(target: ReasoningAgentTarget): string[] {
  return [
    target.actorLabel,
    specificAgentKey(target.agentKey),
    target.agentSessionId,
    target.sender,
    target.displayName,
    actorDisplayNameKey(target.actorLabel),
  ].map(normalizeAgentKey).filter(Boolean);
}

export function reasoningSessionAgentKeys(session: DesktopReasoningSession): string[] {
  return [
    session.agentSessionId,
    session.actorLabel,
    actorDisplayNameKey(session.actorLabel),
    specificAgentKey(session.agentKey),
  ].map(normalizeAgentKey).filter(Boolean);
}

export function reasoningTitle(session: DesktopReasoningSession): string {
  return session.title || session.latestPayload?.goal || session.summary || session.goal || "Thinking";
}

export function reasoningSummary(session: DesktopReasoningSession): string {
  return session.latestPayload?.summary
    || session.latestPayload?.checking
    || session.latestPayload?.next_action
    || session.latestPayload?.hypothesis
    || session.summary
    || session.checking
    || session.nextAction
    || session.hypothesis
    || "No progress summary yet.";
}

export function reasoningFieldRows(session: DesktopReasoningSession): Array<{ label: string; value: string }> {
  const payload = session.latestPayload;
  const rows = [
    { label: "Goal", value: payload?.goal || session.goal || "" },
    { label: "Checking", value: payload?.checking || session.checking || "" },
    { label: "Hypothesis", value: payload?.hypothesis || session.hypothesis || "" },
    { label: "Next", value: payload?.next_action || session.nextAction || "" },
    { label: "Blocker", value: payload?.blocker || session.blocker || "" },
    {
      label: "Confidence",
      value: typeof payload?.confidence === "number"
        ? `${Math.round(payload.confidence * 100)}%`
        : typeof session.confidence === "number"
          ? `${Math.round(session.confidence * 100)}%`
          : "",
    },
  ];
  return rows.filter((row) => row.value.trim()).slice(0, 4);
}

export function reasoningStatus(session: DesktopReasoningSession): string {
  if (session.closedAt) return "Closed";
  const status = String(session.latestPayload?.status || session.status || "active").trim();
  return status
    ? status.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
    : "Active";
}

export function isIdleReasoningSession(session: DesktopReasoningSession | null | undefined): boolean {
  if (!session) {
    return false;
  }
  if (session.closedAt) {
    return true;
  }

  const normalized = String(session.latestPayload?.status || session.status || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return normalized === "idle" ||
    normalized === "waiting" ||
    normalized === "waiting for event" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done";
}

function actorDisplayNameKey(actorLabel: string | null | undefined): string | null {
  return actorLabel ? displayNameFromActor(actorLabel) : null;
}

function specificAgentKey(value: string | null | undefined): string {
  const normalized = normalizeAgentKey(value);
  if (!normalized || !/[/:]/.test(normalized)) {
    return "";
  }
  return normalized;
}

export type ReasoningStreamState = "live" | "recent" | "snapshot" | "blocked";

export interface ReasoningStreamInput {
  status?: string | null;
  summary?: string | null;
  checking?: string | null;
  nextAction?: string | null;
}

export interface ReasoningStreamClassification {
  state: ReasoningStreamState;
  label: string;
  description: string;
  isCodexReasoningSummary: boolean;
  isCodexSnapshot: boolean;
}

/**
 * Classify a reasoning stream's freshness state, pill label, and tooltip.
 *
 * Precedence is deliberate: an explicit `blocked` status is authoritative and
 * outranks the Codex reasoning-summary text heuristic. Codex reasoning streams
 * don't always carry a clean status, so the heuristic infers "live thinking"
 * from the text — but when the provider does report `blocked`, that must win,
 * otherwise a blocked session whose text happens to match renders the green
 * "live" state (and a "Live thinking" pill) around a red Blocker field.
 */
export function classifyReasoningStream(input: ReasoningStreamInput): ReasoningStreamClassification {
  const status = String(input.status || "").trim();
  const normalizedStatus = status.toLowerCase();
  const text = [input.summary, input.checking, input.nextAction].join(" ").toLowerCase();
  const isCodexReasoningSummary =
    text.includes("readable reasoning") || text.includes("reasoning summary");
  const isCodexSnapshot = !isCodexReasoningSummary
    && (text.includes("codex_app_server")
      || text.includes("app-server snapshot")
      || text.includes("snapshot-derived"));

  let state: ReasoningStreamState;
  if (normalizedStatus === "blocked") state = "blocked";
  else if (isCodexReasoningSummary) state = "live";
  else if (isCodexSnapshot) state = "snapshot";
  else if (normalizedStatus === "working" || normalizedStatus === "reviewing") state = "live";
  else state = "recent";

  let label: string;
  if (normalizedStatus === "blocked") label = titleizeReasoningStatus(status);
  else if (isCodexReasoningSummary) label = "Live thinking";
  else if (isCodexSnapshot) label = "Snapshot";
  else label = status ? titleizeReasoningStatus(status) : "Reasoning";

  let description: string;
  if (normalizedStatus === "blocked") description = label;
  else if (isCodexReasoningSummary) description = "Readable Codex reasoning summary stream";
  else if (isCodexSnapshot) description = "Codex app-server snapshot";
  else description = label;

  return { state, label, description, isCodexReasoningSummary, isCodexSnapshot };
}

function titleizeReasoningStatus(status: string): string {
  return status.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
