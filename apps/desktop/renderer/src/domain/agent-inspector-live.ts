import type { DesktopAgentStreamEvent } from "../../../electron/ipc-types";

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
      const partId = payload && typeof payload.partId === "string" ? payload.partId : "message";
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
      if (priorIsTerminal && nextStatus === "running") continue;
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

  return { items, ended };
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
const NATIVE_TOOL_HEADLINES: Readonly<Record<string, string>> = {
  shellToolCall: "Ran a shell command",
  terminalToolCall: "Ran a shell command",
  editToolCall: "Edited a file",
  writeToolCall: "Wrote a file",
  readToolCall: "Read a file",
  searchToolCall: "Searched the workspace",
  grepToolCall: "Searched the workspace",
  globToolCall: "Listed matching files",
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
  const bareTool = tool.replace(MCP_SERVER_ALIAS_PREFIX, "");
  const known = describeLetAgentsTool(bareTool, inputRecord, outcome);
  if (known) return known;
  const nativeHeadline = NATIVE_TOOL_HEADLINES[bareTool];
  if (nativeHeadline) return action(nativeHeadline, inputRecord, bareTool);
  return action(bareTool, inputRecord, bareTool);
}
