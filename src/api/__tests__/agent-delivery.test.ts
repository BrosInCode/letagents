import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedRequest } from "../http/helpers.js";
import type { RoomAgentDeliveryDeps } from "../rooms/agent-delivery.js";

process.env.DB_URL ||= "postgresql://postgres:postgres@127.0.0.1:1/letagents";
const {
  beginRoomAgentDelivery,
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
