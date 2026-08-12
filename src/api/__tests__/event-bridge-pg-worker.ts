import { EventEmitter, once } from "node:events";

import {
  createBridgedEmitter,
  roomEventBridgeLifecycleEvents,
  roomEventBridgeLossEvents,
  setRoomEventBridgeInterestPredicate,
  startRoomEventBridge,
  stopRoomEventBridge,
} from "../server/event-bridge.js";
import { db, pool } from "../db/client.js";
import { RoomEventBroker } from "../server/room-event-broker.js";
import { clearGitHubRepoAccessCacheForRoom } from "../github/repo-access.js";
import { acquireLiveRoomAuthorization } from "../rooms/live-authorization.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import {
  bearerDeliveryCredentialFingerprint,
  emitRoomAgentCredentialInvalidation,
  queueRoomAgentCredentialInvalidationsTx,
} from "../rooms/agent-credential-events.js";

const role = process.env.LETAGENTS_BRIDGE_TEST_ROLE;
const roomId = process.env.LETAGENTS_BRIDGE_TEST_ROOM;
const scenario = process.env.LETAGENTS_BRIDGE_TEST_SCENARIO ?? "loss";
if ((role !== "publisher" && role !== "subscriber") || !roomId) {
  throw new Error("event bridge test worker requires a role and room");
}

const send = (payload: Record<string, unknown>) => process.send?.(payload);

async function startBridge(): Promise<void> {
  const connected = once(roomEventBridgeLifecycleEvents, "connected");
  startRoomEventBridge();
  await connected;
}

async function runPublisher(): Promise<void> {
  await startBridge();
  if (scenario === "auth_invalidation") {
    clearGitHubRepoAccessCacheForRoom(roomId!);
    await stopRoomEventBridge();
    send({ type: "publisher_done" });
    return;
  }
  if (scenario === "uninterested_ref") {
    createBridgedEmitter("tasks").emit("task:updated", {
      projectId: roomId,
      task: { id: "task_uninterested", description: "x".repeat(8_000) },
    });
    await stopRoomEventBridge();
    send({ type: "publisher_done" });
    return;
  }
  if (scenario === "credential_invalidation") {
    await db.transaction(async (tx) => {
      await queueRoomAgentCredentialInvalidationsTx(tx, [{
        room_id: roomId!,
        agent_session_id: "session_cross_instance",
        credential_fingerprints: [bearerDeliveryCredentialFingerprint("bearer_cross_instance", 1)],
        reason: "rotated",
      }]);
    });
    await stopRoomEventBridge();
    send({ type: "publisher_done" });
    return;
  }
  if (scenario === "listener_restart") {
    createBridgedEmitter("messages").emit("message:created", {
      projectId: roomId,
      message: {
        id: "msg_1",
        sender: "bridge-test",
        text: "after-restart",
        timestamp: new Date().toISOString(),
        agent_prompt_kind: null,
      },
      recipientAgentTargets: [],
    });
    await stopRoomEventBridge();
    send({ type: "publisher_done" });
    return;
  }
  // This lane has no reference representation, so the event is deliberately
  // dropped locally and must become a retained cross-instance loss marker.
  createBridgedEmitter("github").emit("github_event:updated", {
    projectId: roomId,
    event: { body: "x".repeat(8_000) },
  });
  createBridgedEmitter("messages").emit("message:created", {
    projectId: roomId,
    message: {
      id: "msg_1",
      sender: "bridge-test",
      text: "converged",
      timestamp: new Date().toISOString(),
      agent_prompt_kind: null,
    },
    recipientAgentTargets: [],
  });
  // stop waits for already accepted publisher work, making the worker exit a
  // deterministic acknowledgement rather than a timing sleep.
  await stopRoomEventBridge();
  send({ type: "publisher_done" });
}

