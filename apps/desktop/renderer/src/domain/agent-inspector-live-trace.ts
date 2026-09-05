import type { AgentInspectorWorkResource } from "./agent-inspector-work";
import { describeRecordedOperation, humanizeAgentInspectorReceiptState, humanizeRecordedTurn } from "./agent-inspector-work";

export function currentAgentRequest(resource: AgentInspectorWorkResource, activeSourceMessageId: string | null) {
  if (!activeSourceMessageId) return null;
  const detail = resource.detail;
  if (detail?.requested_source_message_id === activeSourceMessageId && detail.source_message?.id === activeSourceMessageId) {
    return { sender: detail.source_message.sender || "Room message", text: detail.source_message.text, createdAt: detail.source_message.created_at };
  }
  const item = detail?.items.find(row => row.source_message_id === activeSourceMessageId);
  return item ? { sender: item.sender || "Room message", text: item.text_preview, createdAt: item.created_at } : null;
}

/** Public request/result history; a saved receipt never supplies current activity. */
export function agentLiveTrace(resource: AgentInspectorWorkResource, selectedSourceMessageId: string | null) {
  const detail = resource.detail;
  const exact = Boolean(selectedSourceMessageId && resource.sourceMessageId === selectedSourceMessageId
    && detail?.requested_source_message_id === selectedSourceMessageId
    && detail.availability === "available" && detail.source_message?.id === selectedSourceMessageId);
  const execution = exact ? detail?.recorded_execution : undefined;
  const cards = (resource.status === "unavailable" ? [] : detail?.items ?? []).map(item => {
    const selected = item.source_message_id === selectedSourceMessageId;
    const loaded = selected && exact;
    return {
      id: item.source_message_id, selected, loaded,
      sender: (loaded ? detail?.source_message?.sender : item.sender) || "Room message",
      request: (loaded ? detail?.source_message?.text : item.text_preview) || "Message text unavailable.",
      createdAt: item.created_at, updatedAt: item.updated_at,
      outcome: humanizeAgentInspectorReceiptState(item.state, item.terminal_reason),
      result: loaded ? detail?.terminal?.normalized_text || detail?.receipt?.outcome?.text || item.outcome?.text || null : item.outcome?.text || null,
      error: item.last_error,
      requestMessageId: /^msg_\d+$/.test(item.source_message_id) ? item.source_message_id : null,
      replyMessageId: item.canonical_message_id,
    };
  });
  const state = resource.status === "unavailable" ? "unavailable"
    : resource.status === "error" ? "error"
    : (resource.status === "loading" || resource.status === "idle") && !detail ? "loading"
    : detail?.availability === "pruned" ? "pruned"
    : !cards.length ? "empty" : "ready";
  return {
    cards, state,
    refreshing: resource.status === "refreshing",
    executionState: !exact ? resource.status === "error" ? "unavailable"
      : detail?.requested_source_message_id === selectedSourceMessageId && detail?.availability === "not_loaded" ? "not_loaded"
      : "loading" : execution?.availability ?? "unsupported",
    incomplete: execution?.availability === "available" && execution.evidenceIncomplete,
    truncated: execution?.availability === "available" && execution.truncated,
    turns: execution?.availability === "available" ? execution.turns.map(turn => ({
      id: turn.turnId, label: humanizeRecordedTurn(turn),
      operations: turn.operations.map(row => ({ id: row.executionId, ...describeRecordedOperation(row) })),
    })) : [],
  };
}

export function canPresentCurrentAgentStream(input: {
  active: boolean; startedAt: string | null; activeSourceMessageId: string | null;
}): boolean {
  return input.active && Boolean(input.activeSourceMessageId) && Number.isFinite(Date.parse(input.startedAt ?? ""));
}
