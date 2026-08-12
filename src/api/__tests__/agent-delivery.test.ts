import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedRequest } from "../http/helpers.js";
import type { RoomAgentDeliveryDeps } from "../rooms/agent-delivery.js";

process.env.DB_URL ||= "postgresql://postgres:postgres@127.0.0.1:1/letagents";
const {
  beginRoomAgentDelivery,
  drainRoomAgentDeliveryLeases,
  disconnectRoomAgentDeliverySession,
  InvalidRoomAgentDeliverySessionError,
} = await import("../rooms/agent-delivery.js");
const {
  bearerDeliveryCredentialFingerprint,
  roomAgentCredentialInvalidationEvents,
} = await import("../rooms/agent-credential-events.js");

test("parallel sockets share one delivery lease, heartbeat, and disconnect", async () => {
  let connected = 0;
  let disconnected = 0;
  let heartbeats = 0;
  let participants = 0;
  let releaseHeartbeat!: () => void;
  const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  const identity = {
    actor_label: "Codex (EmmyMay/VS Code)",
    agent_key: "emmymay/codex",
    agent_instance_id: "instance_1",
    agent_session_id: "session_shared",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Codex",
    owner_label: "EmmyMay",
    ide_label: "VS Code",
    repo_branch: "codex/event-broker",
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => {
      connected += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return undefined;
    },
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      disconnected += 1;
      return undefined;
    },
    markRoomAgentDeliveryHeartbeat: async () => {
      heartbeats += 1;
      await heartbeatGate;
      return undefined;
    },
    upsertRoomParticipant: async () => {
      participants += 1;
      return undefined;
    },
    heartbeatIntervalMs: 5,
  } as unknown as RoomAgentDeliveryDeps;
  const req = {
    query: {},
    get: () => undefined,
  } as unknown as AuthenticatedRequest;

  const [first, second] = await Promise.all([
    beginRoomAgentDelivery({ req, roomId: "room_delivery_shared", transport: "sse" }, deps),
    beginRoomAgentDelivery({ req, roomId: "room_delivery_shared", transport: "long_poll" }, deps),
  ]);
  assert.ok(first);
  assert.ok(second);
  assert.equal(connected, 1);
  assert.equal(participants, 1);

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(heartbeats, 1, "one non-overlapping heartbeat serves both sockets");
  await first.end();
  assert.equal(disconnected, 0, "the durable lease stays live while one socket remains");
  await second.end();
  assert.equal(disconnected, 1);
  releaseHeartbeat();
});

test("successive long polls renew one idle delivery lease without reconnect writes", async () => {
  let connected = 0;
  let disconnected = 0;
  let participants = 0;
  const identity = {
    actor_label: "Poller | Owner | MCP",
    agent_key: "owner/poller",
    agent_instance_id: "instance_poll_lease",
    agent_session_id: "session_poll_lease",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => { connected += 1; },
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => { disconnected += 1; },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => { participants += 1; },
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 25,
  } as unknown as RoomAgentDeliveryDeps;
  const req = { query: {}, get: () => undefined } as unknown as AuthenticatedRequest;

  const first = await beginRoomAgentDelivery({
    req,
    roomId: "room_poll_lease",
    transport: "long_poll",
  }, deps);
  assert.ok(first);
  await first.end();
  assert.equal(disconnected, 0, "poll timeout keeps the durable lease available for renewal");

  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const second = await beginRoomAgentDelivery({
    req,
    roomId: "room_poll_lease",
    transport: "long_poll",
  }, deps);
  assert.ok(second);
  assert.equal(connected, 1, "the successor poll reuses the existing connected lease");
  assert.equal(participants, 1, "renewal does not rewrite participant presence");
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(disconnected, 0, "the cancelled idle timer cannot disconnect the renewed poll");

  await second.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(disconnected, 1, "the lease disconnects once after its real idle expiry");
});

