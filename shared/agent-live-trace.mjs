/**
 * The fold and presentation of a supervised agent's live provider stream.
 * The owner's Live tab and the daemon read the stream with this same code.
 * When the owner shares live activity with the room, the daemon publishes the
 * room version of the trace (roomLiveTraceEntries), and the server checks
 * every snapshot it stores against normalizeRoomLiveSnapshot.
 */

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function deltaText(payload, fallback) {
  if (payload && typeof payload.delta === "string") return payload.delta;
  return typeof fallback === "string" ? fallback : "";
}

const TERMINAL_TOOL_STATUSES = ["completed", "error", "failed", "interrupted"];

/** A lookup in a table of known names that no inherited property (`constructor`, `__proto__`) can answer. */
function ownEntry(table, name) {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * The text block one live event adds to: reasoning summaries and assistant
 * text, keyed exactly as the fold keys them. Null for any other event.
 */
export function liveStreamTextPart(event) {
  const payload = record(event.payload);
  if (event.method === "reasoning/summaryTextDelta" || event.method === "item/reasoning/summaryTextDelta") {
    const id = payload && typeof payload.partId === "string"
      ? payload.partId
      : payload && typeof payload.itemId === "string"
        ? `${payload.itemId}:${typeof payload.summaryIndex === "number" ? payload.summaryIndex : 0}`
        : "reasoning";
    return { kind: "reasoning", id };
  }
  if (event.method === "item/agentMessage/delta") {
    const nativeId = payload && typeof payload.partId === "string" ? payload.partId
      : payload && typeof payload.itemId === "string" ? payload.itemId : "message";
    const id = payload && (typeof payload.turnId === "string" || typeof payload.threadId === "string")
      ? JSON.stringify([payload.threadId ?? null, payload.turnId ?? null, nativeId]) : nativeId;
    return { kind: "message", id };
  }
  return null;
}

/**
 * Fold a raw event list into a transcript. Reasoning/message deltas append to
 * the block keyed by their partId; tool events upsert a card keyed by callID.
 * Order is first-appearance order of each part/call.
 */
export function foldAgentStreamEvents(events, ended = false) {
  const items = [];
  const indexById = new Map();

  const upsertText = (kind, partId, text) => {
    if (!text) return;
    const key = `${kind}:${partId}`;
    const existing = indexById.get(key);
    if (existing === undefined) {
      indexById.set(key, items.length);
      items.push({ kind, id: partId, text });
      return;
    }
    const item = items[existing];
    if (item.kind === kind) item.text += text;
  };

  for (const event of events) {
    const payload = record(event.payload);
    const part = liveStreamTextPart(event);
    if (part?.kind === "reasoning") {
      upsertText("reasoning", part.id, deltaText(payload, event.summary));
    } else if (part?.kind === "message") {
      // Assistant text deltas carry the real text only in the payload; the
      // summary is a "provider · method" fallback and must not be shown.
      upsertText("message", part.id, deltaText(payload, null));
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
      const priorIsTerminal = priorTool ? TERMINAL_TOOL_STATUSES.includes(priorTool.status) : false;
      if (priorIsTerminal && (nextStatus === "running" || nextStatus === "pending")) continue;
      const next = {
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
      if (item.kind === "tool" && ["pending", "running"].includes(item.status)) item.status = "interrupted";
    }
  }

  return {
    items,
    ended,
    startedAt: events.find((event) => Boolean(event.observedAt))?.observedAt ?? null,
    lastActivityAt: [...events].reverse().find((event) => Boolean(event.observedAt))?.observedAt ?? null,
  };
}

/** Providers publish MCP tools under a per-turn hashed server alias. */
// 12+ hex digits: long enough that hex-spellable English words ("facade",
// "decade") never match; production aliases are 24 hex, test fixtures 12.
const MCP_SERVER_ALIAS_PREFIX = /^letagents[-_]supervised[-_][0-9a-f]{12,}[-_]/i;

const SALIENT_ARG_KEYS = [
  "command", "cmd", "text", "message", "title", "name", "description", "path",
  "file_path", "query", "pattern", "status", "room", "room_id", "url",
];

function firstSalientArg(args) {
  if (!args) return null;
  for (const key of SALIENT_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return truncateDetail(value);
  }
  return null;
}

function truncateDetail(value) {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > 140 ? `${flattened.slice(0, 139)}…` : flattened;
}

function stringArg(args, key) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Domain sentences for the LetAgents room tools an agent uses mid-turn. */
function describeLetAgentsTool(bareTool, args, outcome) {
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
    default: {
      const labels = ownEntry(ROOM_TOOL_HEADLINES, bareTool);
      if (!labels) return null;
      const status = outcome?.status;
      const headline = status === "pending" ? `Requested: ${labels.request}`
        : status === "running" ? labels.running
        : status === "error" || status === "failed" ? `Failed: ${labels.request}`
        : status === "interrupted" ? `Interrupted: ${labels.request}`
        : labels.complete;
      return action(headline, args, bareTool);
    }
  }
}

const ROOM_TOOL_HEADLINES = {
  update_task: { request: "Update a task", running: "Updating a task", complete: "Updated a task" },
  release_task_lease: { request: "Release a task lease", running: "Releasing a task lease", complete: "Released a task lease" },
  register_task_lease_action_intent: { request: "Register a task lease action", running: "Registering a task lease action", complete: "Registered a task lease action" },
  send_message: { request: "Send a room message", running: "Sending a room message", complete: "Sent a room message" },
  send_thread_message: { request: "Send a thread reply", running: "Sending a thread reply", complete: "Sent a thread reply" },
  post_status: { request: "Post a status update", running: "Posting a status update", complete: "Posted a status update" },
  post_reasoning: { request: "Share reasoning in the room", running: "Sharing reasoning in the room", complete: "Shared reasoning in the room" },
  add_task: { request: "Add a board task", running: "Adding a board task", complete: "Added a board task" },
  get_board: { request: "Read the room board", running: "Reading the room board", complete: "Read the room board" },
  get_board_settings: { request: "Read the board settings", running: "Reading the board settings", complete: "Read the board settings" },
  get_current_room: { request: "Check the current room", running: "Checking the current room", complete: "Checked the current room" },
  check_repo: { request: "Check the repository", running: "Checking the repository", complete: "Checked the repository" },
  wait_for_messages: { request: "Wait for room messages", running: "Waiting for room messages", complete: "Waited for new room messages" },
};

function containsAcceptedResult(value, depth = 0) {
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

function action(headline, args, toolName) {
  return { kind: "action", headline, detail: firstSalientArg(args), replyText: null, toolName };
}

/** Headlines for the provider's own (non-MCP) tool surfaces. */
const NATIVE_TOOL_HEADLINES = {
  shellToolCall: { running: "Running a shell command", complete: "Ran a shell command" },
  terminalToolCall: { running: "Running a shell command", complete: "Ran a shell command" },
  editToolCall: { running: "Editing a file", complete: "Edited a file" },
  writeToolCall: { running: "Writing a file", complete: "Wrote a file" },
  readToolCall: { running: "Reading a file", complete: "Read a file" },
  searchToolCall: { running: "Searching the workspace", complete: "Searched the workspace" },
  grepToolCall: { running: "Searching the workspace", complete: "Searched the workspace" },
  globToolCall: { running: "Listing matching files", complete: "Listed matching files" },
};

/** The bare name of a live tool, without the MCP wrapper or the per-turn server alias. */
function bareLiveToolName(tool, inputRecord) {
  if (tool === "mcpToolCall" && inputRecord && typeof inputRecord.name === "string") {
    return inputRecord.name.replace(MCP_SERVER_ALIAS_PREFIX, "");
  }
  return tool.replace(/^mcp__letagents__/, "").replace(MCP_SERVER_ALIAS_PREFIX, "");
}

/**
 * Translate one live tool event into its human reading. Cursor wraps every
 * MCP invocation as `mcpToolCall` with the real tool in `input.name`, so that
 * wrapper is unwrapped first; hashed per-turn server aliases are stripped so
 * the reader sees `complete_room_turn`, never the transport identity.
 */
export function describeLiveToolCall(tool, input, outcome) {
  const inputRecord = record(input);
  if (tool === "mcpToolCall" && inputRecord && typeof inputRecord.name === "string") {
    const bareTool = bareLiveToolName(tool, inputRecord);
    const args = record(inputRecord.args);
    return describeLetAgentsTool(bareTool, args, outcome)
      ?? action(bareTool, args, bareTool);
  }
  const bareTool = bareLiveToolName(tool, inputRecord);
  const known = describeLetAgentsTool(bareTool, inputRecord, outcome);
  if (known) return known;
  const nativeHeadlines = ownEntry(NATIVE_TOOL_HEADLINES, bareTool);
  if (nativeHeadlines) {
    const headline = outcome?.status === "pending" ? `Requested: ${nativeHeadlines.running}`
      : outcome?.status === "running" ? nativeHeadlines.running : nativeHeadlines.complete;
    const status = outcome?.status;
    const operation = /shell|terminal/.test(bareTool) ? "Command"
      : /read/.test(bareTool) ? "File read" : /edit|write/.test(bareTool) ? "File change" : "Search";
    const title = status === "error" || status === "failed" || outcome?.error ? `${operation} failed`
      : status === "interrupted" ? `${operation} interrupted` : headline;
    const changes = Array.isArray(inputRecord?.changes) ? inputRecord.changes : [];
    const paths = changes.flatMap(change => {
      const value = record(change);
      return typeof value?.path === "string" ? [value.path] : [];
    });
    const detail = ["grepToolCall", "searchToolCall", "globToolCall"].includes(bareTool)
      ? [stringArg(inputRecord, "pattern") ?? stringArg(inputRecord, "query"), stringArg(inputRecord, "path")].filter(Boolean).join(" · ")
      : paths.length ? paths.join(", ") : null;
    return { ...action(title, inputRecord, bareTool), ...(detail ? { detail: truncateDetail(detail) } : {}) };
  }
  return action(bareTool, inputRecord, bareTool);
}

/** Only adjacent, successful exploration is compacted. Commentary, failures,
 * edits and ongoing calls keep their exact place and remain individually visible. */
export function presentAgentTrace(items, supportsReasoning, inspectedGroups = new Map()) {
  const entries = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      if (item.kind !== "reasoning" || supportsReasoning !== false) entries.push(item);
      continue;
    }
    const tool = describeLiveToolCall(item.tool, item.input, item);
    const category = item.status === "completed" && !item.error
      ? tool.toolName === "readToolCall" ? "read"
        : ["searchToolCall", "grepToolCall", "globToolCall"].includes(tool.toolName) ? "search" : null
      : null;
    const previous = entries.at(-1);
    // Once inspected, an entry keeps its boundaries as neighboring calls finish.
    // Its keyed disclosure (and any keyboard focus inside it) must stay mounted.
    if (category && previous?.kind === "actions" && previous.category === category
      && inspectedGroups.get(item.id) === inspectedGroups.get(previous.id)) {
      previous.actions.push({ item, tool });
    } else {
      entries.push({ kind: "actions", id: item.id, actions: [{ item, tool }], category });
    }
  }
  return entries;
}

