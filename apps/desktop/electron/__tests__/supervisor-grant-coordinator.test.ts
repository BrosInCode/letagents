import assert from "node:assert/strict";
import test from "node:test";

import { SupervisorGrantCoordinator, type SupervisorGrantCoordinatorOperations } from "../main/supervisor-grant-coordinator.js";
import type { DesktopSupervisorManifestEntry } from "../ipc-types.js";

const metadata = (key: string, id = "grant_1") => ({
  grantId: id, hostId: "host_1", installationId: "install_1", allowedRoomIds: ["room_1"],
  allowedAgentKeys: [key], generation: 1, expiresAt: "2099-01-01T00:00:00.000Z",
});

function entry(id = "supervised_launch_1234567"): DesktopSupervisorManifestEntry {
  return {
    id, roomId: "room_1", displayName: "Mutable label", provider: "codex", model: null, charter: "help",
    desiredState: "running", observedState: "working", condition: "none", lastError: null,
    permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "desktop", createdAt: "2026-01-01T00:00:00.000Z",
    workspacePath: null, workAttemptId: "attempt_1", agentSessionId: "session_1", agentSessionBindingState: "active",
    bindingUpdatedAt: "2026-01-01T00:00:00.000Z", executionGenerationId: "execution_1", providerContinuationId: "thread_1",
    providerPid: 4242, workplaceLiveness: { state: "reachable", observedAt: null, detail: null },
    nativeLiveness: { state: "active", observedAt: null, detail: null }, readyReachedAt: null, restartCount: 0,
    lastTerminal: null, activity: [], roomAgentState: null, deliveryReceipts: [], turnControl: null,
  };
}

function harness(overrides: Partial<SupervisorGrantCoordinatorOperations> = {}) {
  const events: string[] = [];
  const grants = new Map<string, { metadata: ReturnType<typeof metadata>; token: string; entryId: string; lastInstalledDaemonGeneration: number | null }>();
  const daemon = {
    async ensureRunning() { events.push("ensure"); return { generation: 7 }; },
    async create(input: { roomIdentifier: string }) { events.push(`create:${input.roomIdentifier}`); return { ...entry(), roomId: input.roomIdentifier, desiredState: "paused" as const }; },
    async list() { events.push("list"); return [entry()]; },
    async installHostGrant(input: { supervisorGrant: string; daemonGeneration: number }) {
      events.push(`install:${input.daemonGeneration}`);
      assert.equal(input.supervisorGrant.includes("secret"), true);
      return "installed" as const;
    },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    async resolveIdentity(input) { events.push(`identity:${input.entryId}`); return `owner/${input.entryId}`; },
    async provision(input) {
      events.push(`provision:${input.entryId}:${Boolean(input.forceReprovision)}`);
      const result = { metadata: metadata(input.agentKey), token: "secret_provisioned", entryId: input.entryId, lastInstalledDaemonGeneration: null };
      grants.set(input.agentKey, result);
      return result;
    },
    async readEntryAgentKey(id) { events.push(`read-key:${id}`); return `owner/${id}`; },
    async readGrant(key) { events.push(`read-grant:${key}`); return grants.get(key) ?? null; },
    async replaceGrant(input) {
      events.push(`replace:${input.lastInstalledDaemonGeneration ?? "none"}`);
      grants.set(input.agentKey, { metadata: input.metadata, token: input.token, entryId: input.entryId!, lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null });
    },
    ...overrides,
  };
  const request = (async () => { throw new Error("unexpected request"); }) as never;
  return { events, grants, daemon, operations, coordinator: new SupervisorGrantCoordinator(daemon as never, request, () => "host_1", operations, async () => "room_1") };
}

test("fresh Codex launch provisions before paused claim, installs before activation can occur", async () => {
  const h = harness();
  const result = await h.coordinator.createPausedAndInstall({
    creationRequestId: "launch_1234567", roomIdentifier: "room_1", displayName: "Mutable label", providerId: "codex", charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo",
  });
  assert.equal(result.entry.desiredState, "paused");
  assert.deepEqual(h.events, [
    "ensure", "identity:supervised_launch_1234567", "provision:supervised_launch_1234567:false", "create:room_1", "ensure", "install:7", "replace:7",
  ]);
  assert.equal(JSON.stringify(result).includes("secret_provisioned"), false, "no bearer is in the public coordinator result");
});