test("an SSE close disconnects immediately instead of pretending a socket remains active", async () => {
  let disconnected = 0;
  const identity = {
    actor_label: "Streamer | Owner | MCP",
    agent_key: "owner/streamer",
    agent_instance_id: "instance_sse_close",
    agent_session_id: "session_sse_close",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Streamer",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const delivery = await beginRoomAgentDelivery({
    req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
    roomId: "room_sse_close",
    transport: "sse",
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => { disconnected += 1; },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 60_000,
  } as unknown as RoomAgentDeliveryDeps);
  assert.ok(delivery);
  await delivery.end();
  assert.equal(disconnected, 1);
});

test("a poll beginning during idle expiry waits for the disconnect fence before reconnecting", async () => {
  let releaseDisconnect!: () => void;
  let disconnectStarted!: () => void;
  const disconnectGate = new Promise<void>((resolve) => { releaseDisconnect = resolve; });
  const disconnectStart = new Promise<void>((resolve) => { disconnectStarted = resolve; });
  const transitions: string[] = [];
  const identity = {
    actor_label: "Racing Poller | Owner | MCP",
    agent_key: "owner/racing-poller",
    agent_instance_id: "instance_racing_poll",
    agent_session_id: "session_racing_poll",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Racing Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => { transitions.push("connected"); },
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      transitions.push("disconnect:start");
      disconnectStarted();
      await disconnectGate;
      transitions.push("disconnect:end");
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 5,
  } as unknown as RoomAgentDeliveryDeps;
  const req = { query: {}, get: () => undefined } as unknown as AuthenticatedRequest;
  const first = await beginRoomAgentDelivery({
    req,
    roomId: "room_racing_poll",
    transport: "long_poll",
  }, deps);
  assert.ok(first);
  await first.end();
  await Promise.race([
    disconnectStart,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("idle delivery disconnect did not start")),
      500,
    )),
  ]);

  const secondPromise = beginRoomAgentDelivery({
    req,
    roomId: "room_racing_poll",
    transport: "long_poll",
  }, deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(transitions, ["connected", "disconnect:start"]);
  releaseDisconnect();
  const second = await secondPromise;
  assert.ok(second);
  assert.deepEqual(transitions, ["connected", "disconnect:start", "disconnect:end", "connected"]);
  await second.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
});