export function liveActionStatus(status, current) {
  if (!current && ["pending", "running"].includes(status)) return "No finish recorded";
  if (status === "pending") return "Requested";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "error" || status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return status.replace(/[_-]+/g, " ");
}

// ---------------------------------------------------------------------------
// The room's version of the trace.

export const ROOM_LIVE_SNAPSHOT_VERSION = 1;
export const ROOM_LIVE_LIMITS = Object.freeze({
  /** Newest entries kept per snapshot; older ones are counted as omitted. */
  entries: 60,
  /** Longest work note or agent update, in UTF-16 units. */
  textChars: 1_200,
  headlineChars: 120,
  /** Largest stored snapshot, as JSON. */
  snapshotBytes: 32 * 1024,
});
export const ROOM_LIVE_STATES = Object.freeze(["working", "ended"]);
export const ROOM_LIVE_ACTION_STATUSES = Object.freeze(["pending", "running", "completed", "failed", "interrupted"]);
export const ROOM_LIVE_TOOL_KINDS = Object.freeze(["shell", "read", "search", "edit", "room", "reply", "web", "agent", "plan", "other"]);

/** Tools of the provider's own surfaces that every member may know were used, by bare name. */
const ROOM_EXTRA_TOOL_HEADLINES = {
  WebSearch: { kind: "web", running: "Searching the web", complete: "Searched the web", operation: "Web search" },
  web_search: { kind: "web", running: "Searching the web", complete: "Searched the web", operation: "Web search" },
  webSearch: { kind: "web", running: "Searching the web", complete: "Searched the web", operation: "Web search" },
  WebFetch: { kind: "web", running: "Reading a web page", complete: "Read a web page", operation: "Web page read" },
  Task: { kind: "agent", running: "Running a sub-agent", complete: "Ran a sub-agent", operation: "Sub-agent" },
  Agent: { kind: "agent", running: "Running a sub-agent", complete: "Ran a sub-agent", operation: "Sub-agent" },
  TodoWrite: { kind: "plan", running: "Updating its plan", complete: "Updated its plan", operation: "Plan update" },
  update_plan: { kind: "plan", running: "Updating its plan", complete: "Updated its plan", operation: "Plan update" },
};

