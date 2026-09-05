import type { ProviderActionStreamEvent } from "./provider-action-port.js";
import type { DaemonManifestEntry } from "./types.js";

export type SupervisedWaitEvidence = { roomCursor: string; agentSessionId: string };
type PollActivityLike = Pick<ProviderActionStreamEvent, "method" | "payload">;

export function providerStreamLifecycle(event: ProviderActionStreamEvent): "failed" | "terminal" | "idle" | "working" {
  const method = event.method.trim();
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const nestedStatus = (value: unknown): unknown[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
    const record = value as Record<string, unknown>;
    return [value, record.type, record.status];
  };
  const statuses = [
    payload.status,
    payload.subtype,
    payload.threadStatus,
    payload.turnStatus,
    (payload.thread as Record<string, unknown> | undefined)?.status,
    (payload.turn as Record<string, unknown> | undefined)?.status,
    (payload.latestTurn as Record<string, unknown> | undefined)?.status,
    (payload.item as Record<string, unknown> | undefined)?.status,
  ].flatMap(nestedStatus);
  const item = payload.item as Record<string, unknown> | undefined;
  const failedMcpToolCall = /^item\/completed$/i.test(method)
    && item?.type === "mcpToolCall"
    && (item.status === "failed" || Boolean(item.error));
  // A tool can fail while the provider process and persistent worker turn are
  // healthy. Room-poll or checkpoint timeouts are coordination evidence.
  if (failedMcpToolCall) {
    const failedToolName = [item?.tool, item?.name, item?.toolName, item?.tool_name];
    const failedRoomWait = failedToolName.some((value) => typeof value === "string"
      && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages"));
    return failedRoomWait ? "idle" : "working";
  }
  // Item/command failures are execution evidence, not runtime-death evidence.
  // Scope ALL generic failure checks, including method suffixes and nested
  // item.error. Keep existing successful-completion presence signals intact.
  // Do not exempt arbitrary process/terminal errors.
  const executionScoped = /^(?:item\/|command\/exec(?:\/|$))/i.test(method) || event.kind === "tool_lifecycle";
  // The Claude adapter labels only recognized turn-limit errors as lifecycle
  // events. Keep their failure payload intact, but never fence the session
  // ("terminal" would still fence legacy mcp_polling continuations).
  if (event.provider === "claude-code" && event.kind === "turn_lifecycle" && /^result\/error_/.test(method)) return "idle";
  // Codex turn failure is an exact terminal turn outcome, not app-server
  // failure. The coordinator preserves the observed terminal edge for legacy
  // cutover, then maps it to runtime-idle without fencing the reusable server.
  // Transcript snapshots may carry the same turn-scoped result without a live
  // turn notification, but hard thread failure evidence always wins.
  const codexTranscript = event.provider === "codex"
    && event.kind === "transcript_snapshot"
    && /^thread\/read$/i.test(method);
  const codexTranscriptRuntimeFailure = codexTranscript
    && [payload.threadStatus, (payload.thread as Record<string, unknown> | undefined)?.status]
      .flatMap(nestedStatus)
      .some((value) => typeof value === "string"
        && /^(?:systemError|error|error_during_execution|failed)$/i.test(value));
  if (codexTranscriptRuntimeFailure) return "failed";
  const codexTurnFailure = event.provider === "codex" && (
    event.kind === "turn_lifecycle" && (
      /^turn\/failed$/i.test(method)
      || /^turn\/completed$/i.test(method)
        && statuses.some((value) => typeof value === "string" && /^failed$/i.test(value))
    )
    || codexTranscript
      && nestedStatus((payload.latestTurn as Record<string, unknown> | undefined)?.status)
        .some((value) => typeof value === "string" && /^failed$/i.test(value))
  );
  if (codexTurnFailure) return "terminal";
  const failedStatus = statuses.some((value) => typeof value === "string" && /^(?:systemError|error|error_during_execution|failed)$/i.test(value));
  const failedMethod = /(?:^|\/)(?:failed|systemError|error_during_execution)$/i.test(method);
  const failedResult = /^result(?:\/|$)/i.test(method) && (payload.is_error === true || failedStatus);
  const failedItem = /^item\/completed$/i.test(method)
    && Boolean((payload.item as Record<string, unknown> | undefined)?.error);
  if (failedMethod
    || failedResult
    || failedItem
    || failedStatus && /^(?:result|turn|thread|item)(?:\/|$)/i.test(method)
    || event.kind === "error" && /^(?:result|turn|thread|item)(?:\/|$)/i.test(method)) return executionScoped ? "working" : "failed";
  if (/^(?:result(?:\/success)?|turn\/completed|thread\/completed)$/i.test(method)) return "terminal";
  if (/(?:completed|finished|idle|stopped|interrupted)$/i.test(method)) return "idle";
  return "working";
}

export function isHumanRoomActivityEvent(event: ProviderActionStreamEvent): boolean {
  const method = event.method.trim().toLowerCase();
  return method !== "thread/read"
    && method !== "account/ratelimits/updated";
}

export function isAgentInspectorLiveDisplayEvent(event: Pick<ProviderActionStreamEvent, "method">): boolean {
  return event.method === "reasoning/summaryTextDelta"
    || event.method === "item/reasoning/summaryTextDelta"
    || event.method === "item/agentMessage/delta"
    || event.method === "item/toolCall/updated";
}

/** Durable, set-once ready stamp for a manifest entry. */
export function resolveReadyReachedAt(
  current: Pick<DaemonManifestEntry, "desired_state" | "observed_state" | "condition" | "ready_reached_at">,
  clearsCoordinationLatch: boolean,
  now: string,
): string | null {
  if (current.ready_reached_at) return current.ready_reached_at;
  const resultingObserved = clearsCoordinationLatch ? "working" : current.observed_state;
  const resultingCondition = clearsCoordinationLatch ? "none" : current.condition;
  const reachedReady = current.desired_state === "running"
    && resultingCondition === "none"
    && (resultingObserved === "working" || resultingObserved === "idle" || resultingObserved === "checkpointing");
  return reachedReady ? now : null;
}

export function isSupervisedWaitProviderEvent(event: ProviderActionStreamEvent): boolean {
  const isWaitName = (value: unknown): boolean => typeof value === "string"
    && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages");
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" && isWaitName(record.name)) return true;
    if (event.method === "item/started" && record.type === "mcpToolCall") {
      if ([record.tool, record.name, record.toolName, record.tool_name].some(isWaitName)) return true;
    }
    return Object.values(record).some((child) => visit(child, depth + 1));
  };
  return visit(event.payload, 0);
}