test("a failed idle disconnect retires locally without creating a retry-timer herd", async () => {
  let connected = 0;
  let disconnectAttempts = 0;
  const connectedInstanceIds: string[] = [];
  const disconnectedInstanceIds: string[] = [];
  const identity = {
    actor_label: "Retry Poller | Owner | MCP",
    agent_key: "owner/retry-poller",
    agent_instance_id: "instance_retry_poll",
    agent_session_id: "session_retry_poll",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Retry Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async (input) => {
      connected += 1;
      connectedInstanceIds.push(input.delivery_instance_id ?? "");
    },
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async (input) => {
      disconnectAttempts += 1;
      disconnectedInstanceIds.push(input.delivery_instance_id ?? "");
      if (disconnectAttempts === 1) throw new Error("transient disconnect failure");
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 10,
  } as unknown as RoomAgentDeliveryDeps;
  const req = { query: {}, get: () => undefined } as unknown as AuthenticatedRequest;
  const first = await beginRoomAgentDelivery({
    req,
    roomId: "room_retry_poll",
    transport: "long_poll",
  }, deps);
  assert.ok(first);
  await first.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(disconnectAttempts, 1);

  const second = await beginRoomAgentDelivery({
    req,
    roomId: "room_retry_poll",
    transport: "long_poll",
  }, deps);
  assert.ok(second);
  assert.equal(connected, 2, "a later poll establishes a new process-owned instance");
  assert.notEqual(connectedInstanceIds[0], connectedInstanceIds[1]);
  await second.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(disconnectAttempts, 2, "there is no autonomous fixed-delay retry of the failed release");
  assert.deepEqual(disconnectedInstanceIds, connectedInstanceIds);
  await drainRoomAgentDeliveryLeases();
  assert.equal(disconnectAttempts, 3, "shutdown drains the queued idempotent release once");
  assert.equal(disconnectedInstanceIds[2], connectedInstanceIds[0]);
});

test("failed releases retry through one bounded process-wide scheduler", async () => {
  const retryGate = Promise.withResolvers<void>();
  const attempts = new Map<string, number>();
  let activeRetries = 0;
  let maxActiveRetries = 0;
  let observedEightRetries!: () => void;
  const eightRetries = new Promise<void>((resolve) => { observedEightRetries = resolve; });
  const deliveries = [];
  const deps = {
    resolveRequestAgentIdentity: async ({ actor_label }: { actor_label?: string | null }) => ({
      actor_label: actor_label ?? "unknown",
      agent_key: `owner/${actor_label}`,
      agent_instance_id: `instance_${actor_label}`,
      agent_session_id: actor_label,
      session_kind: "worker" as const,
      runtime: "mcp",
      display_name: actor_label ?? "unknown",
      owner_label: "Owner",
      ide_label: "MCP",
      repo_branch: null,
    }),
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async (input: { delivery_instance_id?: string | null }) => {
      const instanceId = input.delivery_instance_id ?? "";
      const attempt = (attempts.get(instanceId) ?? 0) + 1;
      attempts.set(instanceId, attempt);
      if (attempt === 1) throw new Error("database unavailable");
      activeRetries += 1;
      maxActiveRetries = Math.max(maxActiveRetries, activeRetries);
      if (activeRetries === 8) observedEightRetries();
      await retryGate.promise;
      activeRetries -= 1;
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 1,
  } as unknown as RoomAgentDeliveryDeps;
  for (let index = 0; index < 20; index += 1) {
    const sessionId = `scheduler_session_${index}`;
    const delivery = await beginRoomAgentDelivery({
      req: { query: { actor_label: sessionId }, get: () => undefined } as unknown as AuthenticatedRequest,
      roomId: "room_release_scheduler",
      transport: "long_poll",
    }, deps);
    assert.ok(delivery);
    deliveries.push(delivery);
  }
  await Promise.all(deliveries.map((delivery) => delivery.end()));
  await Promise.race([
    eightRetries,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("bounded release retries did not start")),
      2_000,
    )),
  ]);
  assert.equal(maxActiveRetries, 8);
  retryGate.resolve();
  await drainRoomAgentDeliveryLeases();
  assert.ok([...attempts.values()].every((attempt) => attempt === 2));
});

test("a saturated release scheduler waits for capacity without zero-delay timer churn", async () => {
  const retryGate = Promise.withResolvers<void>();
  const attempts = new Map<string, number>();
  let activeRetries = 0;
  let observedEightRetries!: () => void;
  const eightRetries = new Promise<void>((resolve) => { observedEightRetries = resolve; });
  let zeroDelayTimers = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const deps = {
    resolveRequestAgentIdentity: async ({ actor_label }: { actor_label?: string | null }) => ({
      actor_label: actor_label ?? "unknown",
      agent_key: `owner/${actor_label}`,
      agent_instance_id: `instance_${actor_label}`,
      agent_session_id: actor_label,
      session_kind: "worker" as const,
      runtime: "mcp",
      display_name: actor_label ?? "unknown",
      owner_label: "Owner",
      ide_label: "MCP",
      repo_branch: null,
    }),
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async (input: { delivery_instance_id?: string | null }) => {
      const attempt = (attempts.get(input.delivery_instance_id ?? "") ?? 0) + 1;
      attempts.set(input.delivery_instance_id ?? "", attempt);
      if (attempt === 1) throw new Error("database unavailable");
      activeRetries += 1;
      if (activeRetries === 8) observedEightRetries();
      await retryGate.promise;
      activeRetries -= 1;
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 1,
  } as unknown as RoomAgentDeliveryDeps;
  const deliveries = [];
  for (let index = 0; index < 12; index += 1) {
    const sessionId = `saturated_scheduler_${index}`;
    const delivery = await beginRoomAgentDelivery({
      req: { query: { actor_label: sessionId }, get: () => undefined } as unknown as AuthenticatedRequest,
      roomId: "room_saturated_scheduler",
      transport: "long_poll",
    }, deps);
    assert.ok(delivery);
    deliveries.push(delivery);
  }
  await Promise.all(deliveries.map((delivery) => delivery.end()));
  await eightRetries;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
    if ((timeout ?? 0) === 0) zeroDelayTimers += 1;
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof globalThis.setTimeout;
  try {
    await new Promise<void>((resolve) => originalSetTimeout(resolve, 40));
    assert.equal(zeroDelayTimers, 0, "a full worker pool relies on completion, not a 0ms spin timer");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    retryGate.resolve();
  }
  await drainRoomAgentDeliveryLeases();
});

test("repeated failures for one session retain only a bounded exact-instance backlog", async () => {
  let disconnectAttempts = 0;
  const identity = {
    actor_label: "Bounded Backlog | Owner | MCP",
    agent_key: "owner/bounded-backlog",
    agent_instance_id: "instance_bounded_backlog",
    agent_session_id: "session_bounded_backlog",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Bounded Backlog",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      disconnectAttempts += 1;
      if (disconnectAttempts <= 20) throw new Error("database unavailable");
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 1,
  } as unknown as RoomAgentDeliveryDeps;
  for (let index = 0; index < 20; index += 1) {
    const delivery = await beginRoomAgentDelivery({
      req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
      roomId: "room_bounded_backlog",
      transport: "long_poll",
    }, deps);
    assert.ok(delivery);
    await delivery.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 3));
  }
  assert.equal(disconnectAttempts, 20);
  await drainRoomAgentDeliveryLeases();
  assert.equal(disconnectAttempts, 36, "only the newest sixteen exact release tokens are retained");
});