test("grant failure occurs before the paused manifest can be activated", async () => {
  const h = harness({ provision: async () => { throw new Error("owner auth unavailable"); } });
  await assert.rejects(h.coordinator.createPausedAndInstall({
    creationRequestId: "launch_1234567", roomIdentifier: "room_1", displayName: "A", providerId: "codex", charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo",
  }), /owner auth unavailable/);
  assert.equal(h.events.some((event) => event.startsWith("create:")), false);
  assert.equal(h.events.some((event) => event.startsWith("install:")), false);
});

test("app restart same daemon generation reinstalls idempotently without a handoff", async () => {
  const h = harness();
  h.grants.set("owner/supervised_launch_1234567", { metadata: metadata("owner/supervised_launch_1234567"), token: "secret_same", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 7 });
  await h.coordinator.reconcileDesiredRunning();
  assert.equal(h.events.some((event) => event === "install:7"), true);
  assert.equal(h.events.some((event) => event.includes("provision")), false);
});

test("Reconnect repairs only the exact credential binding and does not restart the provider", async () => {
  const h = harness();
  h.grants.set("owner/supervised_launch_1234567", { metadata: metadata("owner/supervised_launch_1234567"), token: "secret_same", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 7 });
  await h.coordinator.reconnectEntry(entry());
  assert.equal(h.events.filter((event) => event === "install:7").length, 1);
  assert.equal(h.events.some((event) => event.startsWith("create:")), false);
  assert.equal(h.events.some((event) => event.startsWith("provision:")), false);
  assert.equal(entry().providerPid, 4242, "Reconnect retains the existing provider runtime/continuation.");
});