function roomActionStatus(item) {
  if (item.error || item.status === "error" || item.status === "failed") return "failed";
  if (["pending", "running", "completed", "interrupted"].includes(item.status)) return item.status;
  return "completed";
}

/**
 * The headline the room may see for one tool call. It is fixed product
 * language, never the call's arguments, output or error: a known LetAgents or
 * provider tool keeps its own headline, and any other tool (a third-party MCP
 * server, a name the owner chose) is only "a tool".
 */
export function describeRoomLiveToolCall(item) {
  const inputRecord = record(item.input);
  const bareTool = bareLiveToolName(item.tool, inputRecord);
  const status = roomActionStatus(item);
  const outcome = { status: item.status, output: item.output, error: item.error };
  const known = describeLetAgentsTool(bareTool, inputRecord && item.tool === "mcpToolCall" ? record(inputRecord.args) : inputRecord, outcome);
  if (known) return { headline: known.headline, status, tool: known.kind === "reply" ? "reply" : "room" };
  if (ownEntry(NATIVE_TOOL_HEADLINES, bareTool)) {
    const tool = /shell|terminal/.test(bareTool) ? "shell" : /read/.test(bareTool) ? "read"
      : /edit|write/.test(bareTool) ? "edit" : "search";
    return { headline: describeLiveToolCall(item.tool, item.input, outcome).headline, status, tool };
  }
  const extra = ownEntry(ROOM_EXTRA_TOOL_HEADLINES, bareTool);
  if (extra) {
    const headline = status === "failed" ? `${extra.operation} failed`
      : status === "interrupted" ? `${extra.operation} interrupted`
      : status === "pending" ? `Requested: ${extra.running}`
      : status === "running" ? extra.running : extra.complete;
    return { headline, status, tool: extra.kind };
  }
  const headline = status === "failed" ? "A tool failed"
    : status === "interrupted" ? "A tool was interrupted"
    : status === "pending" ? "Requested a tool"
    : status === "running" ? "Using a tool" : "Used a tool";
  return { headline, status, tool: "other" };
}

