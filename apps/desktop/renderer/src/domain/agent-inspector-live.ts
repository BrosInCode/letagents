import type { DesktopAgentStreamEvent } from "../../../electron/ipc-types";
import type { AgentInspectorOverallState } from "./agent-inspector";

/**
 * A folded, renderable view of an agent's ephemeral live feed: reasoning and
 * assistant-text blocks (deltas concatenated per part) and tool-call cards
 * (upserted by call id). Pure so the fold is unit-testable; the renderer keeps
 * the raw event list and recomputes this on each batch.
 */
export type LiveTranscriptItem =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "message"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      tool: string;
      status: string;
      input: unknown;
      output: unknown;
      error: string | null;
    };

export interface AgentLiveTranscript {
  items: LiveTranscriptItem[];
  ended: boolean;
  startedAt: string | null;
  lastActivityAt: string | null;
}

/** Select only evidence owned by the durable room turn. An open provider
 * stream can span many idle periods and turns, so its replay is not itself a
 * work boundary. Idle views intentionally retain the bounded recent replay. */
export function scopeAgentStreamEventsToWork(
  events: readonly DesktopAgentStreamEvent[],
  work: { active: boolean; startedAt: string | null },
): readonly DesktopAgentStreamEvent[] {
  if (!work.active) return events;
  const startedAt = Date.parse(work.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return [];
  return events.filter((event) => Date.parse(event.observedAt) >= startedAt);
}

export type AgentLiveAvailability =
  | "closed"
  | "stale"
  | "active"
  | "stopped"
  | "paused"
  | "disconnected"
  | "attention"
  | "transitioning"
  | "idle";

/** One precedence table for the Live tab's claims about availability. */
export function agentLiveAvailability(
  work: { active: boolean; freshness: "fresh" | "stale"; agentState: AgentInspectorOverallState },
  streamEnded: boolean,
): AgentLiveAvailability {
  if (streamEnded) return "closed";
  if (work.freshness === "stale") return "stale";
  if (work.active) return "active";
  if (work.agentState === "retired") return "stopped";
  if (work.agentState === "paused") return "paused";
  if (work.agentState === "disconnected") return "disconnected";
  if (work.agentState === "needs_attention") return "attention";
  if (["restoring_conversation", "recovering", "reconnecting", "starting"].includes(work.agentState)) return "transitioning";
  return "idle";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deltaText(payload: Record<string, unknown> | null, fallback: string | null): string {
  if (payload && typeof payload.delta === "string") return payload.delta;
  return typeof fallback === "string" ? fallback : "";
}

/**
 * Fold a raw event list into a transcript. Reasoning/message deltas append to
 * the block keyed by their partId; tool events upsert a card keyed by callID.
 * Order is first-appearance order of each part/call.
 */
export function foldAgentStreamEvents(
  events: readonly DesktopAgentStreamEvent[],
  ended = false,
): AgentLiveTranscript {
  const items: LiveTranscriptItem[] = [];
  const indexById = new Map<string, number>();

  const upsertText = (kind: "reasoning" | "message", partId: string, text: string): void => {
    if (!text) return;
    const key = `${kind}:${partId}`;
    const existing = indexById.get(key);
    if (existing === undefined) {
      indexById.set(key, items.length);
      items.push({ kind, id: partId, text });
      return;
    }
    const item = items[existing]!;
    if (item.kind === kind) item.text += text;
  };

  for (const event of events) {
    const payload = record(event.payload);
    if (event.method === "reasoning/summaryTextDelta"
      || event.method === "item/reasoning/summaryTextDelta") {
      const partId = payload && typeof payload.partId === "string"
        ? payload.partId
        : payload && typeof payload.itemId === "string"
          ? `${payload.itemId}:${typeof payload.summaryIndex === "number" ? payload.summaryIndex : 0}`
          : "reasoning";
      upsertText("reasoning", partId, deltaText(payload, event.summary));
    } else if (event.method === "item/agentMessage/delta") {
      const nativeId = payload && typeof payload.partId === "string" ? payload.partId
        : payload && typeof payload.itemId === "string" ? payload.itemId : "message";
      const partId = payload && (typeof payload.turnId === "string" || typeof payload.threadId === "string")
        ? JSON.stringify([payload.threadId ?? null, payload.turnId ?? null, nativeId]) : nativeId;
      // Assistant text deltas carry the real text only in the payload; the
      // summary is a "provider · method" fallback and must not be shown.
      upsertText("message", partId, deltaText(payload, null));
    } else if (event.kind === "tool_lifecycle"
      && event.method === "item/toolCall/updated"
      && payload) {
      const callId = typeof payload.callID === "string" ? payload.callID
        : typeof payload.partId === "string" ? payload.partId : "tool";
      const key = `tool:${callId}`;
      const existing = indexById.get(key);
      const prior = existing === undefined ? null : items[existing];
      const priorTool = prior?.kind === "tool" ? prior : null;
      const nextStatus = typeof payload.status === "string" ? payload.status : "running";
      const priorIsTerminal = priorTool
        ? ["completed", "error", "failed", "interrupted"].includes(priorTool.status)
        : false;
      if (priorIsTerminal && (nextStatus === "running" || nextStatus === "pending")) continue;
      const next: LiveTranscriptItem = {
        kind: "tool",
        id: callId,
        tool: typeof payload.tool === "string" ? payload.tool : priorTool?.tool ?? "tool",
        status: nextStatus,
        input: payload.input ?? priorTool?.input ?? null,
        output: payload.output ?? priorTool?.output ?? null,
        error: typeof payload.error === "string" ? payload.error : priorTool?.error ?? null,
      };
      if (existing === undefined) {
        indexById.set(key, items.length);
        items.push(next);
      } else {
        items[existing] = next;
      }
    }
  }

  if (ended) {
    for (const item of items) {
      if (item.kind === "tool" && item.status === "running") item.status = "interrupted";
    }
  }

  return {
    items,
    ended,
    startedAt: events.find((event) => Boolean(event.observedAt))?.observedAt ?? null,
    lastActivityAt: [...events].reverse().find((event) => Boolean(event.observedAt))?.observedAt ?? null,
  };
}

/** Compact elapsed copy for the live-work header. Invalid timestamps are
 * ignored instead of leaking `NaN` into the inspector. */
export function formatLiveWorkDuration(
  startedAt: string | null,
  endedAt: string | null,
  now = Date.now(),
): string | null {
  const started = Date.parse(startedAt || "");
  const ended = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;

  const seconds = Math.max(0, Math.floor((ended - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * A human reading of one live tool call. `kind: "reply"` marks the turn's
 * published room reply (complete_room_turn), which the inspector renders as
 * first-class message content; everything else is an action with an optional
 * one-line detail. The raw call stays available behind disclosure — this
 * translation chooses the default reading, it never discards data.
 */
export interface LiveToolPresentation {
  kind: "reply" | "action";
  headline: string;
  detail: string | null;
  replyText: string | null;
  /** Bare tool name with transport prefixes stripped, for the raw expander. */
  toolName: string;
}

/** Providers publish MCP tools under a per-turn hashed server alias. */
// 12+ hex digits: long enough that hex-spellable English words ("facade",
// "decade") never match; production aliases are 24 hex, test fixtures 12.
const MCP_SERVER_ALIAS_PREFIX = /^letagents[-_]supervised[-_][0-9a-f]{12,}[-_]/i;

const SALIENT_ARG_KEYS = [
  "command", "text", "message", "title", "name", "description", "path",
  "file_path", "query", "pattern", "status", "room", "room_id", "url",
] as const;

function argsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstSalientArg(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const key of SALIENT_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return truncateDetail(value);
  }
  return null;
}

function truncateDetail(value: string): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > 140 ? `${flattened.slice(0, 139)}…` : flattened;
}

function stringArg(args: Record<string, unknown> | null, key: string): string | null {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Domain sentences for the LetAgents room tools an agent uses mid-turn. */
function describeLetAgentsTool(
  bareTool: string,
  args: Record<string, unknown> | null,
  outcome?: { status: string; output: unknown; error: string | null },
): LiveToolPresentation | null {
  switch (bareTool) {
    case "complete_room_turn": {
      const noReply = stringArg(args, "outcome") === "no_reply";
      if (outcome?.status !== "completed" || outcome.error || !containsAcceptedResult(outcome.output)) {
        return action(noReply ? "Tried to close the turn without a reply" : "Tried to reply to the room", args, bareTool);
      }
      return {
        kind: "reply",
        headline: noReply ? "Closed the turn without a reply" : "Replied to the room",
        detail: null,
        replyText: noReply ? null : stringArg(args, "text"),
        toolName: bareTool,
      };
    }
    case "update_task":
      return action(outcome?.status === "pending" ? "Requested a task update" : outcome?.status === "running" ? "Updating a task" : "Task update", args, bareTool);
    case "release_task_lease":
      return action(outcome?.status === "pending" ? "Requested a task lease release" : "Task lease release", args, bareTool);
    case "register_task_lease_action_intent":
      return action("Task lease action request", args, bareTool);
    case "send_message":
      return action("Sent a room message", args, bareTool);
    case "send_thread_message":
      return action("Sent a thread reply", args, bareTool);
    case "post_status":
      return action("Posted a status update", args, bareTool);
    case "post_reasoning":
      return action("Shared reasoning in the room", args, bareTool);
    case "add_task":
      return action("Added a board task", args, bareTool);
    case "get_board":
      return action("Read the room board", null, bareTool);
    case "get_board_settings":
      return action("Read the board settings", null, bareTool);
    case "get_current_room":
      return action("Checked the current room", null, bareTool);
    case "check_repo":
      return action("Checked the repository", args, bareTool);
    case "wait_for_messages":
      return action("Waited for new room messages", null, bareTool);
    default:
      return null;
  }
}

function containsAcceptedResult(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (value.length > 64 * 1024) return false;
    try { return containsAcceptedResult(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((item) => containsAcceptedResult(item, depth + 1));
  const valueRecord = record(value);
  if (!valueRecord) return false;
  if (valueRecord.accepted === true) return true;
  return Object.values(valueRecord).some((item) => containsAcceptedResult(item, depth + 1));
}

function action(
  headline: string,
  args: Record<string, unknown> | null,
  toolName: string,
): LiveToolPresentation {
  return { kind: "action", headline, detail: firstSalientArg(args), replyText: null, toolName };
}

/** Headlines for the provider's own (non-MCP) tool surfaces. */
const NATIVE_TOOL_HEADLINES: Readonly<Record<string, { running: string; complete: string }>> = {
  shellToolCall: { running: "Running a shell command", complete: "Ran a shell command" },
  terminalToolCall: { running: "Running a shell command", complete: "Ran a shell command" },
  editToolCall: { running: "Editing a file", complete: "Edited a file" },
  writeToolCall: { running: "Writing a file", complete: "Wrote a file" },
  readToolCall: { running: "Reading a file", complete: "Read a file" },
  searchToolCall: { running: "Searching the workspace", complete: "Searched the workspace" },
  grepToolCall: { running: "Searching the workspace", complete: "Searched the workspace" },
  globToolCall: { running: "Listing matching files", complete: "Listed matching files" },
};

/**
 * Translate one live tool event into its human reading. Cursor wraps every
 * MCP invocation as `mcpToolCall` with the real tool in `input.name`, so that
 * wrapper is unwrapped first; hashed per-turn server aliases are stripped so
 * the reader sees `complete_room_turn`, never the transport identity.
 */
export function describeLiveToolCall(
  tool: string,
  input: unknown,
  outcome?: { status: string; output: unknown; error: string | null },
): LiveToolPresentation {
  const inputRecord = argsRecord(input);
  if (tool === "mcpToolCall" && inputRecord && typeof inputRecord.name === "string") {
    const bareTool = inputRecord.name.replace(MCP_SERVER_ALIAS_PREFIX, "");
    const args = argsRecord(inputRecord.args);
    return describeLetAgentsTool(bareTool, args, outcome)
      ?? action(bareTool, args, bareTool);
  }
  const bareTool = tool.replace(/^mcp__letagents__/, "").replace(MCP_SERVER_ALIAS_PREFIX, "");
  const known = describeLetAgentsTool(bareTool, inputRecord, outcome);
  if (known) return known;
  const nativeHeadlines = NATIVE_TOOL_HEADLINES[bareTool];
  if (nativeHeadlines) {
    const headline = outcome?.status === "pending" ? `Requested: ${nativeHeadlines.running}`
      : outcome?.status === "running" ? nativeHeadlines.running : nativeHeadlines.complete;
    return action(headline, inputRecord, bareTool);
  }
  return action(bareTool, inputRecord, bareTool);
}
