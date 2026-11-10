import { getMessageStreamCheckpoint } from "../../../db/messages/checkpoint.js";
import { parseScopedId } from "../../../db/utils.js";
import { messageEvents } from "../../../server/events.js";

type CheckpointReader = typeof getMessageStreamCheckpoint;
const reads = new WeakMap<CheckpointReader, Map<string, ReturnType<CheckpointReader>>>();

/**
 * With no `message:routed` event, a blocked frame reads again this often. The
 * event (a routing job finished, a reply turn released, on any API instance)
 * is the normal wake; this only covers a lost event or a hold that passed its
 * deadline before the hold sweep ran.
 */
export const ROUTING_WAIT_FALLBACK_MS = 2_000;
export const REPLY_TURN_WAIT_FALLBACK_MS = 1_000;

interface RoomWaiters {
  /** Changes on every routed event, so reads begun before it are never shared after it. */
  generation: number;
  wakes: Set<() => void>;
}
const roomWaiters = new Map<string, RoomWaiters>();
let generations = 0;
let listening = false;

function onRouted(event: { projectId?: unknown }): void {
  if (typeof event?.projectId !== "string") return;
  const room = roomWaiters.get(event.projectId);
  if (!room) return;
  room.generation = ++generations;
  for (const wake of [...room.wakes]) wake();
}

/** Keep blocked SSE frames in order without one database read per worker. */
export async function waitForMessageRouting(input: {
  roomId: string;
  messageId: string;
  includePromptOnly: boolean;
  /** A worker's durable agent key: also wait out its held reply turns. */
  holdAgentKey?: string | null;
  closed(): boolean;
  load?: CheckpointReader;
  /** Tests only: the read interval when no event arrives. */
  fallbackMs?: number;
}): Promise<boolean> {
  const load = input.load ?? getMessageStreamCheckpoint;
  const pending = reads.get(load) ?? new Map();
  reads.set(load, pending);
  const holdAgentKey = input.holdAgentKey || null;
  const number = parseScopedId(input.messageId, "msg") ?? 0;
  const fallbackMs = input.fallbackMs ?? (holdAgentKey ? REPLY_TURN_WAIT_FALLBACK_MS : ROUTING_WAIT_FALLBACK_MS);

  if (!listening) {
    messageEvents.on("message:routed", onRouted);
    listening = true;
  }
  let room = roomWaiters.get(input.roomId);
  if (!room) {
    room = { generation: ++generations, wakes: new Set() };
    roomWaiters.set(input.roomId, room);
  }
  const waiters = room;
  let signalled = false;
  let resume: (() => void) | null = null;
  const wake = () => {
    signalled = true;
    resume?.();
  };
  // Subscribed before the first read: an event during the read is not lost.
  waiters.wakes.add(wake);
  try {
    while (!input.closed()) {
      signalled = false;
      const key = JSON.stringify([input.roomId, input.includePromptOnly, holdAgentKey, waiters.generation]);
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
      if (signalled) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, fallbackMs);
        function done() {
          clearTimeout(timer);
          resume = null;
          resolve();
        }
        resume = done;
      });
    }
    return false;
  } finally {
    waiters.wakes.delete(wake);
    if (waiters.wakes.size === 0 && roomWaiters.get(input.roomId) === waiters) roomWaiters.delete(input.roomId);
  }
}