test("ambiguous connect compensation enters the bounded shutdown retry lane", async () => {
  let compensationAttempts = 0;
  const identity = {
    actor_label: "Ambiguous Connect | Owner | MCP",
    agent_key: "owner/ambiguous-connect",
    agent_instance_id: "instance_ambiguous_connect",
    agent_session_id: "session_ambiguous_connect",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Ambiguous Connect",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  await assert.rejects(beginRoomAgentDelivery({
    req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
    roomId: "room_ambiguous_connect",
    transport: "long_poll",
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => { throw new Error("response lost after commit"); },
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      compensationAttempts += 1;
      if (compensationAttempts === 1) throw new Error("compensation transport failed");
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
  } as unknown as RoomAgentDeliveryDeps), /response lost after commit/);
  assert.equal(compensationAttempts, 1);
  await drainRoomAgentDeliveryLeases();
  assert.equal(compensationAttempts, 2);
});

test("shutdown waits for an in-flight idle release without decrementing it twice", async () => {
  let releaseDisconnect!: () => void;
  let disconnectStarted!: () => void;
  const disconnectGate = new Promise<void>((resolve) => { releaseDisconnect = resolve; });
  const disconnectStart = new Promise<void>((resolve) => { disconnectStarted = resolve; });
  let disconnectCalls = 0;
  const identity = {
    actor_label: "Shutdown Race Poller | Owner | MCP",
    agent_key: "owner/shutdown-race-poller",
    agent_instance_id: "instance_shutdown_race_poll",
    agent_session_id: "session_shutdown_race_poll",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Shutdown Race Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const delivery = await beginRoomAgentDelivery({
    req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
    roomId: "room_shutdown_race_poll",
    transport: "long_poll",
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      disconnectCalls += 1;
      disconnectStarted();
      await disconnectGate;
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 5,
  } as unknown as RoomAgentDeliveryDeps);
  assert.ok(delivery);
  await delivery.end();
  await disconnectStart;
  const drain = drainRoomAgentDeliveryLeases();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disconnectCalls, 1);
  releaseDisconnect();
  await drain;
  assert.equal(disconnectCalls, 1);
});