test("restart recovery repairs a lowercase mapping before provisioning and installing", async () => {
  const h = harness();
  const exactKey = "EmmyMay/desktop-codex-canonical";
  let provisionedKey: string | null = null;
  let installedKey: string | null = null;
  const daemon = {
    ...h.daemon,
    async installHostGrant(input: { agentKey: string }) {
      installedKey = input.agentKey;
      return "installed" as const;
    },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    ...h.operations,
    readEntryAgentKey: async () => "emmymay/desktop-codex-canonical",
    readGrant: async () => null,
    resolveIdentity: async () => exactKey,
    provision: async (input) => {
      provisionedKey = input.agentKey;
      return {
        metadata: metadata(input.agentKey), token: "secret_repaired", entryId: input.entryId,
        lastInstalledDaemonGeneration: null,
      };
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    operations,
    async () => "room_1",
  );
  await coordinator.reconcileDesiredRunning();
  assert.equal(provisionedKey, exactKey);
  assert.equal(installedKey, exactKey);
});

test("daemon generation notifications reconcile once per generation without recursive ensure", async () => {
  let generation = 7;
  let ensures = 0;
  let lists = 0;
  const daemon = {
    async ensureRunning() { ensures += 1; return { generation }; },
    async list() { lists += 1; return []; },
  };
  const c = new SupervisorGrantCoordinator(daemon as never);
  c.scheduleReconciliation({ generation: 7 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  c.scheduleReconciliation({ generation: 7 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lists, 1);
  generation = 8;
  c.scheduleReconciliation({ generation: 8 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lists, 2);
  assert.equal(ensures, 2, "reconciliation may ensure once but never recursively schedules the same generation");
});

test("persistent same-generation reconciliation failure does not retry-storm", async () => {
  let attempts = 0;
  const daemon = {
    async ensureRunning() { return { generation: 7 }; },
    async list() { attempts += 1; throw new Error("owner auth unavailable"); },
  };
  const c = new SupervisorGrantCoordinator(daemon as never);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    c.scheduleReconciliation({ generation: 7 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("a generation change during reconciliation schedules exactly one follow-up", async () => {
  let generation = 7;
  let lists = 0;
  let releaseFirst!: () => void;
  let signalFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const daemon = {
    async ensureRunning() { return { generation }; },
    async list() {
      lists += 1;
      if (lists === 1) { signalFirst(); await firstReleased; }
      return [];
    },
  };
  const c = new SupervisorGrantCoordinator(daemon as never);
  c.scheduleReconciliation({ generation: 7 });
  await firstStarted;
  generation = 8;
  c.scheduleReconciliation({ generation: 8 });
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lists, 2);
});

test("daemon successor rotates then persists the replacement before exact-generation install", async () => {
  const h = harness();
  const key = "owner/supervised_launch_1234567";
  h.grants.set(key, { metadata: metadata(key), token: "secret_old", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 6 });
  const request = (async () => ({
    grant_id: "grant_2", host_id: "host_1", installation_id: "install_1", allowed_room_ids: ["room_1"], allowed_agent_keys: [key],
    current_generation: 2, expires_at: "2099-01-01T00:00:00.000Z", supervisor_grant: "secret_successor",
  })) as never;
  const replacementHarness = harness();
  replacementHarness.grants.set(key, { metadata: metadata(key), token: "secret_old", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 6 });
  const c = new SupervisorGrantCoordinator(replacementHarness.daemon as never, request, () => "host_1", {
    resolveIdentity: async () => key, provision: async () => { throw new Error("must not reprovision"); },
    readEntryAgentKey: async () => key, readGrant: async () => replacementHarness.grants.get(key)!,
    replaceGrant: async (input) => { replacementHarness.events.push(`replace:${input.lastInstalledDaemonGeneration ?? "none"}`); replacementHarness.grants.set(key, { metadata: input.metadata, token: input.token, entryId: input.entryId!, lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null }); },
  }, async () => "room_1");
  await c.reconcileDesiredRunning();
  assert.deepEqual(replacementHarness.events.filter((event) => event.startsWith("replace") || event.startsWith("install")), ["replace:none", "install:7", "replace:7"]);
});

test("stale or revoked handoff safely owner-reprovisions, and two entries stay independent", async () => {
  const h = harness({
    readEntryAgentKey: async (id) => `owner/${id}`,
    readGrant: async () => ({ metadata: metadata("owner/key"), token: "secret_stale", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 1 }),
  });
  const request = (async () => { throw new Error("stale bearer"); }) as never;
  const c = new SupervisorGrantCoordinator(h.daemon as never, request, () => "host_1", h.operations, async () => "room_1");
  await c.reconcileDesiredRunning();
  assert.equal(h.events.some((event) => event === "provision:supervised_launch_1234567:true"), true);
  assert.equal(entry().providerPid, 4242, "grant work never signals or migrates the live provider");
});

test("canonical room reuse avoids alias-triggered reprovision while independent agents share a room", async () => {
  const h = harness();
  const scopes: Array<Array<{ requestedRoomId: string; canonicalRoomId: string }>> = [];
  const operations: SupervisorGrantCoordinatorOperations = {
    ...h.operations,
    provision: async (input) => {
      scopes.push(input.roomScopes);
      return h.operations.provision(input);
    },
  };
  const c = new SupervisorGrantCoordinator(h.daemon as never, (async () => { throw new Error("unexpected"); }) as never, () => "host_1", operations, async () => "room_canonical");
  await c.createPausedAndInstall({
    creationRequestId: "launch_alias_1234567", roomIdentifier: "github.com/Owner/Repo", displayName: "First", providerId: "codex", charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo",
  });
  assert.deepEqual(scopes, [[{ requestedRoomId: "github.com/Owner/Repo", canonicalRoomId: "room_canonical" }]]);
  // A separate durable entry maps to a separate canonical key/grant even in
  // the same canonical room; no display-name comparison participates.
  const second = entry("supervised_second_1234567");
  const installs: string[] = [];
  const daemon = { ...h.daemon, async list() { return [entry(), second]; }, async installHostGrant(input: { entryId: string }) { installs.push(input.entryId); return "installed" as const; } };
  const grants = new Map<string, any>([
    ["owner/supervised_launch_1234567", { metadata: metadata("owner/supervised_launch_1234567"), token: "secret_a", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 7 }],
    ["owner/supervised_second_1234567", { metadata: metadata("owner/supervised_second_1234567"), token: "secret_b", entryId: "supervised_second_1234567", lastInstalledDaemonGeneration: 7 }],
  ]);
  const independent = new SupervisorGrantCoordinator(daemon as never, (async () => { throw new Error("unexpected"); }) as never, () => "host_1", {
    resolveIdentity: async ({ entryId }) => `owner/${entryId}`,
    provision: async () => { throw new Error("must reuse"); }, readEntryAgentKey: async (id) => `owner/${id}`,
    readGrant: async (key) => grants.get(key) ?? null, replaceGrant: async () => {},
  }, async () => "room_canonical");
  await independent.reconcileDesiredRunning();
  assert.deepEqual(installs.sort(), ["supervised_launch_1234567", "supervised_second_1234567"]);
});
