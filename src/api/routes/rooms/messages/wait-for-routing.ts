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
  closed(): boolean;
  load?: CheckpointReader;
}): Promise<boolean> {
  const load = input.load ?? getMessageStreamCheckpoint;
  const pending = reads.get(load) ?? new Map();
  reads.set(load, pending);
  const key = JSON.stringify([input.roomId, input.includePromptOnly]);
  const number = parseScopedId(input.messageId, "msg") ?? 0;
  while (!input.closed()) {
    let read = pending.get(key);
    if (!read) {
      read = load(input.roomId, { includePromptOnly: input.includePromptOnly, waitForRouting: true })
        .finally(() => { pending.delete(key); });
      pending.set(key, read);
    }
    const ready = await read;
    if ((parseScopedId(ready.checkpoint ?? "", "msg") ?? 0) >= number) return !input.closed();
    await delay(250);
  }
  return false;
}
