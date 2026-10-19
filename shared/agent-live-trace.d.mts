/** The fields of one live stream event that the fold reads. */
export type AgentLiveStreamEventShape = {
  observedAt: string;
  kind: string;
  method: string;
  summary: string | null;
  payload: unknown;
};

/**
 * A folded, renderable view of an agent's ephemeral live feed: reasoning and
 * assistant-text blocks (deltas concatenated per part) and tool-call cards
 * (upserted by call id).
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

/** The text block one live event adds to, keyed as the fold keys it; null for other events. */
export function liveStreamTextPart(event: Pick<AgentLiveStreamEventShape, "method" | "payload">): { kind: "reasoning" | "message"; id: string } | null;

export function foldAgentStreamEvents(
  events: readonly AgentLiveStreamEventShape[],
  ended?: boolean,
): AgentLiveTranscript;

/**
 * A human reading of one live tool call. `kind: "reply"` marks the turn's
 * published room reply (complete_room_turn); everything else is an action
 * with an optional one-line detail.
 */
export interface LiveToolPresentation {
  kind: "reply" | "action";
  headline: string;
  detail: string | null;
  replyText: string | null;
  /** Bare tool name with transport prefixes stripped, for the raw expander. */
  toolName: string;
}

export function describeLiveToolCall(
  tool: string,
  input: unknown,
  outcome?: { status: string; output: unknown; error: string | null },
): LiveToolPresentation;

export type LiveAction = { item: Extract<LiveTranscriptItem, { kind: "tool" }>; tool: LiveToolPresentation };
export type LiveTraceEntry =
  | { kind: "actions"; id: string; actions: LiveAction[]; category: "read" | "search" | null }
  | { kind: "message" | "reasoning"; id: string; text: string };

export function presentAgentTrace(
  items: readonly LiveTranscriptItem[],
  supportsReasoning: boolean | null,
  inspectedGroups?: ReadonlyMap<string, string>,
): LiveTraceEntry[];

export function liveActionStatus(status: string, current: boolean): string;

export const ROOM_LIVE_SNAPSHOT_VERSION: 1;
export const ROOM_LIVE_LIMITS: Readonly<{ entries: number; textChars: number; headlineChars: number; snapshotBytes: number }>;
export type RoomLiveState = "working" | "ended";
export type RoomLiveActionStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
export type RoomLiveToolKind = "shell" | "read" | "search" | "edit" | "room" | "reply" | "web" | "agent" | "plan" | "other";
export const ROOM_LIVE_STATES: readonly RoomLiveState[];
export const ROOM_LIVE_ACTION_STATUSES: readonly RoomLiveActionStatus[];
export const ROOM_LIVE_TOOL_KINDS: readonly RoomLiveToolKind[];

export type RoomLiveEntry =
  | { kind: "note" | "update"; id: string; text: string }
  | { kind: "action"; id: string; headline: string; status: RoomLiveActionStatus; tool: RoomLiveToolKind; count: number };

/** What other members of the room may see of one turn. */
export interface RoomLiveSnapshot {
  version: 1;
  state: RoomLiveState;
  started_at: string;
  ended_at: string | null;
  /** The room message the agent is answering: a reference only, never its text. */
  request_message_id: string | null;
  /** Older entries of the turn were left out to keep the snapshot small. */
  omitted_earlier: boolean;
  entries: RoomLiveEntry[];
}

/** Fixed headline, status and icon kind for one tool call: never its input, output or error. */
export function describeRoomLiveToolCall(
  item: Extract<LiveTranscriptItem, { kind: "tool" }>,
): { headline: string; status: RoomLiveActionStatus; tool: RoomLiveToolKind };

/** The room's entries for one turn, before the publisher redacts and bounds their text. */
export function roomLiveTraceEntries(
  items: readonly LiveTranscriptItem[],
  supportsReasoning: boolean | null,
  /** False for a text block that lost its beginning: it is left out whole. */
  textIntact?: (item: Extract<LiveTranscriptItem, { kind: "reasoning" | "message" }>) => boolean,
): RoomLiveEntry[];

/** Text without the characters a stored snapshot refuses; carriage returns become line breaks. */
export function withoutRoomLiveControls(value: string | null | undefined): string;
/** The stored shape, or an Error that names what is wrong. */
export function normalizeRoomLiveSnapshot(value: unknown): RoomLiveSnapshot;
/** The stored shape, or null. */
export function readRoomLiveSnapshot(value: unknown): RoomLiveSnapshot | null;