test("shutdown accepts a successful idempotent retry after its in-flight idle release fails", async () => {
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  let disconnectCalls = 0;
  const identity = {
    actor_label: "Shutdown Retry Poller | Owner | MCP",
    agent_key: "owner/shutdown-retry-poller",
    agent_instance_id: "instance_shutdown_retry_poll",
    agent_session_id: "session_shutdown_retry_poll",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Shutdown Retry Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const delivery = await beginRoomAgentDelivery({
    req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
    roomId: "room_shutdown_retry_poll",
    transport: "long_poll",
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      disconnectCalls += 1;
      if (disconnectCalls === 1) {
        firstStarted();
        await firstGate;
        throw new Error("ambiguous first release");
      }
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 5,
  } as unknown as RoomAgentDeliveryDeps);
  assert.ok(delivery);
  await delivery.end();
  await firstStart;
  const drain = drainRoomAgentDeliveryLeases();
  releaseFirst();
  await drain;
  assert.equal(disconnectCalls, 2);
});

test("shutdown drains an idle delivery lease before database teardown", async () => {
  let disconnected = 0;
  const identity = {
    actor_label: "Shutdown Poller | Owner | MCP",
    agent_key: "owner/shutdown-poller",
    agent_instance_id: "instance_shutdown_poll",
    agent_session_id: "session_shutdown_poll",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Shutdown Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const delivery = await beginRoomAgentDelivery({
    req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
    roomId: "room_shutdown_poll",
    transport: "long_poll",
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => { disconnected += 1; },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 60_000,
  } as unknown as RoomAgentDeliveryDeps);
  assert.ok(delivery);
  await delivery.end();
  assert.equal(disconnected, 0);
  await drainRoomAgentDeliveryLeases();
  assert.equal(disconnected, 1);
});

test("shutdown surfaces a durable lease disconnect failure", async () => {
  const identity = {
    actor_label: "Failed Shutdown Poller | Owner | MCP",
    agent_key: "owner/failed-shutdown-poller",
    agent_instance_id: "instance_failed_shutdown_poll",
    agent_session_id: "session_failed_shutdown_poll",
    session_kind: "worker" as const,
    runtime: "mcp",
    display_name: "Failed Shutdown Poller",
    owner_label: "Owner",
    ide_label: "MCP",
    repo_branch: null,
  };
  const delivery = await beginRoomAgentDelivery({
    req: { query: {}, get: () => undefined } as unknown as AuthenticatedRequest,
    roomId: "room_failed_shutdown_poll",
    transport: "long_poll",
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => {
      throw new Error("disconnect database unavailable");
    },
    markRoomAgentDeliveryHeartbeat: async () => true,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
    idleLeaseMs: 60_000,
  } as unknown as RoomAgentDeliveryDeps);
  assert.ok(delivery);
  await delivery.end();
  await assert.rejects(
    drainRoomAgentDeliveryLeases(),
    /Failed to drain room agent delivery leases/,
  );
});

test("forced disconnect closes every shared socket without a second durable disconnect", async () => {
  let forced = 0;
  let disconnected = 0;
  let closed = 0;
  const identity = {
    actor_label: "Codex (EmmyMay/VS Code)",
    agent_key: "emmymay/codex-force",
    agent_instance_id: "instance_force",
    agent_session_id: "session_force",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Codex",
    owner_label: "EmmyMay",
    ide_label: "VS Code",
    repo_branch: "codex/event-broker",
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => {
      forced += 1;
      return null;
    },
    markRoomAgentDeliveryDisconnected: async () => {
      disconnected += 1;
      return undefined;
    },
    markRoomAgentDeliveryHeartbeat: async () => undefined,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 5_000,
  } as unknown as RoomAgentDeliveryDeps;
  const req = { query: {}, get: () => undefined } as unknown as AuthenticatedRequest;
  const [first, second] = await Promise.all([
    beginRoomAgentDelivery({
      req,
      roomId: "room_delivery_force",
      transport: "sse",
      onSessionDisconnected: () => { closed += 1; },
    }, deps),
    beginRoomAgentDelivery({
      req,
      roomId: "room_delivery_force",
      transport: "long_poll",
      onSessionDisconnected: () => { closed += 1; },
    }, deps),
  ]);
  assert.ok(first);
  assert.ok(second);

  await disconnectRoomAgentDeliverySession({
    room_id: "room_delivery_force",
    agent_session_id: "session_force",
  }, deps);
  assert.equal(forced, 1);
  assert.equal(closed, 2);

  await Promise.all([first.end(), second.end()]);
  assert.equal(disconnected, 0, "the force operation already owns the terminal DB transition");
});

test("force disconnect fences a request still blocked in identity resolution", async () => {
  let releaseIdentity!: () => void;
  let identityStarted!: () => void;
  const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  const identityStart = new Promise<void>((resolve) => { identityStarted = resolve; });
  let connected = 0;
  let forced = 0;
  const identity = {
    actor_label: "Codex (EmmyMay/VS Code)",
    agent_key: "emmymay/codex-identity-race",
    agent_instance_id: "instance_identity_race",
    agent_session_id: "session_identity_race",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Codex",
    owner_label: "EmmyMay",
    ide_label: "VS Code",
    repo_branch: "codex/event-broker",
  };
  const deps = {
    resolveRequestAgentIdentity: async () => {
      identityStarted();
      await identityGate;
      return identity;
    },
    markRoomAgentDeliveryConnected: async () => { connected += 1; },
    forceDisconnectRoomAgentDeliverySession: async () => {
      forced += 1;
      return null;
    },
    markRoomAgentDeliveryDisconnected: async () => undefined,
    markRoomAgentDeliveryHeartbeat: async () => undefined,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 5_000,
  } as unknown as RoomAgentDeliveryDeps;
  const req = {
    query: {},
    get: (name: string) => name === "X-LetAgents-Agent-Session-Id"
      ? "session_identity_race"
      : name === "X-LetAgents-Agent-Session-Token"
        ? "token_identity_race"
        : undefined,
  } as unknown as AuthenticatedRequest;

  const beginning = beginRoomAgentDelivery({
    req,
    roomId: "room_delivery_identity_race",
    transport: "sse",
  }, deps);
  await identityStart;
  await disconnectRoomAgentDeliverySession({
    room_id: "room_delivery_identity_race",
    agent_session_id: "session_identity_race",
  }, deps);
  assert.equal(forced, 1, "force does not wait for a request that has not reached durable setup");
  releaseIdentity();
  await assert.rejects(beginning, InvalidRoomAgentDeliverySessionError);
  assert.equal(connected, 0, "the stale request never resurrects the durable session");
});

test("force disconnect is the final durable transition when connected setup is blocked", async () => {
  let releaseConnected!: () => void;
  let connectedStarted!: () => void;
  const connectedGate = new Promise<void>((resolve) => { releaseConnected = resolve; });
  const connectedStart = new Promise<void>((resolve) => { connectedStarted = resolve; });
  const transitions: string[] = [];
  const identity = {
    actor_label: "Codex (EmmyMay/VS Code)",
    agent_key: "emmymay/codex-setup-race",
    agent_instance_id: "instance_setup_race",
    agent_session_id: "session_setup_race",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Codex",
    owner_label: "EmmyMay",
    ide_label: "VS Code",
    repo_branch: "codex/event-broker",
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => {
      transitions.push("connected:start");
      connectedStarted();
      await connectedGate;
      transitions.push("connected:end");
    },
    forceDisconnectRoomAgentDeliverySession: async () => {
      transitions.push("forced");
      return null;
    },
    markRoomAgentDeliveryDisconnected: async () => {
      transitions.push("compensated");
    },
    markRoomAgentDeliveryHeartbeat: async () => undefined,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 5_000,
  } as unknown as RoomAgentDeliveryDeps;
  const req = {
    query: {},
    get: (name: string) => name === "X-LetAgents-Agent-Session-Id"
      ? "session_setup_race"
      : name === "X-LetAgents-Agent-Session-Token"
        ? "token_setup_race"
        : undefined,
  } as unknown as AuthenticatedRequest;

  const beginning = beginRoomAgentDelivery({
    req,
    roomId: "room_delivery_setup_race",
    transport: "sse",
  }, deps);
  await connectedStart;
  const disconnecting = disconnectRoomAgentDeliverySession({
    room_id: "room_delivery_setup_race",
    agent_session_id: "session_setup_race",
  }, deps);
  releaseConnected();
  await assert.rejects(beginning, InvalidRoomAgentDeliverySessionError);
  await disconnecting;
  assert.deepEqual(transitions, ["connected:start", "connected:end", "compensated", "forced"]);
});

test("credential replacement retires only v1 local delivery state on a stable session id", async () => {
  let connected = 0;
  let disconnected = 0;
  let v1Closed = 0;
  let v2Closed = 0;
  const identities = {
    old: {
      actor_label: "Codex (EmmyMay/VS Code)",
      agent_key: "emmymay/codex-stable",
      agent_instance_id: "instance_stable",
      agent_session_id: "session_stable",
      session_kind: "worker" as const,
      runtime: "codex",
      display_name: "Codex",
      owner_label: "EmmyMay",
      ide_label: "VS Code",
      repo_branch: "codex/event-broker",
      credential_fence: { kind: "bearer" as const, bearer_id: "bearer_v1", generation: 1 },
    },
    next: {
      actor_label: "Codex (EmmyMay/VS Code)",
      agent_key: "emmymay/codex-stable",
      agent_instance_id: "instance_stable",
      agent_session_id: "session_stable",
      session_kind: "worker" as const,
      runtime: "codex",
      display_name: "Codex",
      owner_label: "EmmyMay",
      ide_label: "VS Code",
      repo_branch: "codex/event-broker",
      credential_fence: { kind: "bearer" as const, bearer_id: "bearer_v2", generation: 2 },
    },
  };
  const deps = {
    resolveRequestAgentIdentity: async ({ req }: { req: AuthenticatedRequest }) =>
      req.get("X-Test-Credential") === "v2" ? identities.next : identities.old,
    markRoomAgentDeliveryConnected: async () => { connected += 1; },
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => { disconnected += 1; },
    markRoomAgentDeliveryHeartbeat: async () => undefined,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 5_000,
  } as unknown as RoomAgentDeliveryDeps;
  const request = (version: "v1" | "v2") => ({
    query: {},
    get: (name: string) => name === "X-LetAgents-Agent-Session-Id"
      ? "session_stable"
      : name === "X-LetAgents-Agent-Session-Token"
        ? `token_${version}`
        : name === "X-Test-Credential"
          ? version
          : undefined,
  }) as unknown as AuthenticatedRequest;

  const v1 = await beginRoomAgentDelivery({
    req: request("v1"),
    roomId: "room_delivery_stable",
    transport: "sse",
    onSessionDisconnected: () => { v1Closed += 1; },
  }, deps);
  const v2 = await beginRoomAgentDelivery({
    req: request("v2"),
    roomId: "room_delivery_stable",
    transport: "sse",
    onSessionDisconnected: () => { v2Closed += 1; },
  }, deps);
  assert.equal(connected, 2, "v2 cannot inherit v1's process-local heartbeat lease");
  assert.equal(v1Closed, 1);
  assert.equal(v2Closed, 0);

  roomAgentCredentialInvalidationEvents.emitLocal("invalidate", {
    room_id: "room_delivery_stable",
    agent_session_id: "session_stable",
    credential_fingerprints: [bearerDeliveryCredentialFingerprint("bearer_v1", 1)],
    reason: "rotated",
  });
  assert.equal(v2Closed, 0, "a delayed v1 marker cannot retire v2");
  roomAgentCredentialInvalidationEvents.emitLocal("invalidate", {
    room_id: "room_delivery_stable",
    agent_session_id: "session_stable",
    credential_fingerprints: [bearerDeliveryCredentialFingerprint("bearer_v2", 2)],
    reason: "ended",
  });
  assert.equal(v2Closed, 1);
  await Promise.all([v1?.end(), v2?.end()]);
  assert.equal(disconnected, 0, "credential retirement already owns the terminal DB transition");
});

test("an inactive heartbeat credential retires the shared delivery lease", async () => {
  let active = true;
  let disconnected = 0;
  const identity = {
    actor_label: "Expiry | Owner | Codex",
    agent_key: "owner/expiry",
    agent_instance_id: "instance_expiry",
    agent_session_id: "session_expiry",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Expiry",
    owner_label: "Owner",
    ide_label: "Codex",
    repo_branch: null,
    credential_fence: { kind: "bearer" as const, bearer_id: "bearer_expiry", generation: 1 },
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => undefined,
    markRoomAgentDeliveryHeartbeat: async () => active,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 5_000,
  } as unknown as RoomAgentDeliveryDeps;
  const delivery = await beginRoomAgentDelivery({
    req: {
      query: {},
      get: (name: string) => name === "X-LetAgents-Agent-Session-Id"
        ? "session_expiry"
        : name === "X-LetAgents-Agent-Session-Token"
          ? "token_expiry"
          : undefined,
    } as unknown as AuthenticatedRequest,
    roomId: "room_expiry",
    transport: "sse",
    onSessionDisconnected: () => { disconnected += 1; },
  }, deps);
  assert.ok(delivery);
  assert.equal(await delivery.checkCredential(), true);
  active = false;
  assert.equal(await delivery.checkCredential(), false);
  assert.equal(disconnected, 1);
  assert.equal(await delivery.checkCredential(), false);
  await delivery.end();
});

test("periodic heartbeat expiry retires the shared lease without an invalidation event", async () => {
  let active = true;
  let resolveDisconnected!: () => void;
  const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve; });
  const identity = {
    actor_label: "Natural Expiry | Owner | Codex",
    agent_key: "owner/natural-expiry",
    agent_instance_id: "instance_natural_expiry",
    agent_session_id: "session_natural_expiry",
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Natural Expiry",
    owner_label: "Owner",
    ide_label: "Codex",
    repo_branch: null,
    credential_fence: { kind: "bearer" as const, bearer_id: "bearer_natural_expiry", generation: 1 },
  };
  const deps = {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => undefined,
    markRoomAgentDeliveryHeartbeat: async () => active,
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 5,
  } as unknown as RoomAgentDeliveryDeps;
  const delivery = await beginRoomAgentDelivery({
    req: {
      query: {},
      get: (name: string) => name === "X-LetAgents-Agent-Session-Id"
        ? identity.agent_session_id
        : name === "X-LetAgents-Agent-Session-Token"
          ? "token_natural_expiry"
          : undefined,
    } as unknown as AuthenticatedRequest,
    roomId: "room_natural_expiry",
    transport: "sse",
    onSessionDisconnected: resolveDisconnected,
  }, deps);
  assert.ok(delivery);
  active = false;
  await Promise.race([
    disconnected,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("periodic credential expiry did not retire the lease")),
      500,
    )),
  ]);
  assert.equal(await delivery.checkCredential(), false);
  await delivery.end();
});

