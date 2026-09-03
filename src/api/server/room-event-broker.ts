import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

import type {
  GitHubRoomEvent,
  Message,
  ReasoningSession,
  ReasoningSessionUpdate,
  RoomSharedArtifact,
  Task,
} from "../db.js";
import type { MessageRecipientAgentTarget } from "../db/types.js";
import type { ActivityEvent } from "../rental/activity-emitter.js";
import type { MessageInfoUpdatedEvent } from "./message-info-events.js";
import type { RoomMessageOverlayTarget } from "./room-message-overlays.js";

export type RoomEvent =
  | {
    kind: "message_created";
    roomId: string;
    message: Message;
    /** Compact owner+durable-key audience; exact generation is checked before serialization. */
    recipientAgentTargetSet: ReadonlySet<string>;
  }
  | { kind: "task_updated"; roomId: string; task: Task }
  | { kind: "github_event_updated"; roomId: string; event: GitHubRoomEvent }
  | {
    kind: "reasoning_updated";
    roomId: string;
    session: ReasoningSession;
    update: ReasoningSessionUpdate | null;
  }
  | { kind: "reasoning_removed"; roomId: string; sessionId: string }
  | { kind: "artifact_updated"; roomId: string; artifact: RoomSharedArtifact | null }
  | { kind: "rental_activity_created"; roomId: string; activity: ActivityEvent }
  | { kind: "message_info_updated"; roomId: string; messageIds: string[] | null }
  | { kind: "agent_work_invalidated"; roomId: string }
  | { kind: "agent_approval_invalidated"; roomId: string }
  | { kind: "execution_delegation_invalidated"; roomId: string };

export type RoomEventKind = RoomEvent["kind"];
export const MESSAGE_CREATED_EVENT_KINDS: ReadonlySet<RoomEventKind> = new Set(["message_created"]);

export interface RoomEventEnvelope {
  cursor: string;
  event: RoomEvent;
  /** Internal loss generation used to make replay gaps sticky. */
  lossEpoch: number;
}

export type RoomEventDelivery =
  | { type: "event"; envelope: RoomEventEnvelope }
  | { type: "gap"; cursor: string | null };

interface RoomEventSource {
  emitter: EventEmitter;
  name: string;
  listener: (payload: unknown) => void;
}

interface RoomBuffer {
  events: Array<{ envelope: RoomEventEnvelope; bytes: number } | undefined>;
  head: number;
  bytes: number;
  touchedAt: number;
  lossEpoch: number;
}

export interface RoomEventBridgeLoss {
  roomId?: string | null;
  epoch?: number;
  reason?: string;
}

export interface RoomEventBrokerOptions {
  maxBufferedEventsPerRoom?: number;
  maxBufferedRooms?: number;
  maxQueuedEventsPerSubscriber?: number;
  bufferTtlMs?: number;
  maxBufferedBytesPerRoom?: number;
  maxBufferedBytesTotal?: number;
  maxQueuedBytesPerSubscriber?: number;
  instanceId?: string;
  now?: () => number;
}

export interface RoomEventSubscription {
  /** Safe pre-queue boundary for a subscribe-before-snapshot handshake. */
  readonly checkpointCursor: string | null;
  /** The checkpoint crosses known loss and requires authoritative repair. */
  readonly checkpointGap: boolean;
  next(): Promise<RoomEventDelivery | null>;
  close(): void;
}

interface SubscribeOptions {
  afterCursor?: string | null;
  kinds?: ReadonlySet<RoomEventKind>;
  accept?: (event: RoomEvent) => boolean;
  messageOverlayTarget?: RoomMessageOverlayTarget;
}

interface EventSourceDeps {
  messageEvents: EventEmitter;
  taskEvents: EventEmitter;
  githubRoomEvents?: EventEmitter;
  reasoningEvents: EventEmitter;
  artifactEvents?: EventEmitter;
  rentalActivityEvents: EventEmitter;
  messageInfoEvents: EventEmitter;
  agentWorkEvents?: EventEmitter;
  agentApprovalEvents?: EventEmitter;
  executionDelegationEvents?: EventEmitter;
  bridgeLossEvents?: EventEmitter;
}

