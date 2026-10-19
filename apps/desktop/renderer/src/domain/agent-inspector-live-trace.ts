import type { LiveAction } from "../../../../../shared/agent-live-trace.mjs";
import type { AgentInspectorWorkResource } from "./agent-inspector-work";

// The owner's trace and the room's are presented by the same shared code.
export { liveActionStatus, presentAgentTrace } from "../../../../../shared/agent-live-trace.mjs";
export type { LiveAction, LiveTraceEntry } from "../../../../../shared/agent-live-trace.mjs";

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

export function liveActionFailure(action: LiveAction) {
  const { item, tool } = action;
  if (!["error", "failed"].includes(item.status) && !item.error) return null;
  const message = item.error?.trim() || "The tool failed without providing an error message.";
  const shell = tool.toolName === "shellToolCall";
  const output = typeof item.output === "string" ? item.output.trim() : "";
  const outputPreview = shell && output ? output.split("\n").slice(-4).join("\n").slice(-600) : null;
  return {
    message: message.length > 1_200 ? `${message.slice(0, 1_200)}…` : message,
    outputPreview,
    detail: shell && !output
      ? "Command output is unavailable, so the failing step could not be identified."
      : null,
  };
}

export function formatLiveValue(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === "{}" ? "" : text;
  } catch { return ""; }
}