test("bearer expiry retires at its exact deadline before the periodic heartbeat", async () => {
  let heartbeatCalls = 0;
  let resolveDisconnected!: () => void;
  const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve; });
  const identity = {
    actor_label: "Exact Expiry | Owner | Codex",
    agent_key: "owner/exact-expiry",
    agent_instance_id: "instance_exact_expiry",
    agent_session_id: "session_exact_expiry",
    session_kind: "worker" as const,
    runtime: "codex", display_name: "Exact Expiry", owner_label: "Owner", ide_label: "Codex",
    repo_branch: null,
    credential_fence: {
      kind: "bearer" as const,
      bearer_id: "bearer_exact_expiry",
      generation: 1,
      expires_at: new Date(Date.now() + 20).toISOString(),
    },
  };
  const delivery = await beginRoomAgentDelivery({
    req: { query: {}, get: (name: string) => name.includes("Session-Id")
      ? identity.agent_session_id : name.includes("Session-Token") ? "token" : undefined } as never,
    roomId: "room_exact_expiry", transport: "sse", onSessionDisconnected: resolveDisconnected,
  }, {
    resolveRequestAgentIdentity: async () => identity,
    markRoomAgentDeliveryConnected: async () => undefined,
    forceDisconnectRoomAgentDeliverySession: async () => null,
    markRoomAgentDeliveryDisconnected: async () => undefined,
    markRoomAgentDeliveryHeartbeat: async () => { heartbeatCalls += 1; return false; },
    upsertRoomParticipant: async () => undefined,
    heartbeatIntervalMs: 60_000,
  } as unknown as RoomAgentDeliveryDeps);
  assert.ok(delivery);
  await Promise.race([
    disconnected,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("expiry timer did not fire")), 500)),
  ]);
  assert.equal(heartbeatCalls, 1);
  assert.equal(await delivery.checkCredential(), false);
  await delivery.end();
});
