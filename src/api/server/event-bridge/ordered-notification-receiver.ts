import {
  MAX_NOTIFICATION_ORIGINS,
  MAX_OUTSTANDING_NOTIFICATIONS,
  MAX_QUEUED_NOTIFICATIONS_PER_ORIGIN,
  NOTIFICATION_QUEUE_DEADLINE_MS,
} from "./constants.js";

interface OrderedNotificationWork {
  origin: string;
  roomId: string | null;
  queuedAt: number;
  generation: number;
  previousOrigin: Promise<void>;
  previousGlobalBarrier: Promise<void>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  run: (isCurrent: () => boolean) => Promise<void>;
}

interface OrderedNotificationLane {
  queue: OrderedNotificationWork[];
  running: boolean;
}

export interface OrderedBridgeNotificationReceiver {
  enqueue(input: {
    origin: string;
    roomId: string | null;
    run: (isCurrent: () => boolean) => Promise<void>;
  }): boolean;
  close(): void;
}

/**
 * PostgreSQL preserves notification order on one LISTEN connection, but an
 * async notification callback does not. Data work is ordered per room across
 * publishers, so a slow reference from one pod cannot arrive after a later
 * inline event from another pod. Room-less/global loss work is a listener-wide
 * barrier: it follows all earlier notifications and precedes all later ones.
 */
export function createOrderedBridgeNotificationReceiver(options: {
  onLoss: (reason: string, roomId: string | null) => void;
  maxOrigins?: number;
  maxQueuedPerOrigin?: number;
  maxOutstanding?: number;
  deadlineMs?: number;
  now?: () => number;
}): OrderedBridgeNotificationReceiver {
  const maxOrigins = Math.max(1, options.maxOrigins ?? MAX_NOTIFICATION_ORIGINS);
  const maxQueuedPerOrigin = Math.max(
    1,
    options.maxQueuedPerOrigin ?? MAX_QUEUED_NOTIFICATIONS_PER_ORIGIN,
  );
  const deadlineMs = Math.max(1, options.deadlineMs ?? NOTIFICATION_QUEUE_DEADLINE_MS);
  const maxOutstanding = Math.max(1, options.maxOutstanding ?? MAX_OUTSTANDING_NOTIFICATIONS);
  const now = options.now ?? Date.now;
  const lanes = new Map<string, OrderedNotificationLane>();
  const originTails = new Map<string, Promise<void>>();
  let globalBarrierTail: Promise<void> = Promise.resolve();
  let closed = false;
  let generation = 0;
  let outstanding = 0;

  const drain = async (laneKey: string, lane: OrderedNotificationLane) => {
    if (lane.running) return;
    lane.running = true;
    try {
      while (!closed) {
        const work = lane.queue.shift();
        if (!work) return;
        try {
          if (now() - work.queuedAt >= deadlineMs) {
            options.onLoss("notification_queue_deadline", work.roomId);
            continue;
          }
          // Compose PostgreSQL's per-publisher order, per-room order, and the
          // most recent listener-wide global loss barrier.
          await Promise.all([work.previousOrigin, work.previousGlobalBarrier]);
          if (now() - work.queuedAt >= deadlineMs) {
            options.onLoss("notification_queue_deadline", work.roomId);
            continue;
          }
          const isCurrent = () => !closed && work.generation === generation;
          try {
            await work.run(isCurrent);
            if (!isCurrent()) {
              options.onLoss("notification_receiver_retired", work.roomId);
            }
          } catch (error) {
            console.error("[room event bridge] failed to handle notification", error);
            options.onLoss("notification_handler_failed", work.roomId);
          }
        } finally {
          work.resolveCompletion();
          if (originTails.get(work.origin) === work.completion) {
            originTails.delete(work.origin);
          }
          outstanding = Math.max(0, outstanding - 1);
        }
      }
    } finally {
      lane.running = false;
      if (lanes.get(laneKey) === lane) {
        if (lane.queue.length === 0 || closed) lanes.delete(laneKey);
        else void drain(laneKey, lane);
      }
    }
  };

  return {
    enqueue({ origin, roomId, run }) {
      if (closed) {
        options.onLoss("notification_receiver_closed", roomId);
        return false;
      }
      if (outstanding >= maxOutstanding) {
        options.onLoss("notification_total_overflow", roomId);
        return false;
      }
      const laneKey = roomId ? `room:${roomId}` : `origin:${origin}`;
      let lane = lanes.get(laneKey);
      if (!lane) {
        if (lanes.size >= maxOrigins) {
          options.onLoss("notification_origin_overflow", roomId);
          return false;
        }
        lane = { queue: [], running: false };
        lanes.set(laneKey, lane);
      }
      if (lane.queue.length >= maxQueuedPerOrigin) {
        options.onLoss("notification_queue_overflow", roomId);
        return false;
      }
      const previousOrigin = originTails.get(origin) ?? Promise.resolve();
      // A room-less loss is a receiver-wide boundary: it waits for every
      // notification observed before it, and every notification observed
      // after it waits for the boundary. Ordinary room events retain parallel
      // per-room execution between global boundaries.
      const previousGlobalBarrier = roomId === null
        ? Promise.all([globalBarrierTail, ...originTails.values()]).then(() => undefined)
        : globalBarrierTail;
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      originTails.set(origin, completion);
      if (roomId === null) globalBarrierTail = completion;
      lane.queue.push({
        origin,
        roomId,
        queuedAt: now(),
        generation,
        previousOrigin,
        previousGlobalBarrier,
        completion,
        resolveCompletion,
        run,
      });
      outstanding += 1;
      void drain(laneKey, lane);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      const lostRooms = new Set<string | null>();
      for (const lane of lanes.values()) {
        for (const work of lane.queue) {
          lostRooms.add(work.roomId);
          work.resolveCompletion();
        }
        outstanding = Math.max(0, outstanding - lane.queue.length);
        lane.queue.length = 0;
      }
      lanes.clear();
      originTails.clear();
      for (const roomId of lostRooms) options.onLoss("notification_receiver_closed", roomId);
    },
  };
}