const DEFAULT_MAX_BUFFERED_EVENTS_PER_ROOM = 256;
const DEFAULT_MAX_BUFFERED_ROOMS = 1_000;
const DEFAULT_MAX_QUEUED_EVENTS_PER_SUBSCRIBER = 64;
const DEFAULT_BUFFER_TTL_MS = 60_000;
// A supported 6,000-recipient prompt audience retains roughly 1.7 MiB once
// UTF-16 string backing stores and Set entries are counted. Keep one such
// canonical event deliverable while the 64 MiB process cap still bounds the
// number of concurrently retained high-fanout rooms.
const DEFAULT_MAX_BUFFERED_BYTES_PER_ROOM = 2 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES_TOTAL = 64 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES_PER_SUBSCRIBER = 2 * 1024 * 1024;
const RETAINED_SET_BASE_BYTES = 64;
const RETAINED_SET_ENTRY_BYTES = 48;

/**
 * One bridge from process-wide emitters into room-indexed, bounded subscriber
 * queues. Request handlers subscribe here instead of attaching listeners to
 * every global emitter, so dispatch cost is proportional to listeners in the
 * affected room.
 */
export class RoomEventBroker {
  private readonly subscribers = new Map<string, Set<BrokerSubscription>>();
  private readonly overlayTargetSnapshots = new Map<
    string,
    readonly RoomMessageOverlayTarget[]
  >();
  private readonly buffers = new Map<string, RoomBuffer>();
  private readonly uninterestedGaps = new Map<string, number>();
  private readonly sources: RoomEventSource[] = [];
  private readonly maxBufferedEventsPerRoom: number;
  private readonly maxBufferedRooms: number;
  private readonly maxQueuedEventsPerSubscriber: number;
  private readonly bufferTtlMs: number;
  private readonly maxBufferedBytesPerRoom: number;
  private readonly maxBufferedBytesTotal: number;
  private readonly maxQueuedBytesPerSubscriber: number;
  private readonly instanceId: string;
  private readonly now: () => number;
  private sequence = 0;
  private lossSequence = 0;
  private totalBufferedBytes = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: RoomEventBrokerOptions = {}) {
    this.maxBufferedEventsPerRoom = positiveInteger(
      options.maxBufferedEventsPerRoom,
      DEFAULT_MAX_BUFFERED_EVENTS_PER_ROOM,
    );
    this.maxBufferedRooms = positiveInteger(options.maxBufferedRooms, DEFAULT_MAX_BUFFERED_ROOMS);
    this.maxQueuedEventsPerSubscriber = positiveInteger(
      options.maxQueuedEventsPerSubscriber,
      DEFAULT_MAX_QUEUED_EVENTS_PER_SUBSCRIBER,
    );
    this.bufferTtlMs = positiveInteger(options.bufferTtlMs, DEFAULT_BUFFER_TTL_MS);
    this.maxBufferedBytesPerRoom = positiveInteger(
      options.maxBufferedBytesPerRoom,
      DEFAULT_MAX_BUFFERED_BYTES_PER_ROOM,
    );
    this.maxBufferedBytesTotal = positiveInteger(
      options.maxBufferedBytesTotal,
      DEFAULT_MAX_BUFFERED_BYTES_TOTAL,
    );
    this.maxQueuedBytesPerSubscriber = positiveInteger(
      options.maxQueuedBytesPerSubscriber,
      DEFAULT_MAX_QUEUED_BYTES_PER_SUBSCRIBER,
    );
    this.instanceId = options.instanceId ?? randomUUID();
    this.now = options.now ?? Date.now;
  }

  attach(deps: EventSourceDeps): void {
    if (this.closed) {
      throw new Error("cannot attach sources to a closed room event broker");
    }
    if (this.sources.length > 0) {
      throw new Error("room event broker sources are already attached");
    }
    this.addSource(deps.messageEvents, "message:created", (payload) => {
      const event = payload as {
        projectId: string;
        message: Message;
        recipientAgentTargets?: readonly MessageRecipientAgentTarget[];
      };
      return {
        kind: "message_created",
        roomId: event.projectId,
        message: event.message,
        recipientAgentTargetSet: createRecipientAgentTargetSet(event.recipientAgentTargets ?? []),
      };
    });
    this.addSource(deps.taskEvents, "task:updated", (payload) => {
      const event = payload as { projectId: string; task: Task };
      return { kind: "task_updated", roomId: event.projectId, task: event.task };
    });
    if (deps.githubRoomEvents) {
      this.addSource(deps.githubRoomEvents, "github_event:updated", (payload) => {
        const event = payload as { projectId: string; event: GitHubRoomEvent };
        return { kind: "github_event_updated", roomId: event.projectId, event: event.event };
      });
    }
    this.addSource(deps.reasoningEvents, "reasoning:updated", (payload) => {
      const event = payload as {
        projectId: string;
        session: ReasoningSession;
        update?: ReasoningSessionUpdate | null;
      };
      return {
        kind: "reasoning_updated",
        roomId: event.projectId,
        session: event.session,
        update: event.update ?? null,
      };
    });
    this.addSource(deps.reasoningEvents, "reasoning:removed", (payload) => {
      const event = payload as { projectId: string; session_id: string };
      return { kind: "reasoning_removed", roomId: event.projectId, sessionId: event.session_id };
    });
    if (deps.artifactEvents) {
      this.addSource(deps.artifactEvents, "artifact:updated", (payload) => {
        const event = payload as { projectId: string; artifact: RoomSharedArtifact | null };
        return { kind: "artifact_updated", roomId: event.projectId, artifact: event.artifact };
      });
    }
    this.addSource(deps.rentalActivityEvents, "activity:created", (payload) => {
      const event = payload as { activity: ActivityEvent };
      return {
        kind: "rental_activity_created",
        roomId: event.activity.room_id,
        activity: event.activity,
      };
    });
    this.addSource(deps.messageInfoEvents, "message_info:updated", (payload) => {
      const event = payload as MessageInfoUpdatedEvent;
      return {
        kind: "message_info_updated",
        roomId: event.projectId,
        messageIds: event.messageIds,
      };
    });
    if (deps.agentWorkEvents) {
      this.addSource(deps.agentWorkEvents, "agent_work:invalidated", (payload) => {
        const event = payload as { projectId: string };
        return { kind: "agent_work_invalidated", roomId: event.projectId };
      });
    }
    if (deps.agentApprovalEvents) {
      this.addSource(deps.agentApprovalEvents, "agent_approval:invalidated", (payload) => {
        const event = payload as { projectId: string };
        return { kind: "agent_approval_invalidated", roomId: event.projectId };
      });
    }
    if (deps.executionDelegationEvents) {
      this.addSource(deps.executionDelegationEvents, "execution_delegation:invalidated", (payload) => {
        const event = payload as { projectId: string };
        return { kind: "execution_delegation_invalidated", roomId: event.projectId };
      });
    }
    if (deps.bridgeLossEvents) {
      this.addLossSource(deps.bridgeLossEvents);
    }
  }

  publish(event: RoomEvent): RoomEventEnvelope | null {
    if (this.closed) return null;
    this.pruneExpiredBuffers();
    const roomSubscribers = this.subscribers.get(event.roomId);
    const existingBuffer = this.buffers.get(event.roomId);
    if ((!roomSubscribers || roomSubscribers.size === 0) && !existingBuffer) {
      return null;
    }

    const buffer = existingBuffer ?? this.createBuffer();
    const envelope = {
      cursor: `${this.instanceId}:${++this.sequence}`,
      event,
      lossEpoch: buffer.lossEpoch,
    } satisfies RoomEventEnvelope;
    const bytes = serializedEventBytes(
      event,
      Math.max(this.maxBufferedBytesPerRoom, this.maxQueuedBytesPerSubscriber),
    );
    this.appendToBuffer(event.roomId, envelope, bytes, buffer);
    for (const subscriber of roomSubscribers ?? []) {
      subscriber.push(envelope, bytes);
    }
    return envelope;
  }

  /** True when this process must hydrate remote references for live/replay delivery. */
  hasInterest(roomId: string): boolean {
    if (this.closed) return false;
    this.pruneExpiredBuffers();
    this.pruneUninterestedGaps();
    return Boolean(this.subscribers.get(roomId)?.size || this.buffers.has(roomId));
  }

  /** Snapshot the distinct human-account overlays needed by this room. */
  getMessageOverlayTargets(roomId: string): readonly RoomMessageOverlayTarget[] {
    const cached = this.overlayTargetSnapshots.get(roomId);
    if (cached) return cached;
    const byAccount = new Map<string, boolean>();
    for (const subscriber of this.subscribers.get(roomId) ?? []) {
      const target = subscriber.messageOverlayTarget;
      if (!target) continue;
      byAccount.set(
        target.accountId,
        Boolean(byAccount.get(target.accountId) || target.accountAgentRouting),
      );
    }
    const snapshot = Object.freeze([...byAccount]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([accountId, accountAgentRouting]) => Object.freeze({
        accountId,
        accountAgentRouting,
      })));
    this.overlayTargetSnapshots.set(roomId, snapshot);
    return snapshot;
  }

  /**
   * Marks one room (or every active room) as lossy. The marker is retained in
   * the replay buffer, so reconnecting clients cannot accidentally replay
   * across a PostgreSQL LISTEN/NOTIFY outage as if the history were complete.
   */
  markGap(roomId?: string | null): void {
    if (this.closed) return;
    const epoch = ++this.lossSequence;
    const roomIds = roomId
      ? [roomId]
      : Array.from(new Set([...this.buffers.keys(), ...this.subscribers.keys()]));
    for (const targetRoomId of roomIds) {
      const buffer = this.buffers.get(targetRoomId) ?? this.createBuffer();
      buffer.lossEpoch = epoch;
      buffer.touchedAt = this.now();
      this.buffers.delete(targetRoomId);
      this.buffers.set(targetRoomId, buffer);
      const cursor = this.activeEvents(buffer).at(-1)?.envelope.cursor ?? null;
      for (const subscriber of this.subscribers.get(targetRoomId) ?? []) {
        subscriber.pushGap(cursor);
      }
    }
    this.pruneBufferLimits();
    this.scheduleExpiry();
  }

  subscribe(roomId: string, options: SubscribeOptions = {}): RoomEventSubscription {
    if (this.closed) {
      throw new Error("room event broker is closed");
    }
    this.pruneExpiredBuffers();
    this.pruneUninterestedGaps();
    const skippedWhileUninterested = this.uninterestedGaps.has(roomId);
    this.uninterestedGaps.delete(roomId);
    const buffer = this.touchBuffer(roomId);
    const buffered = this.activeEvents(buffer);
    const latestCursor = buffered.at(-1)?.envelope.cursor ?? null;
    let checkpointCursor = skippedWhileUninterested
      ? latestCursor
      : options.afterCursor ?? latestCursor;
    let checkpointGap = skippedWhileUninterested;
    let replayStart = -1;
    if (options.afterCursor) {
      replayStart = buffered.findIndex(({ envelope }) => envelope.cursor === options.afterCursor);
      if (replayStart >= 0) {
        if (buffered[replayStart]!.envelope.lossEpoch < buffer.lossEpoch) {
          checkpointGap = true;
          checkpointCursor = latestCursor;
        }
      } else if (latestCursor !== options.afterCursor) {
        checkpointGap = true;
        checkpointCursor = latestCursor;
      }
    }
    const subscription = new BrokerSubscription({
      kinds: options.kinds,
      accept: options.accept,
      messageOverlayTarget: options.messageOverlayTarget,
      checkpointCursor,
      checkpointGap,
      maxQueuedEvents: this.maxQueuedEventsPerSubscriber,
      maxQueuedBytes: this.maxQueuedBytesPerSubscriber,
      onClose: () => this.removeSubscription(roomId, subscription),
    });
    const roomSubscribers = this.subscribers.get(roomId) ?? new Set<BrokerSubscription>();
    roomSubscribers.add(subscription);
    this.subscribers.set(roomId, roomSubscribers);
    if (options.messageOverlayTarget) this.overlayTargetSnapshots.delete(roomId);

    if (skippedWhileUninterested) {
      subscription.pushGap(latestCursor);
    }
    if (options.afterCursor) {
      if (replayStart >= 0) {
        if (buffered[replayStart]!.envelope.lossEpoch < buffer.lossEpoch) {
          subscription.pushGap(latestCursor);
        }
        for (const { envelope, bytes } of buffered.slice(replayStart + 1)) {
          subscription.push(envelope, bytes);
        }
      } else if (latestCursor !== options.afterCursor) {
        subscription.pushGap(latestCursor);
      }
    }
    return subscription;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const source of this.sources) source.emitter.off(source.name, source.listener);
    this.sources.length = 0;
    for (const roomSubscribers of this.subscribers.values()) {
      for (const subscriber of roomSubscribers) subscriber.close();
    }
    this.subscribers.clear();
    this.overlayTargetSnapshots.clear();
    this.buffers.clear();
    this.uninterestedGaps.clear();
    this.totalBufferedBytes = 0;
  }

  private addSource(
    emitter: EventEmitter,
    name: string,
    mapEvent: (payload: unknown) => RoomEvent,
  ): void {
    const listener = (payload: unknown) => {
      try {
        this.publish(mapEvent(payload));
      } catch (error) {
        // One malformed producer payload must not break EventEmitter.emit for
        // unrelated listeners. Conservatively force active clients to repair.
        console.error(`[room event broker] failed to map ${name}`, error);
        this.markGap();
      }
    };
    emitter.on(name, listener);
    this.sources.push({ emitter, name, listener });
  }

  private addLossSource(emitter: EventEmitter): void {
    const name = "loss";
    const listener = (payload: unknown) => {
      const loss = payload && typeof payload === "object"
        ? payload as RoomEventBridgeLoss
        : {};
      const roomId = typeof loss.roomId === "string" ? loss.roomId : null;
      if (loss.reason === "uninterested_reference" && roomId && !this.hasInterest(roomId)) {
        // Retain only a compact race boundary. This deliberately does not
        // count as replay interest, so a pod with no local subscriber keeps
        // skipping subsequent reference hydration and avoids DB amplification.
        this.uninterestedGaps.delete(roomId);
        this.uninterestedGaps.set(roomId, this.now());
        while (this.uninterestedGaps.size > this.maxBufferedRooms) {
          const oldest = this.uninterestedGaps.keys().next().value as string | undefined;
          if (!oldest) break;
          this.uninterestedGaps.delete(oldest);
        }
        return;
      }
      this.markGap(roomId);
    };
    emitter.on(name, listener);
    this.sources.push({ emitter, name, listener });
  }

  private appendToBuffer(
    roomId: string,
    envelope: RoomEventEnvelope,
    bytes: number,
    existing?: RoomBuffer,
  ): void {
    const buffer = existing ?? this.createBuffer();
    if (bytes <= this.maxBufferedBytesPerRoom && bytes <= this.maxBufferedBytesTotal) {
      buffer.events.push({ envelope, bytes });
      buffer.bytes += bytes;
      this.totalBufferedBytes += bytes;
    } else {
      // Never retain an object that cannot fit even in an otherwise empty
      // buffer. The live subscriber receives a gap instead of the body.
      buffer.lossEpoch = ++this.lossSequence;
    }
    while (
      buffer.events.length - buffer.head > this.maxBufferedEventsPerRoom
      || buffer.bytes > this.maxBufferedBytesPerRoom
    ) {
      const removed = buffer.events[buffer.head++];
      if (!removed) break;
      buffer.events[buffer.head - 1] = undefined;
      buffer.bytes -= removed.bytes;
      this.totalBufferedBytes -= removed.bytes;
      buffer.lossEpoch = ++this.lossSequence;
    }
    if (buffer.head > 128 && buffer.head * 2 >= buffer.events.length) {
      buffer.events = buffer.events.slice(buffer.head);
      buffer.head = 0;
    }
    // Eviction is a loss boundary for older cursors, but this newly published
    // event itself is a valid post-boundary resume point.
    envelope.lossEpoch = buffer.lossEpoch;
    buffer.touchedAt = this.now();
    this.buffers.delete(roomId);
    this.buffers.set(roomId, buffer);
    this.pruneBufferLimits();
    this.scheduleExpiry();
  }

  private touchBuffer(roomId: string): RoomBuffer {
    const buffer = this.buffers.get(roomId) ?? this.createBuffer();
    buffer.touchedAt = this.now();
    this.buffers.delete(roomId);
    this.buffers.set(roomId, buffer);
    this.pruneBufferLimits();
    this.scheduleExpiry();
    return buffer;
  }

  private pruneExpiredBuffers(): void {
    const cutoff = this.now() - this.bufferTtlMs;
    while (this.buffers.size > 0) {
      const oldest = this.buffers.entries().next().value as [string, RoomBuffer] | undefined;
      if (!oldest || oldest[1].touchedAt > cutoff) break;
      this.deleteBuffer(oldest[0]);
    }
  }

  private pruneUninterestedGaps(): void {
    const cutoff = this.now() - this.bufferTtlMs;
    while (this.uninterestedGaps.size > 0) {
      const oldest = this.uninterestedGaps.entries().next().value as [string, number] | undefined;
      if (!oldest || oldest[1] > cutoff) break;
      this.uninterestedGaps.delete(oldest[0]);
    }
  }

  private pruneBufferLimits(): void {
    while (
      this.buffers.size > this.maxBufferedRooms
      || this.totalBufferedBytes > this.maxBufferedBytesTotal
    ) {
      const oldestRoomId = this.buffers.keys().next().value as string | undefined;
      if (!oldestRoomId) break;
      this.deleteBuffer(oldestRoomId);
    }
  }

  private deleteBuffer(roomId: string): void {
    const buffer = this.buffers.get(roomId);
    if (!buffer) return;
    this.totalBufferedBytes -= buffer.bytes;
    this.buffers.delete(roomId);
  }

  private createBuffer(): RoomBuffer {
    return {
      events: [],
      head: 0,
      bytes: 0,
      touchedAt: this.now(),
      lossEpoch: this.lossSequence,
    };
  }

  private activeEvents(buffer: RoomBuffer): Array<{ envelope: RoomEventEnvelope; bytes: number }> {
    return buffer.events
      .slice(buffer.head)
      .filter((event): event is { envelope: RoomEventEnvelope; bytes: number } => Boolean(event));
  }

  private scheduleExpiry(): void {
    if (this.closed || this.expiryTimer || this.buffers.size === 0) return;
    const oldest = this.buffers.values().next().value as RoomBuffer | undefined;
    if (!oldest) return;
    const delay = Math.max(1, oldest.touchedAt + this.bufferTtlMs - this.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.pruneExpiredBuffers();
      this.scheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private removeSubscription(roomId: string, subscription: BrokerSubscription): void {
    const roomSubscribers = this.subscribers.get(roomId);
    if (!roomSubscribers) return;
    roomSubscribers.delete(subscription);
    if (subscription.messageOverlayTarget) this.overlayTargetSnapshots.delete(roomId);
    if (roomSubscribers.size === 0) this.subscribers.delete(roomId);
  }
}

export function recipientAgentDurableTargetKey(input: {
  owner_account_id?: string | null;
  agent_key?: string | null;
}): string | null {
  const owner = input.owner_account_id?.trim();
  const key = input.agent_key?.trim();
  return owner && key ? `${owner}\u0000${key}` : null;
}

function createRecipientAgentTargetSet(
  targets: readonly MessageRecipientAgentTarget[],
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const target of targets) {
    // Buffered local events cannot know which generation will be the unique
    // successor later. Admit only same-account/key candidates to server-side
    // hydration; the fresh account envelope remains the exact serialization
    // fence and rejects live overlaps or cross-owner keys.
    const durable = recipientAgentDurableTargetKey(target);
    if (durable) result.add(durable);
  }
  return result;
}

