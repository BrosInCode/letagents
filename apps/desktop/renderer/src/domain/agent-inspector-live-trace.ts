import type { AgentInspectorWorkResource } from "./agent-inspector-work";

export function currentAgentRequest(resource: AgentInspectorWorkResource, activeSourceMessageId: string | null) {
  if (!activeSourceMessageId) return null;
  const detail = resource.detail;
  if (detail?.requested_source_message_id === activeSourceMessageId && detail.source_message?.id === activeSourceMessageId) {
    return { sender: detail.source_message.sender || "Room message", text: detail.source_message.text, createdAt: detail.source_message.created_at };
  }
  const item = detail?.items.find(row => row.source_message_id === activeSourceMessageId);
  return item ? { sender: item.sender || "Room message", text: item.text_preview, createdAt: item.created_at } : null;
}

export function canPresentCurrentAgentStream(input: {
  active: boolean; startedAt: string | null; activeSourceMessageId: string | null;
}): boolean {
  return input.active && Boolean(input.activeSourceMessageId) && Number.isFinite(Date.parse(input.startedAt ?? ""));
}