function supervisedWaitToolUseIds(event: PollActivityLike): Set<string> {
  const ids = new Set<string>();
  const isWaitName = (value: unknown): boolean => typeof value === "string"
    && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages");
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const waitTool = record.type === "tool_use" && isWaitName(record.name)
      || event.method === "item/started" && record.type === "mcpToolCall"
        && [record.tool, record.name, record.toolName, record.tool_name].some(isWaitName);
    if (waitTool) {
      for (const candidate of [record.id, record.tool_use_id, record.callId, record.call_id, record.toolCallId, record.tool_call_id]) {
        if (typeof candidate === "string" && candidate.trim()) ids.add(candidate.trim());
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(event.payload, 0);
  return ids;
}

function parsedWaitResult(value: unknown, depth = 0): { empty: boolean } | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try { return parsedWaitResult(JSON.parse(trimmed), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = parsedWaitResult(item, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.is_error === true || record.error) return null;
  if (Array.isArray(record.messages)) return { empty: record.messages.length === 0 };
  for (const key of ["content", "text", "tool_use_result", "result", "structuredContent", "output"]) {
    const result = parsedWaitResult(record[key], depth + 1);
    if (result) return result;
  }
  return null;
}

function supervisedToolResults(event: PollActivityLike): Array<{ toolUseId: string; empty: boolean }> {
  const results: Array<{ toolUseId: string; empty: boolean }> = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
      const parsed = parsedWaitResult(record);
      if (parsed) results.push({ toolUseId: record.tool_use_id, empty: parsed.empty });
    }
    if (event.method === "item/completed"
      && record.type === "mcpToolCall"
      && typeof record.id === "string"
      && record.status !== "failed"
      && !record.error) {
      const parsed = parsedWaitResult(record.result);
      if (parsed) results.push({ toolUseId: record.id, empty: parsed.empty });
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(event.payload, 0);
  return results;
}

function isThinkingOnlyAssistantEvent(event: PollActivityLike): boolean {
  if (event.method !== "assistant" || !event.payload || typeof event.payload !== "object") return false;
  const payload = event.payload as Record<string, unknown>;
  const message = payload.message;
  if (!message || typeof message !== "object") return false;
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) && content.length > 0 && content.every((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).type === "thinking");
}

function correlatedWaitResult(event: PollActivityLike, history: readonly PollActivityLike[]): "empty" | "nonempty" | null {
  const waitIds = new Set(history.flatMap((candidate) => [...supervisedWaitToolUseIds(candidate)]));
  const correlated = supervisedToolResults(event).filter((result) => waitIds.has(result.toolUseId));
  if (correlated.some((result) => !result.empty)) return "nonempty";
  return correlated.some((result) => result.empty) ? "empty" : null;
}

function isCorrelatedEmptyWaitResult(event: PollActivityLike, history: readonly PollActivityLike[]): boolean {
  return correlatedWaitResult(event, history) === "empty";
}

export function isCorrelatedNonemptyWaitResult(event: PollActivityLike, history: readonly PollActivityLike[]): boolean {
  return correlatedWaitResult(event, history) === "nonempty";
}

function isCorrelatedWaitProgress(event: PollActivityLike, history: readonly PollActivityLike[]): boolean {
  if (event.method !== "item/mcpToolCall/progress" || !event.payload || typeof event.payload !== "object") return false;
  const itemId = (event.payload as Record<string, unknown>).itemId;
  if (typeof itemId !== "string" || !itemId.trim()) return false;
  const waitIds = new Set(history.flatMap((candidate) => [...supervisedWaitToolUseIds(candidate)]));
  return waitIds.has(itemId.trim());
}

/** Keep the whole empty room-poll handoff quiet, not only the wait tool-use. */
export function isSupervisedQuietPollContinuation(
  event: PollActivityLike,
  history: readonly PollActivityLike[],
): boolean {
  const recent = history.slice(-8);
  if (isCorrelatedWaitProgress(event, recent)) return true;
  if (isCorrelatedEmptyWaitResult(event, recent)) return true;
  if (!isThinkingOnlyAssistantEvent(event)) return false;
  const prior = recent.at(-1);
  return prior ? isCorrelatedEmptyWaitResult(prior, recent.slice(0, -1)) : false;
}

/** Compatibility cursor evidence for the currently published MCP runtime. */
export function supervisedWaitEvidenceFromProviderEvent(event: ProviderActionStreamEvent): SupervisedWaitEvidence | null {
  const visit = (value: unknown, depth: number): SupervisedWaitEvidence | null => {
    if (depth > 8 || !value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const cursor = visit(item, depth + 1);
        if (cursor) return cursor;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const input = record.input;
    const name = typeof record.name === "string" ? record.name : "";
    if (record.type === "tool_use"
      && (name === "wait_for_messages" || name === "mcp__letagents__wait_for_messages")
      && input && typeof input === "object" && !Array.isArray(input)) {
      const cursor = (input as Record<string, unknown>).after_message_id;
      const agentSessionId = (input as Record<string, unknown>).agent_session_id;
      if (typeof cursor === "string" && /^msg_\d+$/.test(cursor)
        && typeof agentSessionId === "string" && agentSessionId.trim()) {
        return { roomCursor: cursor, agentSessionId: agentSessionId.trim() };
      }
    }
    for (const child of Object.values(record)) {
      const cursor = visit(child, depth + 1);
      if (cursor) return cursor;
    }
    return null;
  };
  return visit(event.payload, 0);
}

export function supervisedWaitCursorFromProviderEvent(event: ProviderActionStreamEvent): string | null {
  return supervisedWaitEvidenceFromProviderEvent(event)?.roomCursor ?? null;
}