export function createRoomEventBroker(
  deps: EventSourceDeps,
  options?: RoomEventBrokerOptions,
): RoomEventBroker {
  const broker = new RoomEventBroker(options);
  broker.attach(deps);
  return broker;
}

class BrokerSubscription implements RoomEventSubscription {
  private readonly queue: Array<{ delivery: RoomEventDelivery; bytes: number }> = [];
  private queuedBytes = 0;
  private waiter: ((delivery: RoomEventDelivery | null) => void) | null = null;
  private closed = false;

  constructor(private readonly options: {
    kinds?: ReadonlySet<RoomEventKind>;
    accept?: (event: RoomEvent) => boolean;
    messageOverlayTarget?: RoomMessageOverlayTarget;
    maxQueuedEvents: number;
    maxQueuedBytes: number;
    onClose: () => void;
    checkpointCursor: string | null;
    checkpointGap: boolean;
  }) {}

  get checkpointCursor(): string | null { return this.options.checkpointCursor; }
  get checkpointGap(): boolean { return this.options.checkpointGap; }
  get messageOverlayTarget(): RoomMessageOverlayTarget | undefined {
    return this.options.messageOverlayTarget;
  }

  next(): Promise<RoomEventDelivery | null> {
    const queued = this.queue.shift();
    if (queued) {
      this.queuedBytes -= queued.bytes;
      return Promise.resolve(queued.delivery);
    }
    if (this.closed) return Promise.resolve(null);
    if (this.waiter) throw new Error("room event subscription already has a pending read");
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  push(envelope: RoomEventEnvelope, bytes: number): void {
    if (this.closed || (this.options.kinds && !this.options.kinds.has(envelope.event.kind))) return;
    if (this.options.accept) {
      try {
        if (!this.options.accept(envelope.event)) return;
      } catch (error) {
        console.error("[room event broker] subscriber filter failed", error);
        this.pushGap(envelope.cursor);
        return;
      }
    }
    if (bytes > this.options.maxQueuedBytes) {
      this.pushGap(envelope.cursor);
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ type: "event", envelope });
      return;
    }
    if (
      this.queue.length >= this.options.maxQueuedEvents
      || this.queuedBytes + bytes > this.options.maxQueuedBytes
    ) {
      this.pushGap(envelope.cursor);
      return;
    }
    this.queue.push({ delivery: { type: "event", envelope }, bytes });
    this.queuedBytes += bytes;
  }

  pushGap(cursor: string | null): void {
    if (this.closed) return;
    const gap = { type: "gap", cursor } satisfies RoomEventDelivery;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(gap);
      return;
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.queue.push({ delivery: gap, bytes: 0 });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(null);
    this.options.onClose();
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function serializedEventBytes(event: RoomEvent, overflowValue: number): number {
  try {
    let bytes = Buffer.byteLength(JSON.stringify(event));
    if (event.kind === "message_created" && event.recipientAgentTargetSet.size > 0) {
      // JSON.stringify(Set) emits `{}` and would make the broker's byte limits
      // blind to the largest retained object in a prompt event. Count the
      // UTF-16 backing store plus a conservative Set-entry allocation for each
      // owner+durable-key string. Stop as soon as the caller's largest usable
      // budget is exceeded; there is no value walking a hostile 100k audience
      // once delivery is already known to become a gap.
      bytes += RETAINED_SET_BASE_BYTES;
      for (const target of event.recipientAgentTargetSet) {
        bytes += target.length * 2 + RETAINED_SET_ENTRY_BYTES;
        if (bytes > overflowValue) return overflowValue + 1;
      }
    }
    return bytes;
  } catch {
    return overflowValue + 1;
  }
}
