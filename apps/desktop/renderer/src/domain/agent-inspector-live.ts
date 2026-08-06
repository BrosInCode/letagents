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
