import { setTimeout as delay } from "node:timers/promises";
import { getMessageStreamCheckpoint } from "../../../db/messages/checkpoint.js";
import { parseScopedId } from "../../../db/utils.js";

type CheckpointReader = typeof getMessageStreamCheckpoint;
const reads = new WeakMap<CheckpointReader, Map<string, ReturnType<CheckpointReader>>>();

/** Keep blocked SSE frames in order without one database read per worker. */
export async function waitForMessageRouting(input: {
  roomId: string;
  messageId: string;
  includePromptOnly: boolean;
  /** A worker's durable agent key: also wait out its held reply turns. */
  holdAgentKey?: string | null;
  closed(): boolean;
  load?: CheckpointReader;
}): Promise<boolean> {
  const load = input.load ?? getMessageStreamCheckpoint;
  const pending = reads.get(load) ?? new Map();
  reads.set(load, pending);
  const holdAgentKey = input.holdAgentKey || null;
  const key = JSON.stringify([input.roomId, input.includePromptOnly, holdAgentKey]);
  const number = parseScopedId(input.messageId, "msg") ?? 0;
  let attempt = 0;
  while (!input.closed()) {
    let read = pending.get(key);
    if (!read) {
      read = load(input.roomId, {
        includePromptOnly: input.includePromptOnly,
        waitForRouting: true,
        ...(holdAgentKey ? { holdAgentKey } : {}),
      })
        .finally(() => { pending.delete(key); });
      pending.set(key, read);
    }
    const ready = await read;
    if ((parseScopedId(ready.checkpoint ?? "", "msg") ?? 0) >= number) return !input.closed();
    // A reply-turn hold lasts up to minutes, unlike a routing job, so a
    // per-worker read backs off to one a second instead of four.
    await delay(holdAgentKey ? Math.min(250 * 2 ** attempt++, 1_000) : 250);
  }
  return false;
}
