import type { MessageAccountAgentRouting } from "../db/types.js";
import { db } from "../db/client.js";
import {
  getMessageAccountAgentRoutings,
  getMessageAccountRoutingRows,
  MAX_ACCOUNT_ROUTING_ACCOUNTS,
  MAX_ACCOUNT_ROUTING_MESSAGE_ROWS,
  MAX_ACCOUNT_ROUTING_PAIRS,
  resolveGlobalLegacyTargets,
  type GlobalLegacyRoutingPlan,
} from "../db/messages/account-agent-routing.js";
import {
  getMessageThreadReadOverlays,
  MAX_THREAD_READ_OVERLAY_PAIRS,
  type MessageThreadReadOverlay,
} from "../db/messages/thread-read-overlays.js";
import { parseScopedId } from "../db/utils.js";
import { createBoundedExecutor } from "../bounded-async.js";

export interface RoomMessageOverlayTarget {
  accountId: string;
  accountAgentRouting: boolean;
}

export interface RoomMessageAccountOverlay {
  account_agent_routing?: MessageAccountAgentRouting;
  thread_read?: MessageThreadReadOverlay;
}

export interface RoomMessageOverlaySource {
  id: string;
  thread?: {
    root_message_id: string;
    reply_count: number;
  } | null;
}

export interface RoomMessageOverlayBatcher {
  prepare(input: {
    roomId: string;
    message: RoomMessageOverlaySource;
    targets: readonly RoomMessageOverlayTarget[];
  }): Promise<ReadonlyMap<string, RoomMessageAccountOverlay>>;
  prepareMany(input: {
    roomId: string;
    messages: readonly RoomMessageOverlaySource[];
    targets: readonly RoomMessageOverlayTarget[];
    /** Limit retained output to the deterministic account chunk containing this subscriber. */
    target?: RoomMessageOverlayTarget;
  }): Promise<ReadonlyMap<number, ReadonlyMap<string, RoomMessageAccountOverlay>>>;
  close(): void;
}

export interface RoomMessageOverlayBatcherDependencies {
  loadRoutingRows?(
    roomId: string,
    messageNumbers: readonly number[],
  ): ReturnType<typeof getMessageAccountRoutingRows>;
  loadAccountRoutings?(
    roomId: string,
    accountIds: readonly string[],
    rows: Awaited<ReturnType<typeof getMessageAccountRoutingRows>>,
    options?: { legacyRoutingPlan?: GlobalLegacyRoutingPlan },
  ): ReturnType<typeof getMessageAccountAgentRoutings>;
  loadGlobalLegacyRoutingPlan?(
    roomId: string,
    rows: Awaited<ReturnType<typeof getMessageAccountRoutingRows>>,
  ): Promise<GlobalLegacyRoutingPlan>;
  loadThreadReadOverlays?: typeof getMessageThreadReadOverlays;
}

const MAX_PENDING_OVERLAY_BATCHES = 256;
export const MAX_MATERIALIZED_ROOM_MESSAGE_OVERLAY_PAIRS = 100_000;

const runOverlayBatch = createBoundedExecutor({
  label: "room message account overlay",
  maxConcurrent: 32,
  maxQueued: MAX_PENDING_OVERLAY_BATCHES,
  timeoutMs: 8_000,
});

/**
 * Coalesces every subscriber for one canonical broker event into one bounded
 * account-routing query and one thread-read query. The cached value contains
 * only small overlays; the canonical message body remains owned by the broker.
 */