async function runSubscriber(): Promise<void> {
  if (scenario === "uninterested_ref") {
    // Register the same lane the API server owns. Interest filtering happens
    // before hydration, after the bridge has resolved the destination lane.
    createBridgedEmitter("tasks");
    setRoomEventBridgeInterestPredicate(() => false);
    await startBridge();
    // Ignore the listener-ready safety boundary; this scenario asserts the
    // later reference-specific cold-pod decision.
    const loss = once(roomEventBridgeLossEvents, "loss");
    send({ type: "subscriber_ready" });
    const [payload] = await loss as [{ reason?: string; roomId?: string }];
    send({
      type: "subscriber_interest_result",
      reason: payload.reason,
      room_id: payload.roomId,
    });
    setRoomEventBridgeInterestPredicate(null);
    await stopRoomEventBridge();
    return;
  }
  if (scenario === "credential_invalidation") {
    const lease = acquireLiveRoomAuthorization({
      req: {
        headers: { authorization: "Bearer retired-v1" },
        authKind: "agent_session",
        agentSession: {
          bearer_id: "bearer_cross_instance",
          bearer_generation: 1,
        },
      } as unknown as AuthenticatedRequest,
      roomId: roomId!,
      accessRoomName: roomId!,
      authorize: async () => true,
    });
    assertAllowed(await lease.check());
    const result = new Promise<boolean>((resolve) => {
      lease.onInvalidated(() => void lease.check().then(resolve));
    });
    await startBridge();
    send({ type: "subscriber_ready" });
    send({ type: "subscriber_credential_result", allowed: await result });
    lease.release();
    await stopRoomEventBridge();
    return;
  }
  if (scenario === "auth_invalidation") {
    let allowed = true;
    const lease = acquireLiveRoomAuthorization({
      req: {
        headers: { authorization: "Bearer cross-instance-test" },
        authKind: "owner_token",
        sessionAccount: { account_id: "account_bridge", login: "bridge-user" },
      } as unknown as AuthenticatedRequest,
      roomId: roomId!,
      accessRoomName: roomId!,
      authorize: async () => allowed,
    });
    await lease.check();
    const result = new Promise<boolean>((resolve) => {
      lease.onInvalidated(() => {
        allowed = false;
        void lease.check({ force: true }).then(resolve);
      });
    });
    await startBridge();
    send({ type: "subscriber_ready" });
    send({ type: "subscriber_invalidation_result", allowed: await result });
    lease.release();
    await stopRoomEventBridge();
    return;
  }
  const messageEvents = createBridgedEmitter("messages");
  const unused = new EventEmitter();
  const broker = new RoomEventBroker();
  broker.attach({
    messageEvents,
    taskEvents: unused,
    reasoningEvents: unused,
    rentalActivityEvents: unused,
    messageInfoEvents: unused,
    bridgeLossEvents: roomEventBridgeLossEvents,
  });
  if (scenario === "listener_restart") {
    await startBridge();
    await stopRoomEventBridge();
    await startBridge();
    const subscription = broker.subscribe(roomId);
    send({ type: "subscriber_ready" });
    const delivery = await subscription.next();
    send({
      type: "subscriber_restart_result",
      delivery: delivery?.type ?? null,
      message: delivery?.type === "event" && delivery.envelope.event.kind === "message_created"
        ? delivery.envelope.event.message.text
        : null,
    });
    subscription.close();
    broker.close();
    await stopRoomEventBridge();
    return;
  }
  // The listener-ready boundary repairs subscriptions created while LISTEN is
  // unavailable. This scenario starts after readiness so it isolates the
  // publisher-side retained loss marker under test.
  await startBridge();
  const subscription = broker.subscribe(roomId);
  send({ type: "subscriber_ready" });

  const first = await subscription.next();
  const second = await subscription.next();
  send({
    type: "subscriber_result",
    deliveries: [
      first?.type ?? null,
      second?.type ?? null,
    ],
    message: second?.type === "event" && second.envelope.event.kind === "message_created"
      ? second.envelope.event.message.text
      : null,
  });
  subscription.close();
  broker.close();
  await stopRoomEventBridge();
}

function assertAllowed(allowed: boolean): void {
  if (!allowed) throw new Error("credential lease was not initially allowed");
}

try {
  if (role === "publisher") await runPublisher();
  else await runSubscriber();
} finally {
  await pool.end();
}
