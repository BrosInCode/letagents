import assert from "node:assert/strict";
import test from "node:test";

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorGrantCoordinator, type SupervisorGrantCoordinatorOperations } from "../main/supervisor-grant-coordinator.js";
import {
  desktopSupervisorGrantInstallationId,
  encryptSupervisorGrantForStorage,
  getOrProvisionDesktopSupervisorGrantForAgent,
  readDesktopSupervisorGrantAgentKeyForEntry,
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
} from "../main/supervisor-grant.js";
import type { DesktopSupervisorManifestEntry } from "../ipc-types.js";

const keychain = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`keychain:${value}`),
  decryptString: (value: Buffer) => value.toString("utf8").replace("keychain:", ""),
};

async function withRegistry(testBody: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "letagents-coordinator-grant-"));
  const previous = process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH;
  const path = join(directory, "registry.json");
  process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = path;
  try {
    await testBody(path);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH;
    else process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function storageOperations(): SupervisorGrantCoordinatorOperations {
  return {
    resolveIdentity: async ({ entryId }) => `owner/${entryId}`,
    provision: async (input, options) =>
      getOrProvisionDesktopSupervisorGrantForAgent(input, { ...options, storage: keychain }),
    readEntryAgentKey: readDesktopSupervisorGrantAgentKeyForEntry,
    readGrant: async (agentKey) => readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }),
    replaceGrant: async (input) => replaceDesktopSupervisorGrantForAgent(input, { storage: keychain }),
  };
}

const metadata = (key: string, id = "grant_1", roomId = "room_1") => ({
  grantId: id, hostId: "host_1", installationId: "install_1", allowedRoomIds: [roomId],
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
    async bootstrapRoomIngress(entryId: string, daemonGeneration: number) {
      events.push(`bootstrap:${entryId}:${daemonGeneration}`);
      return "bootstrapped" as const;
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
    "ensure", "identity:supervised_launch_1234567", "provision:supervised_launch_1234567:false", "create:room_1", "ensure", "install:7", "bootstrap:supervised_launch_1234567:7", "replace:7",
  ]);
  assert.equal(JSON.stringify(result).includes("secret_provisioned"), false, "no bearer is in the public coordinator result");
});

