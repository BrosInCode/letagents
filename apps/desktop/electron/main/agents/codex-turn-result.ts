import type { ThreadReadTurn, ThreadReadTurnItem } from "./codex-rpc-client.js";

export const CODEX_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";
const FINAL_AGENT_PHASES = new Set(["final", "final_answer"]);

export type NormalizedCodexTurnResult =
  | { outcome: "reply"; text: string; evidence: "transcript" | "stream" }
  | { outcome: "no_reply"; text: null; evidence: "transcript" | "stream" }
  | { outcome: "unreadable"; text: null; evidence: "none" };

function itemText(item: ThreadReadTurnItem): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  return (item.content ?? [])
    .flatMap((part) => typeof part.text === "string" ? [part.text] : [])
    .join("\n")
    .trim();
}

export function isFinalCodexAgentPhase(value: unknown): boolean {
  return FINAL_AGENT_PHASES.has(String(value ?? "").trim().toLowerCase());
}

export function finalCodexAgentText(items: readonly ThreadReadTurnItem[] | undefined): string | null {
  return [...(items ?? [])]
    .filter((item) => item.type === "agentMessage" && isFinalCodexAgentPhase(item.phase))
    .map(itemText)
    .filter(Boolean)
    .at(-1) || null;
}

function classify(text: string | null, evidence: "transcript" | "stream"): NormalizedCodexTurnResult {
  const normalized = text?.trim() || null;
  if (!normalized) return { outcome: "unreadable", text: null, evidence: "none" };
  if (normalized === CODEX_NO_ROOM_REPLY_SENTINEL) return { outcome: "no_reply", text: null, evidence };
  return { outcome: "reply", text: normalized, evidence };
}

/** Correlates streamed answer evidence by exact thread and turn. */
export class CodexTurnResultAccumulator {
  private readonly turns = new Map<string, { deltas: Map<string, string>; completed: Map<string, string> }>();
  private readonly pendingThreads = new Set<string>();
  private readonly trackedTurns = new Set<string>();

  beginTurnStart(threadId: string): void { this.pendingThreads.add(threadId); }
  bindTurnStart(threadId: string, turnId: string): void {
    this.pendingThreads.delete(threadId);
    this.trackedTurns.add(this.key(threadId, turnId));
    this.clearThreadExceptTracked(threadId);
  }
  abandonTurnStart(threadId: string): void {
    this.pendingThreads.delete(threadId);
    this.clearThreadExceptTracked(threadId);
  }
  track(threadId: string, turnId: string): void { this.trackedTurns.add(this.key(threadId, turnId)); }

  observe(method: string, params: unknown): void {
    const root = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : null;
    if (!root) return;
    const threadId = typeof root.threadId === "string" ? root.threadId : null;
    const turnId = typeof root.turnId === "string" ? root.turnId : null;
    if (!threadId || !turnId) return;
    const key = this.key(threadId, turnId);
    if (!this.pendingThreads.has(threadId) && !this.trackedTurns.has(key)) return;
    if (!/^item\/(?:agentMessage\/delta|completed)$/i.test(method)) return;
    const current = this.turns.get(key) ?? { deltas: new Map<string, string>(), completed: new Map<string, string>() };

    if (/^item\/agentMessage\/delta$/i.test(method)) {
      const itemId = typeof root.itemId === "string" ? root.itemId : "final";
      const delta = typeof root.delta === "string" ? root.delta : "";
      if (delta) current.deltas.set(itemId, `${current.deltas.get(itemId) ?? ""}${delta}`);
    }

    if (/^item\/completed$/i.test(method)) {
      const item = root.item && typeof root.item === "object" && !Array.isArray(root.item)
        ? root.item as ThreadReadTurnItem
        : null;
      if (item?.type === "agentMessage" && isFinalCodexAgentPhase(item.phase)) {
        const text = itemText(item);
        if (text) current.completed.set(item.id || "final", text);
      }
    }
    this.turns.set(key, current);
  }

  normalize(threadId: string, turnId: string, turn: ThreadReadTurn): NormalizedCodexTurnResult {
    const transcript = finalCodexAgentText([...(turn.output ?? []), ...(turn.items ?? [])]);
    if (transcript) return classify(transcript, "transcript");
    const current = this.turns.get(this.key(threadId, turnId));
    const completed = current ? [...current.completed.values()].at(-1) ?? null : null;
    if (completed) return classify(completed, "stream");
    const streamed = current ? [...current.deltas.values()].at(-1)?.trim() || null : null;
    return classify(streamed, "stream");
  }

  clear(threadId: string, turnId: string): void {
    const key = this.key(threadId, turnId);
    this.turns.delete(key);
    this.trackedTurns.delete(key);
  }
  clearAll(): void {
    this.turns.clear();
    this.pendingThreads.clear();
    this.trackedTurns.clear();
  }
  private clearThreadExceptTracked(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of this.turns.keys()) {
      if (key.startsWith(prefix) && !this.trackedTurns.has(key)) this.turns.delete(key);
    }
  }
  private key(threadId: string, turnId: string): string { return `${threadId}\u0000${turnId}`; }
}
