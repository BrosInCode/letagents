import type { Message } from "../db.js";
import { createBoundedExecutor } from "../bounded-async.js";

export interface CanonicalMessageCatchUp {
  messages: Message[];
  has_more: boolean;
}

const runCatchUp = createBoundedExecutor({
  label: "shared room message gap catch-up",
  maxConcurrent: 64,
  maxQueued: 512,
  timeoutMs: 10_000,
});
const pending = new Map<string, Promise<CanonicalMessageCatchUp>>();
const loaderIds = new WeakMap<object, number>();
let loaderSequence = 0;

function loaderId(loader: object): number {
  let id = loaderIds.get(loader);
  if (!id) {
    id = ++loaderSequence;
    loaderIds.set(loader, id);
  }
  return id;
}

/**
 * A broker gap is room history, not subscriber state. Coalesce the canonical
 * durable read once; each caller applies its account/session overlay after it
 * returns. The loader identity keeps injected tests and alternate stores
 * isolated while preserving process-wide production coalescing.
 */
export function getCanonicalRoomMessageCatchUp(input: {
  roomId: string;
  after?: string;
  limit?: number;
  includePromptOnly: boolean;
  load: (roomId: string, after?: string, options?: {
    limit?: number;
    include_prompt_only?: boolean;
  }) => Promise<CanonicalMessageCatchUp>;
}): Promise<CanonicalMessageCatchUp> {
  const key = JSON.stringify([
    loaderId(input.load),
    input.roomId,
    input.after ?? null,
    input.limit ?? null,
    input.includePromptOnly,
  ]);
  const existing = pending.get(key);
  if (existing) return existing;
  const work = runCatchUp(() => input.load(input.roomId, input.after, {
    limit: input.limit,
    include_prompt_only: input.includePromptOnly,
  })).finally(() => {
    if (pending.get(key) === work) pending.delete(key);
  });
  pending.set(key, work);
  return work;
}
