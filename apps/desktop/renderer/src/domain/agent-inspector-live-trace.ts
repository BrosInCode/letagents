import { describeLiveToolCall, type LiveToolPresentation, type LiveTranscriptItem } from "./agent-inspector-live";
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

export type LiveAction = { item: Extract<LiveTranscriptItem, { kind: "tool" }>; tool: LiveToolPresentation };
export type LiveTraceEntry =
  | { kind: "actions"; id: string; actions: LiveAction[]; category: "read" | "search" | null }
  | { kind: "message" | "reasoning"; id: string; text: string };

/** Only adjacent, successful exploration is compacted. Commentary, failures,
 * edits and ongoing calls keep their exact place and remain individually visible. */
export function presentAgentTrace(
  items: readonly LiveTranscriptItem[],
  supportsReasoning: boolean | null,
  inspectedGroups: ReadonlyMap<string, string> = new Map(),
): LiveTraceEntry[] {
  const entries: LiveTraceEntry[] = [];
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

export function liveActionStatus(status: string, current: boolean): string {
  if (!current && ["pending", "running"].includes(status)) return "No finish recorded";
  if (status === "pending") return "Requested";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "error" || status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return status.replace(/[_-]+/g, " ");
}

export function formatLiveValue(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === "{}" ? "" : text;
  } catch { return ""; }
}