test("fresh Open Model launch installs the desktop-held endpoint credential before convergence", async () => {
  const h = harness();
  const events: string[] = [];
  const daemon = {
    ...h.daemon,
    async create(input: { roomIdentifier: string }) {
      events.push("create");
      return {
        ...entry(),
        provider: "open-model",
        model: "qwen/agent-model",
        roomId: input.roomIdentifier,
        desiredState: "paused" as const,
      };
    },
    async installOpenModelCredential(input: {
      apiKey: string | null;
      baseUrl: string;
      model: string;
      daemonGeneration: number;
    }) {
      events.push("credential");
      assert.equal(input.apiKey, "provider-key");
      assert.equal(input.baseUrl, "https://models.example.test/v1");
      assert.equal(input.model, "qwen/agent-model");
      assert.equal(input.daemonGeneration, 7);
      return "installed" as const;
    },
    async installHostGrant(input: { supervisorGrant: string }) {
      events.push("grant");
      assert.equal(input.supervisorGrant, "secret_provisioned");
      return "installed" as const;
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    h.operations,
    async () => "room_1",
    async () => ({
      apiKey: "provider-key",
      baseUrl: "https://models.example.test/v1",
      model: "qwen/default-model",
      savedAt: "2026-07-28T00:00:00.000Z",
    }),
  );

  const result = await coordinator.createPausedAndInstall({
    creationRequestId: "launch_1234567",
    roomIdentifier: "room_1",
    displayName: "Open Quartz",
    providerId: "open-model",
    charter: "help",
    model: "qwen/agent-model",
    permissionProfileId: "full_access",
    repoRootPath: "/tmp/repo",
  });

  assert.deepEqual(events, ["create", "credential", "grant"]);
  assert.equal(result.entry.provider, "open-model");
  assert.equal(JSON.stringify(result).includes("provider-key"), false);
});

test("the ownership boundary repairs generic Open Model labels before identity persistence", async () => {
  const h = harness();
  let identityDisplayName: string | null = null;
  let manifestDisplayName: string | null = null;
  const coordinator = new SupervisorGrantCoordinator({
    ...h.daemon,
    async create(input: { roomIdentifier: string; displayName: string }) {
      manifestDisplayName = input.displayName;
      return {
        ...entry(),
        displayName: input.displayName,
        provider: "open-model",
        roomId: input.roomIdentifier,
        desiredState: "paused" as const,
      };
    },
    async installOpenModelCredential() {
      return "installed" as const;
    },
  } as never, (async () => { throw new Error("unexpected request"); }) as never, () => "host_1", {
    ...h.operations,
    async resolveIdentity(input) {
      identityDisplayName = input.displayName ?? null;
      return `owner/${input.entryId}`;
    },
  }, async () => "room_1", async () => ({
    apiKey: "provider-key",
    baseUrl: "https://models.example.test/v1",
    model: "qwen/default-model",
    savedAt: "2026-07-28T00:00:00.000Z",
  }));

  await coordinator.createPausedAndInstall({
    creationRequestId: "open_model_1234567",
    roomIdentifier: "room_1",
    displayName: "Open Model supervised agent",
    providerId: "open-model",
    charter: "help",
    model: "qwen/default-model",
    permissionProfileId: "full_access",
    repoRootPath: "/tmp/repo",
  });

  assert.ok(identityDisplayName);
  assert.equal(manifestDisplayName, identityDisplayName);
  assert.doesNotMatch(identityDisplayName, /open model|supervised agent/i);
});

test("concurrent generic Open Model launches reserve distinct friendly names within a room", async () => {
  const h = harness();
  const entries: DesktopSupervisorManifestEntry[] = [];
  const daemon = {
    ...h.daemon,
    async list() {
      await Promise.resolve();
      return [...entries];
    },
    async create(input: {
      creationRequestId: string;
      roomIdentifier: string;
      displayName: string;
    }) {
      const created = {
        ...entry(`supervised_${input.creationRequestId}`),
        provider: "open-model",
        displayName: input.displayName,
        roomId: input.roomIdentifier,
        desiredState: "paused" as const,
      };
      entries.push(created);
      return created;
    },
    async installOpenModelCredential() {
      return "installed" as const;
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    h.operations,
    async () => "room_1",
    async () => ({
      apiKey: "provider-key",
      baseUrl: "https://models.example.test/v1",
      model: "qwen/default-model",
      savedAt: "2026-07-28T00:00:00.000Z",
    }),
  );
  const create = (creationRequestId: string) => coordinator.createPausedAndInstall({
    creationRequestId,
    roomIdentifier: "room_1",
    displayName: "Open Model supervised agent",
    providerId: "open-model",
    charter: "help",
    model: "qwen/default-model",
    permissionProfileId: "full_access",
    repoRootPath: "/tmp/repo",
  });

  const [first, second] = await Promise.all([
    create("collision_00000005"),
    create("collision_00000070"),
  ]);

  assert.notEqual(first.entry.displayName, second.entry.displayName);
  assert.doesNotMatch(first.entry.displayName, /open model|supervised agent/i);
  assert.doesNotMatch(second.entry.displayName, /open model|supervised agent/i);
});

test("reconciliation repairs an existing generic Open Model identity without replacing its runtime", async () => {
  const h = harness();
  const original = {
    ...entry(),
    provider: "open-model",
    displayName: "Open Model supervised agent",
    model: "qwen/agent-model",
  };
  const exactAgentKey = `owner/${original.id}`;
  h.grants.set(exactAgentKey, {
    metadata: metadata(exactAgentKey),
    token: "secret_same",
    entryId: original.id,
    lastInstalledDaemonGeneration: 7,
  });
  const renamedEntries: DesktopSupervisorManifestEntry[] = [];
  let serverDisplayName: string | null = null;
  const daemon = {
    ...h.daemon,
    async list() {
      h.events.push("list");
      return [renamedEntries.at(-1) ?? original];
    },
    async setDisplayName(id: string, displayName: string) {
      assert.equal(id, original.id);
      const renamed = { ...original, displayName };
      renamedEntries.push(renamed);
      h.events.push(`rename:${displayName}`);
      return renamed;
    },
    async installOpenModelCredential() {
      return "installed" as const;
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    {
      ...h.operations,
      async resolveIdentity(input) {
        serverDisplayName = input.displayName ?? null;
        return exactAgentKey;
      },
    },
    async () => original.roomId,
    async () => ({
      apiKey: "provider-key",
      baseUrl: "https://models.example.test/v1",
      model: original.model!,
      savedAt: "2026-07-29T00:00:00.000Z",
    }),
  );

  await coordinator.reconcileDesiredRunning();

  const renamed = renamedEntries[0];
  assert.ok(renamed);
  assert.equal(renamed.id, original.id);
  assert.equal(renamed.providerPid, original.providerPid);
  assert.equal(renamed.executionGenerationId, original.executionGenerationId);
  assert.equal(renamed.providerContinuationId, original.providerContinuationId);
  assert.equal(serverDisplayName, renamed.displayName);
  assert.doesNotMatch(renamed.displayName, /open model|supervised agent/i);
});

test("Claude daemon-inbox launch provisions its own exact host grant before activation", async () => {
  const h = harness();
  const result = await h.coordinator.createPausedAndInstall({
    creationRequestId: "launch_1234567", roomIdentifier: "room_alias", displayName: "Claude",
    providerId: "claude-code", charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo",
  });
  assert.equal(result.agentKey, "owner/supervised_launch_1234567");
  assert.deepEqual(h.events, [
    "ensure", "identity:supervised_launch_1234567", "provision:supervised_launch_1234567:false",
    "create:room_1", "ensure", "install:7", "bootstrap:supervised_launch_1234567:7", "replace:7",
  ]);
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
  assert.equal(h.events.some((event) => event === "bootstrap:supervised_launch_1234567:7"), true, "a cursorless pre-upgrade running entry is admitted without provider recovery");
  assert.equal(h.events.some((event) => event.includes("provision")), false);
});

test("grant reconciliation follows daemon_inbox ownership instead of provider identity", async () => {
  const h = harness();
  const providerNeutralEntry = { ...entry(), provider: "claude-code" };
  h.grants.set("owner/supervised_launch_1234567", {
    metadata: metadata("owner/supervised_launch_1234567"),
    token: "secret_same",
    entryId: "supervised_launch_1234567",
    lastInstalledDaemonGeneration: 7,
  });
  const daemon = { ...h.daemon, async list() { h.events.push("list"); return [providerNeutralEntry]; } };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    h.operations,
    async () => "room_1",
  );
  await coordinator.reconcileDesiredRunning();
  assert.equal(h.events.includes("install:7"), true);
  assert.equal(h.events.some((event) => event.startsWith("bootstrap:")), true);
});

test("reconciliation admits a cursorless stopped entry without changing its lifecycle", async () => {
  const h = harness();
  const stopped = { ...entry(), desiredState: "stopped" as const, observedState: "stopped" as const, providerPid: null };
  h.grants.set("owner/supervised_launch_1234567", { metadata: metadata("owner/supervised_launch_1234567"), token: "secret_same", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 7 });
  const daemon = { ...h.daemon, async list() { h.events.push("list"); return [stopped]; } };
  const coordinator = new SupervisorGrantCoordinator(daemon as never, (async () => { throw new Error("unexpected request"); }) as never, () => "host_1", h.operations, async () => "room_1");
  await coordinator.reconcileDesiredRunning();
  assert.deepEqual(h.events.filter((event) => event.startsWith("install:") || event.startsWith("bootstrap:") || event.startsWith("create:")), [
    "install:7", "bootstrap:supervised_launch_1234567:7",
  ]);
  assert.equal(stopped.desiredState, "stopped", "cursor admission does not revive a stopped provider");
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

test("Reconnect refuses a paused entry with no current provider or worker binding", async () => {
  const h = harness();
  const unavailable = {
    ...entry(), desiredState: "paused" as const, observedState: "paused" as const,
    workAttemptId: null, agentSessionId: null, agentSessionBindingState: "none" as const,
    executionGenerationId: null, providerContinuationId: null, providerPid: null,
  };
  await assert.rejects(
    h.coordinator.reconnectEntry(unavailable),
    /no longer has a live runtime to reconnect/,
  );
  assert.equal(h.events.some((event) => event.startsWith("install:")), false);
  assert.equal(h.events.some((event) => event === "ensure"), false);
});

test("runtime recovery installs owner authority without activating or reconnecting the dead provider", async () => {
  const h = harness();
  h.grants.set("owner/supervised_launch_1234567", {
    metadata: metadata("owner/supervised_launch_1234567"),
    token: "secret_same",
    entryId: "supervised_launch_1234567",
    lastInstalledDaemonGeneration: 7,
  });
  const installs: Array<{
    credentialOnly?: boolean;
    recoveryOnly?: boolean;
  }> = [];
  const daemon = {
    ...h.daemon,
    async installHostGrant(input: {
      supervisorGrant: string;
      credentialOnly?: boolean;
      recoveryOnly?: boolean;
    }) {
      installs.push(input);
      return "installed" as const;
    },
    async bootstrapRoomIngress() {
      throw new Error("runtime recovery authority preparation must not bootstrap or converge");
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    h.operations,
    async () => "room_1",
  );

  await coordinator.prepareEntryForRuntimeRecovery({
    ...entry(),
    observedState: "failed",
    nativeLiveness: { state: "terminal", observedAt: "2026-07-29T00:00:00.000Z", detail: "stopped" },
  });

  assert.equal(installs.length, 1);
  assert.equal(installs[0]?.credentialOnly, false);
  assert.equal(installs[0]?.recoveryOnly, true);
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

test("room move rotates exact destination authority, acknowledges the source session, then installs", async () => {
  const h = harness();
  const key = "owner/supervised_launch_1234567";
  const moved = { ...entry(), roomId: "room_2" };
  h.grants.set(key, {
    metadata: metadata(key, "grant_source", "room_1"), token: "secret_source",
    entryId: moved.id, lastInstalledDaemonGeneration: 7,
  });
  const events: string[] = [];
  const daemon = {
    ...h.daemon,
    async list() { return [moved]; },
    async acknowledgeRoomMoveSourceRevocation(input: { sourceAgentSessionId: string }) {
      events.push(`ack:${input.sourceAgentSessionId}`);
      return {};
    },
    async installHostGrant(input: { roomId: string; supervisorGrant: string }) {
      events.push(`install:${input.roomId}:${input.supervisorGrant}`);
      return "installed" as const;
    },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    ...h.operations,
    async provision(input) {
      events.push(`provision:${input.roomScopes[0]?.canonicalRoomId}:${Boolean(input.forceReprovision)}:${input.sourceAgentSessionId ?? "none"}`);
      return {
        metadata: metadata(input.agentKey, "grant_destination", "room_2"),
        token: "secret_destination", entryId: input.entryId, lastInstalledDaemonGeneration: null,
      };
    },
    async replaceGrant(input) {
      events.push(`persist:${input.metadata.allowedRoomIds[0]}:${input.lastInstalledDaemonGeneration ?? "none"}`);
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never, (async () => { throw new Error("unexpected"); }) as never,
    () => "host_1", operations, async (room) => room,
  );
  await coordinator.prepareRoomMoveDestination({
    operationId: "move_1", requestId: "request_1", entryId: moved.id,
    sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 7,
    workAttemptId: "attempt_1", executionGenerationId: "execution_1",
    agentSessionId: "session_1", phase: "rotating_credentials",
    remoteRoomId: "room_2", destinationCursor: null, sourceCredentialsRevoked: false,
    error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.deepEqual(events.slice(0, 5), [
    "provision:room_2:true:session_1", "persist:room_2:none", "ack:session_1",
    "install:room_2:secret_destination", "persist:room_2:7",
  ]);
  assert.equal(events.some((event) => event.includes("secret_source")), false, "the source-scoped grant is never reinstalled against destination membership");
});

test("room-move destination handshake recovers a lost acknowledgement response after ownership-aware provisioning", async () => {
  const h = harness();
  const key = "owner/supervised_launch_1234567";
  const moved = { ...entry(), roomId: "room_2" };
  h.grants.set(key, {
    metadata: metadata(key, "grant_destination", "room_2"), token: "secret_destination",
    entryId: moved.id, lastInstalledDaemonGeneration: null,
  });
  let acknowledgements = 0;
  let installs = 0;
  let provisions = 0;
  let durablyAcknowledged = false;
  const daemon = {
    ...h.daemon,
    async list() { return [moved]; },
    async acknowledgeRoomMoveSourceRevocation() {
      acknowledgements += 1;
      if (!durablyAcknowledged) {
        durablyAcknowledged = true;
        throw new Error("lost acknowledgement response");
      }
      return {};
    },
    async getRoomMove() { return { sourceCredentialsRevoked: durablyAcknowledged }; },
    async installHostGrant() { installs += 1; return "installed" as const; },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    ...h.operations,
    async provision(input) {
      provisions += 1;
      assert.equal(input.sourceAgentSessionId, "session_1");
      return h.grants.get(key)!;
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never, (async () => { throw new Error("unexpected"); }) as never,
    () => "host_1", operations, async (room) => room,
  );
  const move = {
    operationId: "move_1", requestId: "request_1", entryId: moved.id,
    sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 7,
    workAttemptId: "attempt_1", executionGenerationId: "execution_1",
    agentSessionId: "session_1", phase: "rotating_credentials" as const,
    remoteRoomId: "room_2", destinationCursor: null, sourceCredentialsRevoked: false,
    error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  };
  await coordinator.prepareRoomMoveDestination(move);
  assert.equal(provisions, 1, "scope equality alone never bypasses the ownership-aware lifecycle");
  assert.equal(acknowledgements, 1);
  assert.equal(installs, 1);
});

test("room-move rollback force-restores a source-scoped grant before compensation", async () => {
  const h = harness();
  const key = "owner/supervised_launch_1234567";
  const source = entry();
  h.grants.set(key, {
    metadata: metadata(key, "grant_destination", "room_2"), token: "secret_destination",
    entryId: source.id, lastInstalledDaemonGeneration: null,
  });
  const events: string[] = [];
  const daemon = {
    ...h.daemon,
    async list() { return [source]; },
    async installHostGrant(input: { roomId: string; supervisorGrant: string }) {
      events.push(`install:${input.roomId}:${input.supervisorGrant}`);
      return "installed" as const;
    },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    ...h.operations,
    async provision(input) {
      events.push(`provision:${input.roomScopes[0]?.canonicalRoomId}:${Boolean(input.forceReprovision)}:${input.sourceAgentSessionId ?? "none"}`);
      return {
        metadata: metadata(input.agentKey, "grant_source_recovered", "room_1"),
        token: "secret_source_recovered", entryId: input.entryId, lastInstalledDaemonGeneration: null,
      };
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never, (async () => { throw new Error("unexpected"); }) as never,
    () => "host_1", operations, async (room) => room,
  );
  await coordinator.prepareRoomMoveSourceRollback({
    operationId: "move_1", requestId: "request_1", entryId: source.id,
    sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 7,
    workAttemptId: "attempt_1", executionGenerationId: "execution_1",
    agentSessionId: "session_1", phase: "rollback_required",
    remoteRoomId: "room_2", destinationCursor: null, sourceCredentialsRevoked: false,
    error: "destination provisioning failed", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(events[0], "provision:room_1:true:session_1");
  assert.equal(events.some((event) => event === "install:room_1:secret_source_recovered"), true);
  assert.equal(events.some((event) => event.includes("secret_destination")), false);
});

test("generation reconciliation recovers a pending move before ordinary grant scope repair", async () => {
  await withRegistry(async () => {
    const source = entry();
    const moved = { ...source, roomId: "room_2" };
    const agentKey = `owner/${source.id}`;
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: {
        ...metadata(agentKey, "grant_source_restart", "room_1"),
        installationId: desktopSupervisorGrantInstallationId("host_1", source.id),
      },
      token: "secret_source_restart",
      entryId: source.id,
      lastInstalledDaemonGeneration: 7,
    }, { storage: keychain });

    const lifecycle: string[] = [];
    let provisionSourceSession: string | undefined;
    let sourceCredentialsRevoked = false;
    let installedDestination = false;
    let movePhase: "rotating_credentials" | "active" = "rotating_credentials";
    const rotatingMove = () => ({
      operationId: "move_restart", requestId: "request_restart", entryId: source.id,
      sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 8,
      workAttemptId: "attempt_1", executionGenerationId: "execution_1",
      agentSessionId: "session_1", phase: movePhase,
      remoteRoomId: "room_2", destinationCursor: null, sourceCredentialsRevoked,
      error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const daemon = {
      async ensureRunning() {
        return { generation: 8, capabilities: { agentRoomMove: true } };
      },
      async list() { return [moved]; },
      async getCurrentRoomMove() { return movePhase === "active" ? null : rotatingMove(); },
      async acknowledgeRoomMoveSourceRevocation(input: { sourceAgentSessionId: string }) {
        assert.equal(input.sourceAgentSessionId, "session_1");
        lifecycle.push("ACK source");
        sourceCredentialsRevoked = true;
        return rotatingMove();
      },
      async installHostGrant(input: { roomId: string; grantId: string; supervisorGrant: string }) {
        lifecycle.push(`INSTALL ${input.roomId}`);
        assert.equal(input.roomId, "room_2");
        assert.equal(input.grantId, "grant_destination_restart");
        assert.equal(input.supervisorGrant, "secret_destination_restart");
        installedDestination = true;
        return "installed" as const;
      },
      async bootstrapRoomIngress() { return "bootstrapped" as const; },
      async commitRoomMove() {
        lifecycle.push("COMMIT move");
        assert.equal(sourceCredentialsRevoked, true, "daemon commit follows the exact source-session acknowledgement");
        assert.equal(installedDestination, true, "daemon commit follows destination grant install");
        movePhase = "active";
        return rotatingMove();
      },
    };
    const request = (async <T>(path: string, init?: { method?: string; body?: string }) => {
      if (path.includes("/worker-sessions/")) {
        lifecycle.push("END source");
        assert.equal(
          path,
          "/supervisor-host-grants/grant_source_restart/worker-sessions/session_1/end",
        );
        return { session_id: "session_1", ended_at: "2026-01-01T00:00:02.000Z" } as T;
      }
      if (init?.method === "DELETE") {
        lifecycle.push("DELETE source");
        assert.equal(path, "/supervisor-host-grants/grant_source_restart");
        return {} as T;
      }
      assert.equal(path, "/supervisor-host-grants");
      const body = JSON.parse(init?.body ?? "{}") as { allowed_room_ids: string[]; allowed_agent_keys: string[] };
      lifecycle.push(`POST ${body.allowed_room_ids[0]}`);
      assert.deepEqual(body.allowed_room_ids, ["room_2"]);
      assert.deepEqual(body.allowed_agent_keys, [agentKey]);
      return {
        grant_id: "grant_destination_restart",
        host_id: "host_1",
        installation_id: desktopSupervisorGrantInstallationId("host_1", source.id),
        allowed_room_ids: body.allowed_room_ids,
        allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1,
        expires_at: "2099-01-01T00:00:00.000Z",
        supervisor_grant: "secret_destination_restart",
      } as T;
    }) as never;
    const actualOperations = storageOperations();
    const operations: SupervisorGrantCoordinatorOperations = {
      ...actualOperations,
      async provision(input, options) {
        provisionSourceSession = input.sourceAgentSessionId;
        return actualOperations.provision(input, options);
      },
    };
    const coordinator = new SupervisorGrantCoordinator(
      daemon as never,
      request,
      () => "host_1",
      operations,
      async (room) => room,
    );

    await coordinator.reconcileDesiredRunning();

    assert.equal(provisionSourceSession, "session_1", "ordinary scope repair never bypasses the move journal");
    assert.deepEqual(lifecycle, [
      "END source",
      "DELETE source",
      "POST room_2",
      "ACK source",
      "INSTALL room_2",
      "COMMIT move",
    ]);
    assert.equal(movePhase, "active");
    const stored = await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain });
    assert.equal(stored?.metadata.grantId, "grant_destination_restart");
    assert.equal(stored?.lastInstalledDaemonGeneration, 8);
  });
});

test("destination-save followed by acknowledgement failure rolls back through grant-owned session receipts", async () => {
  await withRegistry(async (registryPath) => {
    const source = entry();
    const moved = { ...source, roomId: "room_2" };
    const agentKey = `owner/${source.id}`;
    const installationId = desktopSupervisorGrantInstallationId("host_1", source.id);
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: {
        ...metadata(agentKey, "grant_source", "room_1"),
        installationId,
      },
      token: "secret_source",
      entryId: source.id,
      lastInstalledDaemonGeneration: 7,
    }, { storage: keychain });

    const requests: string[] = [];
    let destinationCreates = 0;
    let sourceCreates = 0;
    const request = (async <T>(path: string, init?: { body?: string }) => {
      if (path.includes("/worker-sessions/")) {
        requests.push(`END ${path}`);
        assert.match(
          path,
          /^\/supervisor-host-grants\/grant_(?:source|source_recovered)\/worker-sessions\/session_1\/end$/,
          "only an installed source grant may own the reactivated exact session",
        );
        return { session_id: "session_1", ended_at: "2026-01-01T00:00:02.000Z" } as T;
      }
      if (path !== "/supervisor-host-grants") {
        requests.push(`DELETE ${path}`);
        return {} as T;
      }
      const body = JSON.parse(init?.body ?? "{}") as {
        host_id: string;
        installation_id: string;
        allowed_room_ids: string[];
        allowed_agent_keys: string[];
      };
      const roomId = body.allowed_room_ids[0]!;
      requests.push(`POST ${roomId}`);
      const suffix = roomId === "room_2"
        ? (destinationCreates++ === 0 ? "destination" : "destination_second")
        : (sourceCreates++ === 0 ? "source_recovered" : "source_recovered_second");
      return {
        grant_id: `grant_${suffix}`,
        host_id: body.host_id,
        installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids,
        allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1,
        expires_at: "2099-01-01T00:00:00.000Z",
        supervisor_grant: `secret_${suffix}`,
      } as T;
    }) as never;

    let manifestEntry = moved;
    let acknowledgements = 0;
    const installs: string[] = [];
    const daemon = {
      async ensureRunning() { return { generation: 7 }; },
      async list() { return [manifestEntry]; },
      async acknowledgeRoomMoveSourceRevocation() {
        acknowledgements += 1;
        throw new Error("daemon acknowledgement unavailable before commit");
      },
      async getRoomMove() { return { sourceCredentialsRevoked: false }; },
      async installHostGrant(input: { roomId: string; grantId: string; supervisorGrant: string }) {
        installs.push(`${input.roomId}:${input.grantId}:${input.supervisorGrant}`);
        return "installed" as const;
      },
      async bootstrapRoomIngress() { return "bootstrapped" as const; },
    };
    const coordinator = new SupervisorGrantCoordinator(
      daemon as never,
      request,
      () => "host_1",
      storageOperations(),
      async (room) => room,
    );
    const rotating = {
      operationId: "move_fault", requestId: "request_fault", entryId: source.id,
      sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 7,
      workAttemptId: "attempt_1", executionGenerationId: "execution_1",
      agentSessionId: "session_1", phase: "rotating_credentials" as const,
      remoteRoomId: "room_2", destinationCursor: null, sourceCredentialsRevoked: false,
      error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
    };
    await assert.rejects(
      coordinator.prepareRoomMoveDestination(rotating),
      /acknowledgement unavailable/,
    );
    assert.equal(acknowledgements, 1);
    assert.deepEqual(installs, [], "destination authority is durable but was never installed");
    assert.equal(
      (await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }))?.metadata.grantId,
      "grant_destination",
    );

    // Daemon compensation restores source membership but intentionally still
    // projects the old source session. The storage journal—not that stale
    // projection—decides which grant owned the session.
    manifestEntry = source;
    await coordinator.prepareRoomMoveSourceRollback({
      ...rotating,
      phase: "rollback_required",
      error: "destination acknowledgement failed",
    });
    assert.deepEqual(requests, [
      "END /supervisor-host-grants/grant_source/worker-sessions/session_1/end",
      "DELETE /supervisor-host-grants/grant_source",
      "POST room_2",
      "DELETE /supervisor-host-grants/grant_destination",
      "POST room_1",
    ]);
    assert.equal(
      requests.some((value) => value.includes("grant_destination/worker-sessions")),
      false,
      "the old source session is never presented to the destination grant",
    );
    assert.deepEqual(installs, ["room_1:grant_source_recovered:secret_source_recovered"]);
    assert.equal(
      (await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }))?.metadata.grantId,
      "grant_source_recovered",
    );

    // The API can reactivate the same durable session id when the recovered
    // source grant is installed. Its installed marker makes that current
    // grant the owner; a later move must END under source_recovered rather
    // than reusing the older grant_source receipt.
    await getOrProvisionDesktopSupervisorGrantForAgent({
      hostId: "host_1",
      entryId: source.id,
      agentKey,
      roomScopes: [{ requestedRoomId: "room_2", canonicalRoomId: "room_2" }],
      forceReprovision: true,
      sourceAgentSessionId: "session_1",
    }, { storage: keychain, apiFetch: request });
    assert.deepEqual(requests.slice(-3), [
      "END /supervisor-host-grants/grant_source_recovered/worker-sessions/session_1/end",
      "DELETE /supervisor-host-grants/grant_source_recovered",
      "POST room_2",
    ]);

    // A second uninstalled destination must point to its immediate lifecycle
    // predecessor rather than scanning the now-ambiguous historical receipts
    // for the reused durable session id.
    await getOrProvisionDesktopSupervisorGrantForAgent({
      hostId: "host_1",
      entryId: source.id,
      agentKey,
      roomScopes: [{ requestedRoomId: "room_1", canonicalRoomId: "room_1" }],
      forceReprovision: true,
      sourceAgentSessionId: "session_1",
    }, { storage: keychain, apiFetch: request });
    assert.deepEqual(requests.slice(-2), [
      "DELETE /supervisor-host-grants/grant_destination_second",
      "POST room_1",
    ]);

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      version: number;
      credentialRevocations: Record<string, {
        grantId: string;
        agentSessionId: string;
        sessionOwnerGrantId: string;
        sessionEndedAt: string | null;
        grantRevokedAt: string | null;
      }>;
    };
    assert.equal(registry.version, 7);
    assert.equal(registry.credentialRevocations.grant_source?.sessionOwnerGrantId, "grant_source");
    assert.equal(registry.credentialRevocations.grant_source?.agentSessionId, "session_1");
    assert.ok(registry.credentialRevocations.grant_source?.sessionEndedAt);
    assert.ok(registry.credentialRevocations.grant_source?.grantRevokedAt);
    assert.equal(registry.credentialRevocations.grant_destination?.sessionOwnerGrantId, "grant_source");
    assert.equal(registry.credentialRevocations.grant_destination?.agentSessionId, "session_1");
    assert.ok(registry.credentialRevocations.grant_destination?.grantRevokedAt);
    assert.equal(registry.credentialRevocations.grant_source_recovered?.sessionOwnerGrantId, "grant_source_recovered");
    assert.equal(registry.credentialRevocations.grant_destination_second?.sessionOwnerGrantId, "grant_source_recovered");
    assert.ok(registry.credentialRevocations.grant_destination_second?.grantRevokedAt);
  });
});

test("v4 destination grants remain revocation-unknown and cannot ACK a move across restart", async () => {
  await withRegistry(async (registryPath) => {
    const moved = { ...entry(), roomId: "room_2" };
    const agentKey = `owner/${moved.id}`;
    const legacyMetadata = {
      ...metadata(agentKey, "grant_legacy_destination", "room_2"),
      installationId: desktopSupervisorGrantInstallationId("host_1", moved.id),
    };
    await writeFile(registryPath, `${JSON.stringify({
      version: 4,
      grants: {
        [agentKey]: {
          ...legacyMetadata,
          agentKey,
          entryId: moved.id,
          lastInstalledDaemonGeneration: 7,
          encryptedToken: encryptSupervisorGrantForStorage("secret_legacy_destination", keychain),
        },
      },
      entryAgentKeys: { [moved.id]: agentKey },
      purgeRevocationReceipts: {},
    })}\n`, "utf8");

    let requests = 0;
    let acknowledgements = 0;
    const daemon = {
      async ensureRunning() { return { generation: 7 }; },
      async list() { return [moved]; },
      async acknowledgeRoomMoveSourceRevocation() { acknowledgements += 1; return {}; },
    };
    const move = {
      operationId: "move_legacy", requestId: "request_legacy", entryId: moved.id,
      sourceRoomId: "room_1", destinationRoomId: "room_2", daemonGeneration: 7,
      workAttemptId: "attempt_1", executionGenerationId: "execution_1",
      agentSessionId: "session_1", phase: "rotating_credentials" as const,
      remoteRoomId: "room_2", destinationCursor: null, sourceCredentialsRevoked: false,
      error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const request = (async () => {
      requests += 1;
      throw new Error("legacy move must fail before remote mutation");
    }) as never;
    for (let restart = 0; restart < 2; restart += 1) {
      const coordinator = new SupervisorGrantCoordinator(
        daemon as never,
        request,
        () => "host_1",
        storageOperations(),
        async (room) => room,
      );
      await assert.rejects(
        coordinator.prepareRoomMoveDestination(move),
        /predates exact session ownership tracking/,
      );
      assert.equal(
        (await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }))?.credentialLifecycle,
        "unknown",
      );
    }
    assert.equal(requests, 0);
    assert.equal(acknowledgements, 0, "scope equality alone never attests source revocation");
  });
});