export function createRoomMessageOverlayBatcher(
  dependencies: RoomMessageOverlayBatcherDependencies = {},
): RoomMessageOverlayBatcher {
  type OverlayResult = ReadonlyMap<number, ReadonlyMap<string, RoomMessageAccountOverlay>>;
  type RoutingRows = Awaited<ReturnType<typeof getMessageAccountRoutingRows>>;
  interface PagePlan {
    chunks: Map<string, Promise<OverlayResult>>;
    tail: Promise<void>;
    routingRows: Promise<RoutingRows> | null;
    legacyRoutingPlan: Promise<GlobalLegacyRoutingPlan> | null;
  }
  const pagePlans = new Map<string, PagePlan>();
  const targetPlans = new WeakMap<
    object,
    { normalizedTargets: RoomMessageOverlayTarget[]; batchIdentity: number }
  >();
  let nextTargetPlanIdentity = 0;
  const loadRoutingRows = dependencies.loadRoutingRows
    ?? ((roomId, messageNumbers) => getMessageAccountRoutingRows(db, roomId, messageNumbers));
  const loadAccountRoutings = dependencies.loadAccountRoutings
    ?? ((roomId, accountIds, rows, options) => getMessageAccountAgentRoutings(
      db,
      roomId,
      accountIds,
      rows,
      options,
    ));
  const loadGlobalLegacyRoutingPlan = dependencies.loadGlobalLegacyRoutingPlan
    ?? ((roomId, rows) => resolveGlobalLegacyTargets(
      db,
      roomId,
      rows.filter((row) => row.routing_snapshot_version === null),
    ));
  const loadThreadReadOverlays = dependencies.loadThreadReadOverlays
    ?? getMessageThreadReadOverlays;
  let closed = false;

  const prepareMany: RoomMessageOverlayBatcher["prepareMany"] = ({
    roomId,
    messages,
    targets,
    target,
  }) => {
    if (closed) return Promise.reject(new Error("room message overlay batcher is closed"));
    let targetPlan = targetPlans.get(targets as object);
    if (!targetPlan) {
      const normalizedTargets = normalizeTargets(targets);
      targetPlan = {
        normalizedTargets,
        batchIdentity: ++nextTargetPlanIdentity,
      };
      targetPlans.set(targets as object, targetPlan);
    }
    const { normalizedTargets, batchIdentity } = targetPlan;
    if (normalizedTargets.length === 0 || messages.length === 0) {
      return Promise.resolve(new Map());
    }
    if (normalizedTargets.length > MAX_THREAD_READ_OVERLAY_PAIRS) {
      return Promise.reject(new Error("room message overlay target capacity exceeded"));
    }
    const messageByNumber = new Map<number, RoomMessageOverlaySource>();
    for (const message of messages) {
      const messageNumber = parseScopedId(message.id, "msg");
      if (!messageNumber) return Promise.reject(new Error("invalid broker message id"));
      messageByNumber.set(messageNumber, message);
    }
    const messageNumbers = [...messageByNumber.keys()];
    if (messageNumbers.length > MAX_ACCOUNT_ROUTING_MESSAGE_ROWS) {
      return Promise.reject(new Error("room message overlay message capacity exceeded"));
    }
    const threadTargetByRoot = new Map<string, { root_message_id: string; reply_count: number }>();
    for (const message of messageByNumber.values()) {
      if (!message.thread) continue;
      const existing = threadTargetByRoot.get(message.thread.root_message_id);
      if (!existing || message.thread.reply_count > existing.reply_count) {
        threadTargetByRoot.set(message.thread.root_message_id, {
          root_message_id: message.thread.root_message_id,
          reply_count: message.thread.reply_count,
        });
      }
    }
    const threadTargets = [...threadTargetByRoot.values()];
    const pairDenominator = Math.max(messageNumbers.length, threadTargets.length, 1);
    const targetChunkSize = Math.max(1, Math.min(
      MAX_ACCOUNT_ROUTING_ACCOUNTS,
      Math.floor(MAX_MATERIALIZED_ROOM_MESSAGE_OVERLAY_PAIRS / pairDenominator),
    ));
    let materializedTargets = normalizedTargets;
    let chunkIdentity = "all";
    if (target) {
      const targetIndex = normalizedTargets.findIndex((candidate) =>
        candidate.accountId === target.accountId.trim());
      if (targetIndex < 0) {
        return Promise.reject(new Error("subscriber account overlay target is unavailable"));
      }
      const chunkStart = Math.floor(targetIndex / targetChunkSize) * targetChunkSize;
      materializedTargets = normalizedTargets.slice(chunkStart, chunkStart + targetChunkSize);
      chunkIdentity = `${chunkStart}:${materializedTargets.length}`;
    } else if (
      normalizedTargets.length * messageNumbers.length
      > MAX_MATERIALIZED_ROOM_MESSAGE_OVERLAY_PAIRS
    ) {
      return Promise.reject(new Error("room message overlay materialization capacity exceeded"));
    }
    const messageSignature = [...messageByNumber].map(([number, message]) => [
      number,
      message.thread?.root_message_id ?? null,
      message.thread?.reply_count ?? null,
    ]);
    const pageKey = `${roomId}\u0000${JSON.stringify(messageSignature)}\u0000${batchIdentity}`;
    let pagePlan = pagePlans.get(pageKey);
    if (!pagePlan) {
      if (pagePlans.size >= MAX_PENDING_OVERLAY_BATCHES) {
        return Promise.reject(new Error("room message overlay batch capacity exceeded"));
      }
      pagePlan = {
        chunks: new Map(),
        tail: Promise.resolve(),
        routingRows: null,
        legacyRoutingPlan: null,
      };
      pagePlans.set(pageKey, pagePlan);
    }
    const chunkKey = chunkIdentity;
    const existing = pagePlan.chunks.get(chunkKey);
    if (existing) return existing;

    const previousChunk = pagePlan.tail;
    const promise = previousChunk.then(() => runOverlayBatch(async () => {
        const accountIds = materializedTargets.map((target) => target.accountId);
        const routingAccountIds = materializedTargets
          .filter((target) => target.accountAgentRouting)
          .map((target) => target.accountId);
        if (routingAccountIds.length > 0 && !pagePlan!.routingRows) {
          pagePlan!.routingRows = loadRoutingRows(roomId, messageNumbers);
        }
        const routingRows = pagePlan!.routingRows ? await pagePlan!.routingRows : [];
        if (routingAccountIds.length > 0 && (
          routingRows.length !== messageNumbers.length
          || new Set(routingRows.map((row) => Number(row.number))).size !== messageNumbers.length
          || routingRows.some((row) => !messageByNumber.has(Number(row.number)))
        )) {
          throw new Error("broker message routing row is unavailable");
        }
        const routings = new Map<string, Map<number, MessageAccountAgentRouting>>();
        if (routingRows.length > 0) {
          if (
            routingRows.some((row) => row.routing_snapshot_version === null)
            && !pagePlan!.legacyRoutingPlan
          ) {
            pagePlan!.legacyRoutingPlan = loadGlobalLegacyRoutingPlan(roomId, routingRows);
          }
          const legacyRoutingPlan = pagePlan!.legacyRoutingPlan
            ? await pagePlan!.legacyRoutingPlan
            : undefined;
          const routingChunkSize = Math.max(1, Math.min(
            MAX_ACCOUNT_ROUTING_ACCOUNTS,
            Math.floor(MAX_ACCOUNT_ROUTING_PAIRS / messageNumbers.length),
          ));
          for (const accountChunk of chunksOf(routingAccountIds, routingChunkSize)) {
            const loadedRoutings = await loadAccountRoutings(
              roomId,
              accountChunk,
              routingRows,
              { legacyRoutingPlan },
            );
            for (const [accountId, byMessage] of loadedRoutings) routings.set(accountId, byMessage);
          }
        }
        const readOverlays = new Map<string, Map<string, MessageThreadReadOverlay>>();
        if (threadTargets.length > 0) {
          const readChunkSize = Math.max(1, Math.floor(
            MAX_THREAD_READ_OVERLAY_PAIRS / threadTargets.length,
          ));
          for (const accountChunk of chunksOf(accountIds, readChunkSize)) {
            const loadedReads = await loadThreadReadOverlays(roomId, threadTargets, accountChunk);
            for (const [accountId, byRoot] of loadedReads) readOverlays.set(accountId, byRoot);
          }
        }
        const result = new Map<number, ReadonlyMap<string, RoomMessageAccountOverlay>>();
        for (const [messageNumber, message] of messageByNumber) {
          const byAccount = new Map<string, RoomMessageAccountOverlay>();
          for (const target of materializedTargets) {
            const routing = target.accountAgentRouting
              ? routings.get(target.accountId)?.get(messageNumber)
              : undefined;
            if (target.accountAgentRouting && !routing) {
              throw new Error("broker account routing overlay is unavailable");
            }
            const threadRead = message.thread
              ? readOverlays.get(target.accountId)?.get(message.thread.root_message_id)
              : undefined;
            if (message.thread && !threadRead) {
              throw new Error("broker thread read overlay is unavailable");
            }
            byAccount.set(target.accountId, {
              ...(routing ? { account_agent_routing: routing } : {}),
              ...(threadRead ? { thread_read: threadRead } : {}),
            });
          }
          result.set(messageNumber, byAccount);
        }
        return result;
    }));
    pagePlan.tail = promise.then(() => undefined, () => undefined);
    pagePlan.chunks.set(chunkKey, promise);
    // Coalesce only genuinely concurrent subscribers. Receipt-successor and
    // legacy ambiguity depend on live session state, so retaining a settled
    // value—even briefly—can replay stale authority after a rotation.
    void promise.then(
      () => retireChunk(pageKey, pagePlan!, chunkKey, promise),
      () => retireChunk(pageKey, pagePlan!, chunkKey, promise),
    );
    return promise;
  };

  return {
    async prepare({ roomId, message, targets }) {
      const messageNumber = parseScopedId(message.id, "msg");
      if (!messageNumber) throw new Error("invalid broker message id");
      return (await prepareMany({ roomId, messages: [message], targets })).get(messageNumber)
        ?? new Map();
    },
    prepareMany,
    close() {
      if (closed) return;
      closed = true;
      pagePlans.clear();
    },
  };

  function retireChunk(
    pageKey: string,
    pagePlan: PagePlan,
    chunkKey: string,
    promise: Promise<OverlayResult>,
  ): void {
    if (pagePlan.chunks.get(chunkKey) === promise) pagePlan.chunks.delete(chunkKey);
    if (pagePlan.chunks.size > 0) return;
    queueMicrotask(() => {
      if (pagePlan.chunks.size === 0 && pagePlans.get(pageKey) === pagePlan) {
        pagePlans.delete(pageKey);
      }
    });
  }
}

function normalizeTargets(
  targets: readonly RoomMessageOverlayTarget[],
): RoomMessageOverlayTarget[] {
  const byAccount = new Map<string, boolean>();
  for (const target of targets) {
    const accountId = target.accountId.trim();
    if (!accountId) continue;
    byAccount.set(accountId, Boolean(byAccount.get(accountId) || target.accountAgentRouting));
  }
  return [...byAccount]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountId, accountAgentRouting]) => ({ accountId, accountAgentRouting }));
}

function chunksOf<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}