/**
 * The room's entries for one turn, in the owner's order and grouping: work
 * notes, agent updates, and one headline per action (adjacent successful file
 * reads or searches as one counted entry). Text is returned as the provider
 * wrote it: the publisher redacts and shortens every string before it leaves
 * the machine. Entry ids are positions, so no provider identifier is shared.
 */
export function roomLiveTraceEntries(items, supportsReasoning, textIntact = () => true) {
  const entries = [];
  // A text block whose beginning is no longer known is left out whole:
  // redaction needs the start of a secret to find it.
  const shown = items.filter((item) => item.kind === "tool" || textIntact(item));
  for (const entry of presentAgentTrace(shown, supportsReasoning)) {
    const id = `e${entries.length + 1}`;
    if (entry.kind === "reasoning") { entries.push({ kind: "note", id, text: entry.text }); continue; }
    if (entry.kind === "message") { entries.push({ kind: "update", id, text: entry.text }); continue; }
    if (entry.actions.length > 1) {
      const count = entry.actions.length;
      entries.push({
        kind: "action",
        id,
        headline: entry.category === "read" ? `${count} file reads` : `${count} workspace searches`,
        status: "completed",
        tool: entry.category === "read" ? "read" : "search",
        count,
      });
      continue;
    }
    const described = describeRoomLiveToolCall(entry.actions[0].item);
    entries.push({ kind: "action", id, ...described, count: 1 });
  }
  return entries;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MESSAGE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const CONTROLS = new RegExp(CONTROL.source, "g");

/**
 * Text with every character a stored snapshot refuses replaced by a space:
 * controls other than line breaks and tabs, zero-width marks and
 * bidirectional overrides. Carriage returns become line breaks.
 */
export function withoutRoomLiveControls(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(CONTROLS, " ");
}

function liveString(value, max, multiline) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  if (CONTROL.test(text) || (!multiline && /[\n\t]/.test(text))) return null;
  return text;
}

function timestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The exact shape a stored room snapshot may have. Anything else is refused,
 * with the reason: an unknown key, a field of the wrong kind, a string with
 * control characters or longer than its limit, more entries than the limit,
 * or a snapshot larger than its byte limit. The result holds only known keys.
 */
