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
      output: string | null;
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
    if (event.method === "reasoning/summaryTextDelta") {
      const partId = payload && typeof payload.partId === "string" ? payload.partId : "reasoning";
      upsertText("reasoning", partId, deltaText(payload, event.summary));
    } else if (event.method === "item/agentMessage/delta") {
      const partId = payload && typeof payload.partId === "string" ? payload.partId : "message";
      // Assistant text deltas carry the real text only in the payload; the
      // summary is a "provider · method" fallback and must not be shown.
      upsertText("message", partId, deltaText(payload, null));
    } else if (event.kind === "tool_lifecycle" && payload) {
      const callId = typeof payload.callID === "string" ? payload.callID
        : typeof payload.partId === "string" ? payload.partId : "tool";
      const key = `tool:${callId}`;
      const next: LiveTranscriptItem = {
        kind: "tool",
        id: callId,
        tool: typeof payload.tool === "string" ? payload.tool : "tool",
        status: typeof payload.status === "string" ? payload.status : "running",
        input: payload.input ?? null,
        output: typeof payload.output === "string" ? payload.output : null,
        error: typeof payload.error === "string" ? payload.error : null,
      };
      const existing = indexById.get(key);
      if (existing === undefined) {
        indexById.set(key, items.length);
        items.push(next);
      } else {
        items[existing] = next;
      }
    }
  }

  return { items, ended };
}
