import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultManagedAgentProvider,
  getManagedAgentProvider,
  registerManagedAgentProvider,
  resetManagedAgentProvidersForTest,
  toManagedAgentStartResponse,
  type ManagedAgentProvider,
} from "../managed-agent-providers.js";

test.afterEach(() => {
  resetManagedAgentProvidersForTest();
});

test("Codex is the default managed-agent provider with existing response keys", () => {
  const provider = getDefaultManagedAgentProvider();

  assert.equal(provider.id, "codex");
  assert.deepEqual(provider.responseKeys, {
    localSession: "local_codex_session",
    localSessionStarted: "local_codex_session_started",
    localSessionReused: "local_codex_session_reused",
  });
});

test("registry rejects duplicate provider ids unless replacing for tests", () => {
  const provider = getManagedAgentProvider("codex");

  assert.throws(() => registerManagedAgentProvider(provider), /already registered/);
});

test("managed-agent start response is keyed by the selected provider", () => {
  const provider: ManagedAgentProvider = {
    id: "stub",
    displayName: "Stub",
    responseKeys: {
      localSession: "local_stub_session",
      localSessionStarted: "local_stub_session_started",
      localSessionReused: "local_stub_session_reused",
    },
    getCurrentLiveSessionPayload: () => null,
    startLocalSession: async () => ({ session: { session_id: "stub_session" }, reused: false }),
    inspectLocalSession: async () => null,
    stopLocalSession: async () => null,
    toPublicLiveSession: (session) => session as Record<string, unknown>,
  };

  assert.deepEqual(
    toManagedAgentStartResponse(provider, {
      session: { session_id: "stub_session" },
      reused: false,
    }),
    {
      local_stub_session: { session_id: "stub_session" },
      local_stub_session_started: true,
      local_stub_session_reused: false,
    }
  );
});