export function normalizeRoomLiveSnapshot(value) {
  const input = record(value);
  if (!input) throw new Error("live must be an object");
  const allowed = new Set(["version", "state", "started_at", "ended_at", "request_message_id", "omitted_earlier", "entries"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`live.${key} is not allowed`);
  if (input.version !== ROOM_LIVE_SNAPSHOT_VERSION) throw new Error(`live.version must be ${ROOM_LIVE_SNAPSHOT_VERSION}`);
  if (!ROOM_LIVE_STATES.includes(input.state)) throw new Error("live.state must be working or ended");
  const startedAt = timestamp(input.started_at);
  if (!startedAt) throw new Error("live.started_at must be an ISO timestamp");
  const endedAt = input.ended_at === null || input.ended_at === undefined ? null : timestamp(input.ended_at);
  if (input.ended_at !== null && input.ended_at !== undefined && !endedAt) throw new Error("live.ended_at must be an ISO timestamp or null");
  if (input.state === "ended" && !endedAt) throw new Error("an ended live snapshot needs ended_at");
  const requestMessageId = input.request_message_id === null || input.request_message_id === undefined
    ? null : typeof input.request_message_id === "string" && MESSAGE_ID.test(input.request_message_id) ? input.request_message_id : undefined;
  if (requestMessageId === undefined) throw new Error("live.request_message_id must be a message id or null");
  if (input.omitted_earlier !== undefined && typeof input.omitted_earlier !== "boolean") throw new Error("live.omitted_earlier must be a boolean");
  if (!Array.isArray(input.entries)) throw new Error("live.entries must be an array");
  if (input.entries.length > ROOM_LIVE_LIMITS.entries) throw new Error(`live.entries may hold at most ${ROOM_LIVE_LIMITS.entries} entries`);
  const ids = new Set();
  const entries = input.entries.map((candidate, index) => {
    const entry = record(candidate);
    if (!entry) throw new Error(`live.entries[${index}] must be an object`);
    const id = typeof entry.id === "string" && ENTRY_ID.test(entry.id) ? entry.id : null;
    if (!id || ids.has(id)) throw new Error(`live.entries[${index}].id must be a unique short id`);
    ids.add(id);
    if (entry.kind === "note" || entry.kind === "update") {
      for (const key of Object.keys(entry)) if (!["kind", "id", "text"].includes(key)) throw new Error(`live.entries[${index}].${key} is not allowed`);
      const text = liveString(entry.text, ROOM_LIVE_LIMITS.textChars, true);
      if (!text) throw new Error(`live.entries[${index}].text must be text of at most ${ROOM_LIVE_LIMITS.textChars} characters, without control characters`);
      return { kind: entry.kind, id, text };
    }
    if (entry.kind === "action") {
      for (const key of Object.keys(entry)) if (!["kind", "id", "headline", "status", "tool", "count"].includes(key)) throw new Error(`live.entries[${index}].${key} is not allowed`);
      const headline = liveString(entry.headline, ROOM_LIVE_LIMITS.headlineChars, false);
      if (!headline) throw new Error(`live.entries[${index}].headline must be one line of at most ${ROOM_LIVE_LIMITS.headlineChars} characters`);
      if (!ROOM_LIVE_ACTION_STATUSES.includes(entry.status)) throw new Error(`live.entries[${index}].status is not a known status`);
      if (!ROOM_LIVE_TOOL_KINDS.includes(entry.tool)) throw new Error(`live.entries[${index}].tool is not a known tool kind`);
      const count = entry.count === undefined ? 1 : entry.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > 999) throw new Error(`live.entries[${index}].count must be 1 to 999`);
      return { kind: "action", id, headline, status: entry.status, tool: entry.tool, count };
    }
    throw new Error(`live.entries[${index}].kind must be note, update or action`);
  });
  const snapshot = {
    version: ROOM_LIVE_SNAPSHOT_VERSION,
    state: input.state,
    started_at: startedAt,
    ended_at: endedAt,
    request_message_id: requestMessageId,
    omitted_earlier: input.omitted_earlier === true,
    entries,
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > ROOM_LIVE_LIMITS.snapshotBytes) {
    throw new Error(`live snapshot is larger than ${ROOM_LIVE_LIMITS.snapshotBytes} bytes`);
  }
  return snapshot;
}

/** The snapshot, or null when it does not have the stored shape. For readers, which never throw on stored data. */
export function readRoomLiveSnapshot(value) {
  try { return normalizeRoomLiveSnapshot(value); } catch { return null; }
}
