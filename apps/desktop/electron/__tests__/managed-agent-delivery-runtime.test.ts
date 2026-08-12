import assert from "node:assert/strict";
import test, { mock } from "node:test";

let releaseCloudPreflight!: () => void;
let cloudPreflightStarted!: () => void;
const cloudPreflightGate = new Promise<void>((resolve) => { releaseCloudPreflight = resolve; });
const cloudPreflightStart = new Promise<void>((resolve) => { cloudPreflightStarted = resolve; });
let roomStreamImports = 0;
let apiPosts = 0;

mock.module("../main/agents/managed-agent-local-worker-session.js", {
  namedExports: {
    createLocalDesktopManagedAgentWorkerSession: async () => null,
    resolveDesktopManagedAgentWorkerRegistration: async () => ({
      storage: { mode: "cloud" },
      cloudRoomIdentifier: "room_runtime_retire",
    }),
    shouldUseCloudDesktopManagedAgentWorkerSession: async () => {
      cloudPreflightStarted();
      await cloudPreflightGate;
      return true;
    },
  },
});

mock.module("../main/agents/state.js", {
  namedExports: {
    getOrCreateDesktopHostId: () => "host_test",
    getStoredAgentIdentity: () => null,
    getStoredAgentIdentityForRuntimeKey: () => null,
    getStoredAgentSession: () => null,
    markAgentSessionEnded: () => {},
    saveAgentSession: (session: unknown) => session,
    saveStoredAgentIdentity: (identity: unknown) => identity,
    supervisorEntryIdForAgentSession: () => null,
  },
});

mock.module("../main/room-stream.js", {
  namedExports: {
    getActiveRoomIdentifier: () => {
      roomStreamImports += 1;
      return "room_runtime_retire";
    },
  },
});

mock.module("../main/auth.js", {
  namedExports: {
    apiFetch: async () => {
      apiPosts += 1;
      return {};
    },
    DesktopApiError: class DesktopApiError extends Error {},
    readStoredAuth: async () => ({ account: null }),
  },
});

const {
  endDesktopManagedWorkerSession,
  startDesktopManagedWorkerDeliveryHeartbeat,
} = await import("../main/agents/managed-agent-worker.js");

test("ending during cloud preflight cannot recreate a retired delivery runtime or post a heartbeat", async () => {
  const session = {
    session_id: "agent_session_runtime_retire",
    session_token: "agent_token_runtime_retire",
    room_id: "room_runtime_retire",
    session_kind: "worker" as const,
    runtime: "codex",
    host_id: "host_test",
    host_kind: null,
    host_label: null,
    liveness_capability: null,
    tool_bridge_id: null,
    actor_label: "Oak | Emmy's agent | Codex",
    agent_key: "owner/oak",
    agent_instance_id: "instance_runtime_retire",
    display_name: "Oak",
    owner_label: "Emmy",
    ide_label: "Codex",
    repo_branch: "staging",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    ended_at: null,
  };

  startDesktopManagedWorkerDeliveryHeartbeat(session, session.room_id);
  await cloudPreflightStart;
  endDesktopManagedWorkerSession(session.session_id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseCloudPreflight();
  await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

  assert.equal(roomStreamImports, 0, "the stale preflight cannot advance to room inspection");
  assert.equal(apiPosts, 0, "the stale preflight cannot resurrect the ended session on the server");
});
