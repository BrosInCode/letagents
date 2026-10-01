import assert from "node:assert/strict";
import test from "node:test";

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRANT_RECONCILE_CONCURRENCY,
  GRANT_RECONCILE_SLOT_LEASE_MS,
  GRANT_RECONCILE_START_JITTER_MS,
  GRANT_RECONCILE_USER_RESERVED_SLOTS,
  SupervisorGrantCoordinator,
  type SupervisorGrantCoordinatorOperations,
} from "../main/supervisor-grant-coordinator.js";
import { PacedQueue } from "../../../../shared/paced-queue.mjs";
import {
  DesktopSecureStorageUnavailableError,
  desktopSupervisorGrantInstallationId,
  encryptSupervisorGrantForStorage,
  getDesktopSupervisorGrantStorageStatus,
  getOrProvisionDesktopSupervisorGrantForAgent,
  readDesktopSupervisorGrantAgentKeyForEntry,
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
  revokeDesktopSupervisorGrantForEntry,
  revokeDesktopSupervisorGrantForEntryWithoutWorkerSession,
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
    readRevocationAttestation: async () => null,
    replaceGrant: async (input) => replaceDesktopSupervisorGrantForAgent(input, { storage: keychain }),
    revokeEntry: async (entryId, agentSessionId, options) =>
      revokeDesktopSupervisorGrantForEntry(entryId, agentSessionId, { ...options, storage: keychain }),
    revokeEntryWithoutWorkerSession: async (entryId, options) =>
      revokeDesktopSupervisorGrantForEntryWithoutWorkerSession(entryId, { ...options, storage: keychain }),
  };
}

const metadata = (key: string, id = "grant_1", roomId = "room_1") => ({
  grantId: id, hostId: "host_1", installationId: "install_1", allowedRoomIds: [roomId],
  allowedAgentKeys: [key], generation: 1, expiresAt: "2099-01-01T00:00:00.000Z",
});
const authority = { ownerAccountId: "account_1", scopeKey: "owner" };

function entry(id = "supervised_launch_1234567"): DesktopSupervisorManifestEntry {
  return {
    id, roomId: "room_1", displayName: "Mutable label", provider: "codex", model: null, charter: "help",
    desiredState: "running", observedState: "working", condition: "none", lastError: null,
    permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "desktop", createdAt: "2026-01-01T00:00:00.000Z",
    workspacePath: null, workAttemptId: "attempt_1", agentSessionId: "session_1", agentSessionBindingState: "active",
    bindingUpdatedAt: "2026-01-01T00:00:00.000Z", executionGenerationId: "execution_1", providerContinuationId: "thread_1",
    providerPid: 4242, workplaceLiveness: { state: "reachable", observedAt: null, detail: null },
    nativeLiveness: { state: "active", observedAt: null, detail: null }, readyReachedAt: null, restartCount: 0,
    lastTerminal: null, activity: [], lastTurnControlSequence: 0, roomAgentState: null, deliveryReceipts: [], turnControl: null,
  };
}

function harness(overrides: Partial<SupervisorGrantCoordinatorOperations> = {}) {
  const events: string[] = [];
  const bootstrapMessages: Array<string | undefined> = [];
  const grants = new Map<string, { metadata: ReturnType<typeof metadata>; authority?: typeof authority | null; token: string; entryId: string; lastInstalledDaemonGeneration: number | null }>();
  const daemon = {
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { events.push("ensure"); return { generation: 7 }; },
    async create(input: { roomIdentifier: string; charter?: string }) { events.push(`create:${input.roomIdentifier}`); return { ...entry(), roomId: input.roomIdentifier, charter: input.charter ?? entry().charter, desiredState: "paused" as const }; },
    async list() { events.push("list"); return [entry()]; },
    async installHostGrant(input: { supervisorGrant: string; daemonGeneration: number }) {
      events.push(`install:${input.daemonGeneration}`);
      assert.equal(input.supervisorGrant.includes("secret"), true);
      return "installed" as const;
    },
    async bootstrapRoomIngress(entryId: string, daemonGeneration: number, initialMessage?: string) {
      events.push(`bootstrap:${entryId}:${daemonGeneration}`);
      bootstrapMessages.push(initialMessage);
      return "bootstrapped" as const;
    },
    async retireAgent(id: string, generation: number, sessionId: string | null = null, grantOnly = false) {
      events.push(`retire:${id}:${generation}:${sessionId ?? (grantOnly ? "grant" : "prepare")}`);
      return sessionId || grantOnly
        ? { outcome: "retired" as const }
        : { outcome: "revocation_required" as const, revocationKind: "worker_session" as const, agentSessionId: "session_1" };
    },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    async resolveIdentity(input) { events.push(`identity:${input.entryId}`); return `owner/${input.entryId}`; },
    async provision(input) {
      events.push(`provision:${input.entryId}:${Boolean(input.forceReprovision)}`);
      const result = { metadata: metadata(input.agentKey), authority, token: "secret_provisioned", entryId: input.entryId, lastInstalledDaemonGeneration: null };
      grants.set(input.agentKey, result);
      return result;
    },
    async readEntryAgentKey(id) { events.push(`read-key:${id}`); return `owner/${id}`; },
    async readGrant(key) {
      events.push(`read-grant:${key}`);
      const stored = grants.get(key);
      return stored ? { ...stored, authority: stored.authority ?? null } : null;
    },
    async readRevocationAttestation() { return null; },
    async replaceGrant(input) {
      events.push(`replace:${input.lastInstalledDaemonGeneration ?? "none"}`);
      grants.set(input.agentKey, { metadata: input.metadata, authority: input.authority ?? null, token: input.token, entryId: input.entryId!, lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null });
    },
    async revokeEntry(id, sessionId) { events.push(`revoke:${id}:${sessionId}`); },
    async revokeEntryWithoutWorkerSession(id) { events.push(`revoke-grant:${id}`); },
    ...overrides,
  };
  const request = (async () => { throw new Error("unexpected request"); }) as never;
  return { events, bootstrapMessages, grants, daemon, operations, coordinator: new SupervisorGrantCoordinator(daemon as never, request, () => "host_1", operations, async () => "room_1") };
}

test("fresh Codex launch provisions before paused claim, installs before activation can occur", async () => {
  const h = harness();
  const result = await h.coordinator.createPausedAndInstall({
    creationRequestId: "launch_1234567", roomIdentifier: "room_1", displayName: "Mutable label", providerId: "codex", charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo",
  });
  assert.equal(result.entry.desiredState, "paused");
  assert.deepEqual(h.events, [
    // Every creation reads the room's saved names before it claims one.
    "ensure", "list", "identity:supervised_launch_1234567", "provision:supervised_launch_1234567:false", "create:room_1", "ensure", "install:7", "bootstrap:supervised_launch_1234567:7", "replace:7",
  ]);
  assert.deepEqual(h.bootstrapMessages, ["help"], "fresh creation queues the saved text as its one-time initial message");
  assert.equal(JSON.stringify(result).includes("secret_provisioned"), false, "no bearer is in the public coordinator result");
});

test("fresh rental launch queues its accepted task once while recovery paths omit startup text", async () => {
  const h = harness();
  await h.coordinator.createRentalPausedAndInstall({
    creationRequestId: "rental_12345678",
    roomIdentifier: "room_1",
    displayName: "Rental agent",
    providerId: "cursor",
    charter: "complete the accepted rental task",
    model: null,
    permissionProfileId: "sandboxed_write",
    repoRootPath: "/tmp/repo",
    agentKey: "renter/rental-agent",
    preparedGrant: {
      metadata: metadata("renter/rental-agent"),
      authority: null,
      token: "secret_rental",
    },
  });
  assert.deepEqual(h.bootstrapMessages, ["complete the accepted rental task"], "the freshly created rental entry supplies its stored initial message");

  h.bootstrapMessages.length = 0;
  h.grants.set("owner/supervised_launch_1234567", {
    metadata: metadata("owner/supervised_launch_1234567"),
    token: "secret_recovery",
    entryId: "supervised_launch_1234567",
    lastInstalledDaemonGeneration: 7,
  });
  await h.coordinator.reconcileDesiredRunning();
  assert.deepEqual(h.bootstrapMessages, [undefined], "an existing agent bootstrap never replays its stored legacy charter");
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

test("a requested name another agent in the room answers to is replaced, and a replay keeps the saved name", async () => {
  const h = harness();
  const entries: DesktopSupervisorManifestEntry[] = [{
    ...entry("supervised_holder_1234567"),
    displayName: "FieldMeadow",
    roomId: "room_1",
  }];
  const identityNames: string[] = [];
  const coordinator = new SupervisorGrantCoordinator(
    {
      ...h.daemon,
      async list() { return [...entries]; },
      async create(input: { creationRequestId: string; roomIdentifier: string; displayName: string }) {
        const id = `supervised_${input.creationRequestId}`;
        const saved = entries.find((candidate) => candidate.id === id);
        if (saved) return saved;
        const created = {
          ...entry(id),
          displayName: input.displayName,
          roomId: input.roomIdentifier,
          desiredState: "paused" as const,
        };
        entries.push(created);
        return created;
      },
    } as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    {
      ...h.operations,
      async resolveIdentity(input) {
        identityNames.push(input.displayName ?? "");
        return `owner/${input.entryId}`;
      },
    },
    async () => "room_1",
  );
  const request = {
    creationRequestId: "newcomer_1234567",
    roomIdentifier: "room_1",
    // Another spelling of the held name is still the held name.
    displayName: "fieldmeadow",
    providerId: "codex" as const,
    charter: "help",
    model: null,
    permissionProfileId: null,
    repoRootPath: "/tmp/repo",
  };

  const created = await coordinator.createPausedAndInstall(request);
  assert.match(created.entry.displayName, /^[A-Za-z]+$/);
  assert.notEqual(created.entry.displayName.toLowerCase(), "fieldmeadow");
  assert.equal(identityNames.at(-1), created.entry.displayName,
    "the room identity is registered under the name that was saved");

  const replayed = await coordinator.createPausedAndInstall(request);
  assert.equal(replayed.entry.displayName, created.entry.displayName);
  assert.equal(entries.length, 2);
});

test("a room lookup that stalls or fails never holds up or fails the creation", async () => {
  for (const lookup of ["stalls", "fails"] as const) {
    const h = harness();
    let created: { displayName: string } | null = null;
    const coordinator = new SupervisorGrantCoordinator(
      {
        ...h.daemon,
        list: lookup === "stalls"
          ? () => new Promise<never>(() => undefined)
          : async () => { throw new Error("manifest.list timed out"); },
        async create(input: { creationRequestId: string; roomIdentifier: string; displayName: string }) {
          created = { displayName: input.displayName };
          return {
            ...entry(`supervised_${input.creationRequestId}`),
            displayName: input.displayName,
            roomId: input.roomIdentifier,
            desiredState: "paused" as const,
          };
        },
      } as never,
      (async () => { throw new Error("unexpected request"); }) as never,
      () => "host_1",
      h.operations,
      async () => "room_1",
      undefined,
      20,
    );
    const startedAt = Date.now();
    const result = await coordinator.createPausedAndInstall({
      creationRequestId: `lookup_${lookup}_1234567`,
      roomIdentifier: "room_1",
      displayName: "",
      providerId: "codex",
      charter: "help",
      model: null,
      permissionProfileId: null,
      repoRootPath: "/tmp/repo",
    });
    assert.ok(Date.now() - startedAt < 1_000, `a lookup that ${lookup} is abandoned promptly`);
    assert.ok(created, `creation proceeds when the lookup ${lookup}`);
    assert.match(result.entry.displayName, /^[A-Za-z]+$/);
    assert.doesNotMatch(result.entry.displayName, /supervised agent/i);
  }
});

test("the identity is registered again when the daemon saves a different name", async () => {
  const h = harness();
  const identityNames: string[] = [];
  const coordinator = new SupervisorGrantCoordinator(
    {
      ...h.daemon,
      async list() { return []; },
      // The daemon is the authority: it found the name taken by an agent
      // this lookup did not see, and saved another.
      async create(input: { creationRequestId: string; roomIdentifier: string }) {
        return {
          ...entry(`supervised_${input.creationRequestId}`),
          displayName: "CedarPeak",
          roomId: input.roomIdentifier,
          desiredState: "paused" as const,
        };
      },
    } as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    {
      ...h.operations,
      async resolveIdentity(input) {
        identityNames.push(input.displayName ?? "");
        if (identityNames.length > 1) throw new Error("account service unavailable");
        return `owner/${input.entryId}`;
      },
    },
    async () => "room_1",
  );

  const result = await coordinator.createPausedAndInstall({
    creationRequestId: "renamed_1234567",
    roomIdentifier: "room_1",
    displayName: "FieldMeadow",
    providerId: "codex",
    charter: "help",
    model: null,
    permissionProfileId: null,
    repoRootPath: "/tmp/repo",
  });

  assert.deepEqual(identityNames, ["FieldMeadow", "CedarPeak"]);
  assert.equal(result.entry.displayName, "CedarPeak", "a failed relabel never fails the launch");
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
    "ensure", "list", "identity:supervised_launch_1234567", "provision:supervised_launch_1234567:false",
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

test("custodial polling restores grants without starting inbox delivery; legacy polling stays untouched", async () => {
  for (const contract of [undefined, "custodial_polling_v1"] as const) {
    const h = harness();
    const agent = { ...entry(), deliveryMode: "mcp_polling" as const, pollingContract: contract };
    const key = `owner/${agent.id}`;
    h.grants.set(key, { metadata: metadata(key), token: "secret_same", entryId: agent.id, lastInstalledDaemonGeneration: 7 });
    h.daemon.list = async () => [agent];
    await h.coordinator.reconcileDesiredRunning();
    assert.equal(h.events.includes("install:7"), Boolean(contract));
    assert.deepEqual(h.bootstrapMessages, [], "grant recovery never starts the polling turn or daemon inbox");
    assert.equal(h.events.some((event) => /^(create|provision):/.test(event)), false);
  }
});

test("custodial polling reconnect and runtime recovery only reinstall exact authority", async () => {
  const h = harness();
  const agent = { ...entry(), deliveryMode: "mcp_polling" as const, pollingContract: "custodial_polling_v1" as const };
  const key = `owner/${agent.id}`;
  h.grants.set(key, { metadata: metadata(key), token: "secret_same", entryId: agent.id, lastInstalledDaemonGeneration: 7 });
  const modes: unknown[] = [];
  h.daemon.installHostGrant = async (input) => {
    modes.push(input);
    return "installed";
  };
  await h.coordinator.reconnectEntry(agent);
  await h.coordinator.prepareEntryForRuntimeRecovery(agent);
  assert.equal((modes[0] as { credentialOnly: boolean }).credentialOnly, true);
  assert.equal((modes[1] as { recoveryOnly: boolean }).recoveryOnly, true);
  assert.deepEqual(h.bootstrapMessages, []);
  assert.equal(h.events.some((event) => /^(create|provision):/.test(event)), false);
});

test("stopped custodial polling agents revoke authority instead of reinstalling it", async () => {
  const h = harness();
  const agent = { ...entry(), desiredState: "stopped" as const, deliveryMode: "mcp_polling" as const, pollingContract: "custodial_polling_v1" as const };
  h.daemon.list = async () => [agent];
  await h.coordinator.reconcileDesiredRunning();
  assert.equal(h.events.includes(`revoke:${agent.id}:session_1`), true);
  assert.equal(h.events.some((event) => event.startsWith("install:")), false);
  assert.deepEqual(h.bootstrapMessages, []);
});

test("custodial polling stays unactivated when secure grant storage is unavailable", async () => {
  const h = harness({ readGrant: async () => { throw new DesktopSecureStorageUnavailableError("storage unavailable"); } });
  const agent = { ...entry(), deliveryMode: "mcp_polling" as const, pollingContract: "custodial_polling_v1" as const };
  h.daemon.list = async () => [agent];
  await assert.rejects(h.coordinator.reconcileDesiredRunning(), /storage unavailable/);
  let activated = false;
  await assert.rejects(h.coordinator.activateEntry(agent, async () => { activated = true; }), /storage unavailable/);
  assert.equal(activated, false);
  assert.equal(h.events.some((event) => /^(install|create|provision):/.test(event)), false);
  assert.deepEqual(h.bootstrapMessages, []);
});

test("reconciliation skips a stopped entry whose local and remote retirement are durably complete", async () => {
  const h = harness({ readRevocationAttestation: async () => "exact" });
  const stopped = {
    ...entry(), desiredState: "stopped" as const, observedState: "stopped" as const,
    agentSessionId: null, agentSessionBindingState: "none" as const, providerPid: null,
  };
  let listCalls = 0;
  h.daemon.list = async () => { listCalls += 1; return [stopped]; };

  await h.coordinator.reconcileDesiredRunning();

  assert.equal(listCalls, 1, "durable completion avoids a per-entry global manifest read");
  assert.equal(h.events.some((event) => event.startsWith("retire:") || event.startsWith("revoke:")), false);
});

test("durable revocation does not skip a stopped entry with a retained active binding", async () => {
  const h = harness({ readRevocationAttestation: async () => "exact" });
  const stopped = { ...entry(), desiredState: "stopped" as const, observedState: "stopped" as const, providerPid: null };
  h.grants.set("owner/supervised_launch_1234567", { metadata: metadata("owner/supervised_launch_1234567"), token: "secret_same", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 7 });
  const daemon = { ...h.daemon, async list() { h.events.push("list"); return [stopped]; } };
  const coordinator = new SupervisorGrantCoordinator(daemon as never, (async () => { throw new Error("unexpected request"); }) as never, () => "host_1", h.operations, async () => "room_1");
  await coordinator.reconcileDesiredRunning();
  assert.deepEqual(h.events.filter((event) => event.startsWith("retire:") || event.startsWith("revoke:") || event.startsWith("install:") || event.startsWith("bootstrap:")), [
    "retire:supervised_launch_1234567:7:prepare",
    "revoke:supervised_launch_1234567:session_1",
    "retire:supervised_launch_1234567:7:session_1",
  ]);
  assert.equal(h.events.filter((event) => event === "list").length, 2, "incomplete retirement retains the fresh safety read");
  assert.equal(stopped.desiredState, "stopped", "retirement cleanup does not revive a stopped provider");
});

test("missing durable revocation keeps stopped binding-free entries on the recovery path", async () => {
  const h = harness({ readRevocationAttestation: async () => null });
  const stopped = {
    ...entry(), desiredState: "stopped" as const, observedState: "stopped" as const,
    agentSessionId: null, agentSessionBindingState: "none" as const, providerPid: null,
  };
  const daemon = { ...h.daemon, async list() { h.events.push("list"); return [stopped]; } };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    h.operations,
    async () => "room_1",
  );

  await coordinator.reconcileDesiredRunning();

  assert.equal(h.events.filter((event) => event === "list").length, 2, "missing remote proof retains the fresh safety read");
  assert.equal(h.events.some((event) => event.startsWith("retire:")), true);
});

test("completed stopped history performs one global list regardless of entry count", async () => {
  const h = harness({ readRevocationAttestation: async () => "none" });
  const stoppedEntries = Array.from({ length: 50 }, (_, index) => ({
    ...entry(`supervised_retired_${String(index).padStart(2, "0")}`),
    desiredState: "stopped" as const,
    observedState: "stopped" as const,
    agentSessionId: null,
    agentSessionBindingState: "none" as const,
    providerPid: null,
  }));
  let listCalls = 0;
  h.daemon.list = async () => { listCalls += 1; return stoppedEntries; };

  await h.coordinator.reconcileDesiredRunning();

  assert.equal(listCalls, 1);
  assert.equal(h.events.some((event) => event.startsWith("retire:") || event.startsWith("revoke:")), false);
});

test("a stale startup cleanup cannot retire an entry while resume commits fresh authority", async () => {
  const h = harness();
  const stopped = { ...entry(), desiredState: "stopped" as const, observedState: "stopped" as const, providerPid: null };
  let current: DesktopSupervisorManifestEntry = stopped;
  h.grants.set("owner/supervised_launch_1234567", {
    metadata: metadata("owner/supervised_launch_1234567"),
    token: "secret_same",
    entryId: stopped.id,
    lastInstalledDaemonGeneration: 7,
  });
  let releaseStartupList!: () => void;
  let signalStartupList!: () => void;
  const startupListEntered = new Promise<void>((resolve) => { signalStartupList = resolve; });
  const startupListReleased = new Promise<void>((resolve) => { releaseStartupList = resolve; });
  let releaseActivation!: () => void;
  let signalActivation!: () => void;
  const activationEntered = new Promise<void>((resolve) => { signalActivation = resolve; });
  const activationReleased = new Promise<void>((resolve) => { releaseActivation = resolve; });
  let revocationAttestation: "exact" | null = "exact";
  let listCalls = 0;
  let firstList = true;
  const daemon = {
    ...h.daemon,
    async list() {
      listCalls += 1;
      if (firstList) {
        firstList = false;
        signalStartupList();
        await startupListReleased;
        return [stopped];
      }
      return [current];
    },
    async retireAgent() {
      h.events.push("unexpected-retire");
      return { outcome: "retired" as const };
    },
  };
  const operations: SupervisorGrantCoordinatorOperations = {
    ...h.operations,
    async readRevocationAttestation() { return revocationAttestation; },
    async replaceGrant(input) {
      revocationAttestation = null;
      await h.operations.replaceGrant(input);
    },
  };
  const coordinator = new SupervisorGrantCoordinator(
    daemon as never,
    (async () => { throw new Error("unexpected request"); }) as never,
    () => "host_1",
    operations,
    async () => "room_1",
  );
  const startup = coordinator.reconcileDesiredRunning();
  await startupListEntered;
  const activation = coordinator.activateEntry(stopped, async () => {
    signalActivation();
    await activationReleased;
    current = { ...stopped, desiredState: "running", observedState: "starting" };
    return current;
  });
  await activationEntered;
  releaseStartupList();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseActivation();
  assert.equal((await activation).desiredState, "running");
  await startup;
  assert.equal(current.desiredState, "running");
  assert.equal(listCalls, 2, "receipt clearing forces the stale cleanup to re-read the resumed state");
  assert.equal(h.events.includes("unexpected-retire"), false);
});

test("retirement revokes a grant with no exact worker session before acknowledging local cleanup", async () => {
  const h = harness();
  const calls: string[] = [];
  const daemon = {
    ...h.daemon,
    async retireAgent(id: string, generation: number, _sessionId: string | null = null, grantOnly = false) {
      calls.push(`daemon:${id}:${generation}:${grantOnly}`);
      return grantOnly
        ? { outcome: "retired" as const }
        : { outcome: "revocation_required" as const, revocationKind: "grant_only" as const };
    },
  };
  const coordinator = new SupervisorGrantCoordinator(daemon as never, (async () => { throw new Error("unexpected request"); }) as never, () => "host_1", {
    ...h.operations,
    async revokeEntryWithoutWorkerSession(id) { calls.push(`revoke:${id}`); },
  }, async () => "room_1");
  await coordinator.retireEntry("supervised_launch_1234567", 7);
  assert.deepEqual(calls, [
    "daemon:supervised_launch_1234567:7:false",
    "revoke:supervised_launch_1234567",
    "daemon:supervised_launch_1234567:7:true",
  ]);
});

test("exact retirement remains idempotent when restart reconciliation later observes no session", async () => {
  await withRegistry(async () => {
    const entryId = "supervised_retire_restart_1234567";
    const agentKey = `owner/${entryId}`;
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: metadata(agentKey, "grant_retire_restart"),
      token: "secret_retire_restart",
      entryId,
    }, { storage: keychain });
    let exactRetired = false;
    const daemonCalls: string[] = [];
    const daemon = {
      async isMaintenanceHeld() { return false; },
      async list() { return [entry(entryId)]; },
      async retireAgent(_id: string, _generation: number, sessionId: string | null = null, grantOnly = false) {
        daemonCalls.push(sessionId ?? (grantOnly ? "grant" : "prepare"));
        if (!exactRetired) {
          if (sessionId === "session_retire_restart") {
            exactRetired = true;
            return { outcome: "retired" as const };
          }
          return {
            outcome: "revocation_required" as const,
            revocationKind: "worker_session" as const,
            agentSessionId: "session_retire_restart",
          };
        }
        return grantOnly
          ? { outcome: "retired" as const }
          : { outcome: "revocation_required" as const, revocationKind: "grant_only" as const };
      },
    };
    const requests: string[] = [];
    const coordinator = new SupervisorGrantCoordinator(
      daemon as never,
      (async <T>(requestPath: string) => {
        requests.push(requestPath);
        return (requestPath.endsWith("/end")
          ? { session_id: "session_retire_restart", ended_at: "2026-08-15T00:00:00.000Z" }
          : {}) as T;
      }) as never,
      () => "host_1",
      storageOperations(),
      async () => "room_1",
    );
    await coordinator.retireEntry(entryId, 7);
    await coordinator.retireEntry(entryId, 7);
    assert.deepEqual(daemonCalls, ["prepare", "session_retire_restart", "prepare", "grant"]);
    assert.deepEqual(requests, [
      "/supervisor-host-grants/grant_retire_restart/worker-sessions/session_retire_restart/end",
      "/supervisor-host-grants/grant_retire_restart",
    ]);
  });
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

test("Reconnect accepts an exact idle Cursor continuation without inventing a provider pid", async () => {
  const h = harness();
  h.grants.set("owner/supervised_launch_1234567", { metadata: metadata("owner/supervised_launch_1234567"), token: "secret_same", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 7 });
  const cursor = {
    ...entry(),
    provider: "cursor" as const,
    observedState: "idle" as const,
    providerPid: null,
    providerContinuationId: "cursor-session-1",
  };

  await h.coordinator.reconnectEntry(cursor);

  assert.equal(h.events.filter((event) => event === "install:7").length, 1);
  assert.equal(h.events.some((event) => event.startsWith("create:")), false);
  assert.equal(cursor.providerPid, null);
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
        metadata: metadata(input.agentKey), authority, token: "secret_repaired", entryId: input.entryId,
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
    async isMaintenanceHeld() { return false; },
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
    async isMaintenanceHeld() { return false; },
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

test("reconciliation observation retains failure without retrying and follows an existing credential wake", async (t) => {
  t.mock.method(console, "warn", () => {});
  let calls = 0;
  let failed = true;
  const failure = new Error("grant unavailable");
  const c = new SupervisorGrantCoordinator({
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { return { generation: 7 }; },
    async list() { calls++; if (failed) throw failure; return []; },
  } as never);
  assert.equal(c.getReconciliationObservation(), null);
  const operation = c.reconcileDesiredRunning();
  const pending = c.getReconciliationObservation()!;
  assert.equal(pending.status, "pending");
  await assert.rejects(operation, failure);
  for (let i = 0; i < 3; i++) {
    const observation = c.getReconciliationObservation()!;
    assert.equal(observation.attempt, pending.attempt);
    assert.equal(observation.status, "failed");
    assert.equal(observation.error, failure);
  }
  assert.equal(calls, 1);
  failed = false;
  c.scheduleCredentialRecovery();
  const recovery = c.getReconciliationObservation()!;
  assert.notEqual(recovery.attempt, pending.attempt);
  await recovery.attempt;
  assert.equal(c.getReconciliationObservation()?.status, "succeeded");
  assert.equal(calls, 2);
});

test("reconciliation observation invalidates prior success while a credential follow-up is only queued", async (t) => {
  t.mock.method(console, "warn", () => {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const c = new SupervisorGrantCoordinator({
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { return { generation: 7 }; },
    async list() { await held; return []; },
  } as never);
  const running = c.reconcileDesiredRunning();
  const first = c.getReconciliationObservation()!;
  c.scheduleCredentialRecovery();
  assert.equal(c.getReconciliationObservation()?.current, false);
  const atSettlement = first.attempt.then(() => c.getReconciliationObservation()!);
  release();
  const gap = await atSettlement;
  assert.equal(gap.attempt, first.attempt, "the observation runs before the queued follow-up starts");
  assert.equal(gap.status, "succeeded");
  assert.equal(gap.current, false, "an already recorded wake invalidates old success");
  await running;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.notEqual(c.getReconciliationObservation()?.attempt, first.attempt);
  assert.equal(c.getReconciliationObservation()?.current, true);
});

test("reconciliation observation recognizes a generation wake already covered by the successful attempt", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const c = new SupervisorGrantCoordinator({
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { calls++; await held; return { generation: 7 }; },
    async list() { return []; },
  } as never);
  const running = c.reconcileDesiredRunning();
  const first = c.getReconciliationObservation()!;
  c.scheduleReconciliation({ generation: 7 });
  assert.equal(c.getReconciliationObservation()?.current, false);
  release();
  await running;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "the owner deliberately suppresses the redundant follow-up");
  assert.equal(c.getReconciliationObservation()?.attempt, first.attempt);
  assert.equal(c.getReconciliationObservation()?.status, "succeeded");
  assert.equal(c.getReconciliationObservation()?.current, true);
});

test("a successful login retries the exact grant after same-generation credential failure", async (t) => {
  t.mock.method(console, "warn", () => {});
  let authenticated = false;
  const key = "owner/supervised_launch_1234567";
  const stored = { metadata: metadata(key), authority, token: "secret_same", entryId: entry().id, lastInstalledDaemonGeneration: 7 };
  const h = harness({
    readGrant: async () => {
      if (!authenticated) throw new Error("owner auth unavailable");
      return stored;
    },
  });
  h.coordinator.scheduleReconciliation({ generation: 7 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.events.includes("install:7"), false);
  authenticated = true;
  h.coordinator.scheduleCredentialRecovery();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.events.filter((event) => event.startsWith("install:")), ["install:7"]);
  assert.deepEqual(h.bootstrapMessages, [undefined], "recovery cannot replay the initial message");
  assert.equal(h.events.some((event) => event.startsWith("create:")), false);
  assert.equal(h.grants.get(key)?.lastInstalledDaemonGeneration, 7);
});

test("credential recovery during an in-flight pass retains one follow-up even if that pass fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const firstFails of [true, false]) {
    let lists = 0;
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const c = new SupervisorGrantCoordinator({
      async isMaintenanceHeld() { return false; },
      async ensureRunning() { return { generation: 7 }; },
      async list() {
        lists += 1;
        if (lists === 1) {
          signalFirst();
          await firstReleased;
          if (firstFails) throw new Error("owner auth was unavailable");
        }
        return [];
      },
    } as never);
    c.scheduleReconciliation({ generation: 7 });
    await firstStarted;
    c.scheduleCredentialRecovery();
    c.scheduleCredentialRecovery();
    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(lists, 2, `one follow-up after a ${firstFails ? "failed" : "successful"} pass`);
  }
});

test("secure storage recovery wakes once after a startup failure even before a renderer probe", async (t) => {
  t.mock.method(console, "warn", () => {});
  let available = false;
  const key = "owner/supervised_launch_1234567";
  const h = harness({
    readGrant: async () => {
      if (!available) throw new DesktopSecureStorageUnavailableError("storage unavailable");
      return { metadata: metadata(key), authority, token: "secret_same", entryId: entry().id, lastInstalledDaemonGeneration: 7 };
    },
  });
  await assert.rejects(h.coordinator.reconcileDesiredRunning(), DesktopSecureStorageUnavailableError);
  available = true;
  h.coordinator.observeSecureStorageAvailability(true);
  h.coordinator.observeSecureStorageAvailability(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.events.filter((event) => event.startsWith("install:")), ["install:7"]);
  h.coordinator.observeSecureStorageAvailability(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.events.filter((event) => event === "ensure").length, 2);
});

test("successful native probes cannot repeatedly retry a credential-specific encryption failure", async (t) => {
  t.mock.method(console, "warn", () => {});
  const storage = {
    ...keychain,
    encryptString(value: string) {
      if (value.startsWith("letagents-secure-storage-probe:")) return keychain.encryptString(value);
      throw new Error("credential encryption unavailable");
    },
  };
  const key = "owner/supervised_launch_1234567";
  const h = harness({
    readGrant: async () => ({ metadata: metadata(key), authority, token: "secret_same", entryId: entry().id, lastInstalledDaemonGeneration: 7 }),
    replaceGrant: async (input) => { encryptSupervisorGrantForStorage(input.token, storage); },
  });
  const probe = () => {
    const status = getDesktopSupervisorGrantStorageStatus(storage);
    assert.equal(status.available, true);
    h.coordinator.observeSecureStorageAvailability(status.available);
  };
  await assert.rejects(h.coordinator.reconcileDesiredRunning(), DesktopSecureStorageUnavailableError);
  probe();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.events.filter((event) => event === "install:7").length, 2, "the first available probe still retries a startup storage failure");
  for (let check = 0; check < 3; check += 1) {
    probe();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(h.events.filter((event) => event === "install:7").length, 2, "unchanged available probes do not retry repeated typed write failures");
  h.coordinator.observeSecureStorageAvailability(false);
  probe();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.events.filter((event) => event === "install:7").length, 3, "an actual unavailable-to-available observation allows another recovery");
  h.coordinator.scheduleCredentialRecovery();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.events.filter((event) => event === "install:7").length, 4, "successful login remains an independent recovery wake");
});

test("storage probes do not start recovery without a transition or loop after another failure", async (t) => {
  t.mock.method(console, "warn", () => {});
  let lists = 0;
  let generation = 7;
  const c = new SupervisorGrantCoordinator({
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { return { generation }; },
    async list() { lists += 1; throw new Error("owner auth still unavailable"); },
  } as never);
  for (const available of [true, true, false, false]) c.observeSecureStorageAvailability(available);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lists, 0);
  c.observeSecureStorageAvailability(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  c.observeSecureStorageAvailability(true);
  c.scheduleReconciliation({ generation: 7 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lists, 1, "unchanged probes and the same generation cannot retry the failed recovery");
  generation = 8;
  c.scheduleReconciliation({ generation: 8 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lists, 2, "a genuinely new daemon generation remains a recovery trigger");
});

test("a stale installation after credential recovery never advances the durable installation marker", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = harness();
  const key = "owner/supervised_launch_1234567";
  const stored = { metadata: metadata(key), authority, token: "secret_same", entryId: entry().id, lastInstalledDaemonGeneration: 7 };
  const c = new SupervisorGrantCoordinator({
    ...h.daemon,
    async installHostGrant() { h.events.push("install:stale"); return "stale"; },
  } as never, (async () => { throw new Error("unexpected request"); }) as never, () => "host_1", {
    ...h.operations,
    readGrant: async () => stored,
  });
  c.scheduleCredentialRecovery();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.events.filter((event) => event.startsWith("install:")), ["install:stale"]);
  assert.equal(h.events.some((event) => event.startsWith("replace:") || event.startsWith("bootstrap:")), false);
  await assert.rejects(c.reconcileDesiredRunning(), /changed generation/);
});

test("a generation change during reconciliation schedules exactly one follow-up", async () => {
  let generation = 7;
  let lists = 0;
  let releaseFirst!: () => void;
  let signalFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const daemon = {
    async isMaintenanceHeld() { return false; },
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
    owner_account_id: authority.ownerAccountId, scope_key: authority.scopeKey,
  })) as never;
  const replacementHarness = harness();
  replacementHarness.grants.set(key, { metadata: metadata(key), token: "secret_old", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 6 });
  const c = new SupervisorGrantCoordinator(replacementHarness.daemon as never, request, () => "host_1", {
    resolveIdentity: async () => key, provision: async () => { throw new Error("must not reprovision"); },
    readEntryAgentKey: async () => key,
    readGrant: async () => ({ ...replacementHarness.grants.get(key)!, authority: replacementHarness.grants.get(key)?.authority ?? null }),
    readRevocationAttestation: async () => null,
    replaceGrant: async (input) => {
      replacementHarness.events.push(`replace:${input.lastInstalledDaemonGeneration ?? "none"}`);
      replacementHarness.grants.set(key, {
        metadata: input.metadata,
        authority: input.authority ?? null,
        token: input.token,
        entryId: input.entryId!,
        lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null,
      });
    },
    revokeEntry: async () => { throw new Error("no stopped entries expected"); },
    revokeEntryWithoutWorkerSession: async () => { throw new Error("no stopped entries expected"); },
  }, async () => "room_1");
  await c.reconcileDesiredRunning();
  assert.deepEqual(replacementHarness.events.filter((event) => event.startsWith("replace") || event.startsWith("install")), ["replace:none", "install:7", "replace:7"]);
});

/**
 * A startup sweep of running agents whose saved grants belong to an older
 * daemon generation, so each one first rotates its grant on the server. The
 * fake server holds every handoff request until the test answers it.
 */
function pacedSweepHarness(runningCount: number, stoppedCount = 0) {
  const h = harness();
  const running = Array.from({ length: runningCount }, (_, index) => entry(`supervised_paced_run_${String(index).padStart(2, "0")}`));
  const stopped = Array.from({ length: stoppedCount }, (_, index) => ({
    ...entry(`supervised_paced_stop_${String(index).padStart(2, "0")}`),
    desiredState: "stopped" as const, observedState: "stopped" as const, providerPid: null,
  }));
  for (const candidate of [...running, ...stopped]) {
    const key = `owner/${candidate.id}`;
    h.grants.set(key, { metadata: metadata(key, `grant_${candidate.id}`), authority, token: "secret_old", entryId: candidate.id, lastInstalledDaemonGeneration: 6 });
  }
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  let inFlight = 0;
  let maxInFlight = 0;
  const request = (async (path: string) => {
    const grantId = decodeURIComponent(path.split("/")[2]!);
    const entryId = grantId.slice("grant_".length);
    started.push(entryId);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => pending.set(entryId, resolve));
    inFlight -= 1;
    return {
      grant_id: grantId, host_id: "host_1", installation_id: "install_1", allowed_room_ids: ["room_1"],
      allowed_agent_keys: [`owner/${entryId}`], current_generation: 2, expires_at: "2099-01-01T00:00:00.000Z",
      supervisor_grant: "secret_successor", owner_account_id: authority.ownerAccountId, scope_key: authority.scopeKey,
    };
  }) as never;
  const settle = async () => { for (let turn = 0; turn < 30; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const until = async (condition: () => boolean, label: string) => {
    for (let wait = 0; wait < 200 && !condition(); wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), label);
  };
  /** Answer held server requests one at a time until `work` settles. */
  const drain = async (work: Promise<unknown>) => {
    let done = false;
    void work.then(() => { done = true; }, () => { done = true; });
    for (let turn = 0; turn < 2_000 && !done; turn += 1) {
      const next = pending.keys().next();
      if (!next.done) { pending.get(next.value)!(); pending.delete(next.value); }
      await new Promise((resolve) => setTimeout(resolve, next.done ? 5 : 0));
    }
    await work;
  };
  return {
    ...h, running, stopped, started, pending, request, settle, until, drain,
    get maxInFlight() { return maxInFlight; },
  };
}

/** Reconciliation slots the startup sweep may use; the rest wait for a user's action. */
const SWEEP_SLOTS = GRANT_RECONCILE_CONCURRENCY - GRANT_RECONCILE_USER_RESERVED_SLOTS;

test("the startup sweep reconciles at most three agents at once, and a queued agent sends nothing until admitted", async () => {
  const sweep = pacedSweepHarness(10);
  sweep.daemon.list = async () => sweep.running;
  const coordinator = new SupervisorGrantCoordinator(sweep.daemon as never, sweep.request, () => "host_1", sweep.operations, async () => "room_1");

  const reconciliation = coordinator.reconcileDesiredRunning();
  await sweep.until(() => sweep.started.length === SWEEP_SLOTS, "the first agents start at once");
  await sweep.settle();
  assert.equal(sweep.started.length, SWEEP_SLOTS,
    "queued agents have sent no server request, so none of their request timeouts is running");
  assert.equal(sweep.events.filter((event) => event.startsWith("read-key:")).length, SWEEP_SLOTS,
    "a queued agent has not even started its reconciliation");
  await sweep.drain(reconciliation);
  assert.equal(GRANT_RECONCILE_CONCURRENCY, 4);
  assert.equal(GRANT_RECONCILE_USER_RESERVED_SLOTS, 1);
  assert.equal(sweep.maxInFlight, SWEEP_SLOTS, "the sweep leaves the reserved slot to the user");
  assert.deepEqual([...sweep.started].sort(), sweep.running.map((candidate) => candidate.id));
  assert.equal(sweep.events.filter((event) => event === "install:7").length, sweep.running.length);
});

test("one failed agent still lets every other queued agent get its grant, and the sweep reports the failure", async () => {
  for (const failingCount of [1, 2]) {
    const sweep = pacedSweepHarness(SWEEP_SLOTS + 4);
    sweep.daemon.list = async () => sweep.running;
    const failing = new Set(sweep.running.slice(0, failingCount).map((candidate) => candidate.id));
    const failure = (id: string) => new Error(`grant storage rejected ${id}`);
    const operations: SupervisorGrantCoordinatorOperations = {
      ...sweep.operations,
      async readEntryAgentKey(id) {
        if (failing.has(id)) throw failure(id);
        return sweep.operations.readEntryAgentKey(id);
      },
    };
    const coordinator = new SupervisorGrantCoordinator(sweep.daemon as never, sweep.request, () => "host_1", operations, async () => "room_1");

    const reconciliation = coordinator.reconcileDesiredRunning().then(() => "succeeded", (error: unknown) => error);
    await sweep.drain(reconciliation);
    const outcome = await reconciliation;
    const healthy = sweep.running.filter((candidate) => !failing.has(candidate.id));
    assert.deepEqual([...sweep.started].sort(), healthy.map((candidate) => candidate.id),
      `${failingCount}: every other agent, queued ones included, rotated its grant`);
    assert.equal(sweep.events.filter((event) => event === "install:7").length, healthy.length, String(failingCount));
    if (failingCount === 1) {
      assert.ok(outcome instanceof Error && outcome.message === `grant storage rejected ${sweep.running[0]!.id}`,
        "a single failure is reported as itself");
    } else {
      assert.ok(outcome instanceof AggregateError, "several failures are reported together");
      assert.equal(outcome.errors.length, failingCount);
      assert.match(outcome.message, /2 saved agents could not get their room authority back/);
    }
    assert.equal(coordinator.getReconciliationObservation()?.status, "failed", "the failure is still observed");
  }
});

test("a newer daemon generation drops the queued remainder of the old sweep", async () => {
  const sweep = pacedSweepHarness(SWEEP_SLOTS + 3);
  sweep.daemon.list = async () => sweep.running;
  const [, finishing, , paused, ...queued] = sweep.running as DesktopSupervisorManifestEntry[];
  const pauses: Array<() => void> = [];
  const queue = new PacedQueue({
    capacity: GRANT_RECONCILE_CONCURRENCY, reservedForUrgent: GRANT_RECONCILE_USER_RESERVED_SLOTS,
    leaseMs: GRANT_RECONCILE_SLOT_LEASE_MS, startJitterMs: GRANT_RECONCILE_START_JITTER_MS, random: () => 0.5,
    setTimeout: ((callback: () => void, delay: number) => {
      if (delay < 1_000) { pauses.push(callback); return { unref() {} }; }
      const timer = setTimeout(callback, delay);
      timer.unref();
      return timer;
    }) as unknown as typeof setTimeout,
  });
  const coordinator = new SupervisorGrantCoordinator(sweep.daemon as never, sweep.request, () => "host_1", sweep.operations,
    async () => "room_1", undefined, undefined, queue);

  const reconciliation = coordinator.reconcileDesiredRunning().then(() => "settled", (error: unknown) => error);
  await sweep.until(() => sweep.started.length === SWEEP_SLOTS, "the old sweep fills its slots");
  sweep.pending.get(finishing!.id)!();
  sweep.pending.delete(finishing!.id);
  await sweep.until(() => pauses.length === 1, "the next agent is admitted and waits out its start pause");
  // The successor daemon has nothing left for this desktop to restore.
  sweep.daemon.ensureRunning = async () => ({ generation: 8 });
  sweep.daemon.list = async () => [];
  coordinator.scheduleReconciliation({ generation: 8 });
  pauses.shift()!();
  await sweep.drain(reconciliation);
  assert.equal(await reconciliation, "settled", "a superseded pass reports nothing; its successor owns the outcome");
  const readKeys = sweep.events.filter((event) => event.startsWith("read-key:"));
  assert.equal(readKeys.includes(`read-key:${paused!.id}`), false, "admitted before the new generation, but never started");
  for (const candidate of queued) assert.equal(readKeys.includes(`read-key:${candidate.id}`), false, candidate.id);
  assert.equal(sweep.started.length, SWEEP_SLOTS, "no grant rotation started for the replaced daemon");
});

test("Reconnect, Restart and new agents go ahead of the startup sweep, and running agents ahead of stopped history", async () => {
  const sweep = pacedSweepHarness(7, 2);
  const [first, second, third, fourth, ...queuedRunning] = sweep.running;
  const [r4, r5, r6] = queuedRunning as [DesktopSupervisorManifestEntry, DesktopSupervisorManifestEntry, DesktopSupervisorManifestEntry];
  // Stopped history is listed first; ranking, not list order, decides who waits.
  sweep.daemon.list = async () => [first!, second!, third!, fourth!, ...sweep.stopped, ...queuedRunning];
  const order: string[] = [];
  const operations: SupervisorGrantCoordinatorOperations = {
    ...sweep.operations,
    async readEntryAgentKey(id) { order.push(id); return sweep.operations.readEntryAgentKey(id); },
    async readRevocationAttestation(id) { order.push(id); return null; },
    async resolveIdentity(input) { order.push(input.entryId); return sweep.operations.resolveIdentity(input); },
  };
  const queue = new PacedQueue({
    capacity: GRANT_RECONCILE_CONCURRENCY, reservedForUrgent: GRANT_RECONCILE_USER_RESERVED_SLOTS, leaseMs: GRANT_RECONCILE_SLOT_LEASE_MS,
    startJitterMs: GRANT_RECONCILE_START_JITTER_MS, random: () => 0,
  });
  const coordinator = new SupervisorGrantCoordinator(sweep.daemon as never, sweep.request, () => "host_1", operations,
    async () => "room_1", undefined, undefined, queue);

  const reconciliation = coordinator.reconcileDesiredRunning();
  await sweep.until(() => sweep.started.length === SWEEP_SLOTS, "the sweep fills every slot it may use");
  await sweep.settle();
  const reconnect = coordinator.reconnectEntry(r6);
  await sweep.until(() => sweep.started.includes(r6.id), "Reconnect takes the reserved slot at once");
  const restart = coordinator.prepareEntryForRuntimeRecovery(r4);
  await sweep.settle();
  const created = coordinator.createPausedAndInstall({
    creationRequestId: "launch_new_agent_1", roomIdentifier: "room_1", displayName: "New agent", providerId: "codex",
    charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo",
  });
  await sweep.settle();
  assert.deepEqual(queue.snapshot().queued, [
    r4.id, "supervised_launch_new_agent_1", // the user's Restart and new agent, behind the full cap
    fourth!.id, r4.id, r5.id, r6.id, // queued running agents (their sweep pass is an idempotent reinstall)
    ...sweep.stopped.map((candidate) => candidate.id),
  ]);

  await sweep.drain(Promise.all([reconciliation, reconnect, restart, created]));
  assert.deepEqual(order.slice(SWEEP_SLOTS, SWEEP_SLOTS + 3),
    [r6.id, r4.id, "supervised_launch_new_agent_1"],
    "the user's Reconnect, Restart and new agent start before any queued sweep work");
  const firstStarts = sweep.running.map((candidate) => order.indexOf(candidate.id));
  const stoppedStarts = sweep.stopped.map((candidate) => order.indexOf(candidate.id));
  assert.ok(Math.min(...stoppedStarts) > Math.max(...firstStarts),
    `stopped history waits for every running agent: ${order.join(", ")}`);
});

test("daemon successor preserves delegation-ineligible rental provenance", async () => {
  const h = harness();
  const key = "renter/rental-agent";
  let stored: {
    metadata: ReturnType<typeof metadata>;
    authority: typeof authority | null;
    token: string;
    entryId: string;
    lastInstalledDaemonGeneration: number | null;
  } = {
    metadata: metadata(key, "grant_rental"), authority: null, token: "secret_rental",
    entryId: entry().id, lastInstalledDaemonGeneration: 6,
  };
  const installs: Array<{ ownerAccountId: string | null; scopeKey: string | null }> = [];
  const request = (async () => ({
    grant_id: "grant_rental_successor", host_id: "host_1", installation_id: "install_1",
    allowed_room_ids: ["room_1"], allowed_agent_keys: [key], current_generation: 2,
    expires_at: "2099-01-01T00:00:00.000Z", supervisor_grant: "secret_rental_successor",
    owner_account_id: authority.ownerAccountId, scope_key: authority.scopeKey,
  })) as never;
  const coordinator = new SupervisorGrantCoordinator({
    ...h.daemon,
    async installHostGrant(input: { ownerAccountId: string | null; scopeKey: string | null }) {
      installs.push(input);
      return "installed" as const;
    },
  } as never, request, () => "host_1", {
    ...h.operations,
    readEntryAgentKey: async () => key,
    readGrant: async () => stored,
    provision: async () => { throw new Error("must hand off the rental grant"); },
    replaceGrant: async (input) => {
      stored = {
        metadata: input.metadata,
        authority: input.authority ?? null,
        token: input.token,
        entryId: input.entryId!,
        lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null,
      };
    },
  }, async () => "room_1");

  await coordinator.reconcileDesiredRunning();

  assert.equal(stored.authority, null, "handoff cannot make an unproven rental grant delegation-eligible");
  assert.deepEqual(
    installs.map(({ ownerAccountId, scopeKey }) => ({ ownerAccountId, scopeKey })),
    [{ ownerAccountId: null, scopeKey: null }],
  );
});

test("failed rental handoff never enters owner-authenticated reprovision", async () => {
  const h = harness();
  const key = "renter/rental-agent";
  const stored = {
    metadata: metadata(key, "grant_rental"), authority: null, token: "secret_rental",
    entryId: entry().id, lastInstalledDaemonGeneration: 6,
  };
  let provisionCalls = 0;
  const coordinator = new SupervisorGrantCoordinator(
    h.daemon as never,
    (async () => { throw new Error("rental handoff unavailable"); }) as never,
    () => "host_1",
    {
      ...h.operations,
      readEntryAgentKey: async () => key,
      readGrant: async () => stored,
      provision: async () => {
        provisionCalls += 1;
        throw new Error("rental grant must not use owner reprovision");
      },
    },
    async () => "room_1",
  );

  await assert.rejects(coordinator.reconcileDesiredRunning(), /rental handoff unavailable/);
  assert.equal(provisionCalls, 0);
  assert.equal(stored.authority, null);
});

test("host identity drift cannot replace the saved grant during fallback", async () => {
  const h = harness();
  const key = "owner/supervised_launch_1234567";
  const stored = {
    metadata: { ...metadata(key), hostId: "host_previous" }, authority, token: "secret_previous",
    entryId: entry().id, lastInstalledDaemonGeneration: 6,
  };
  let provisionCalls = 0;
  const coordinator = new SupervisorGrantCoordinator(
    h.daemon as never,
    (async () => { throw new Error("handoff unavailable"); }) as never,
    () => "host_1",
    {
      ...h.operations,
      readEntryAgentKey: async () => key,
      readGrant: async () => stored,
      provision: async () => {
        provisionCalls += 1;
        throw new Error("must not provision for another host identity");
      },
    },
    async () => "room_1",
  );

  await assert.rejects(coordinator.reconcileDesiredRunning(), /does not match this desktop host installation/);
  assert.equal(provisionCalls, 0);
  assert.equal(stored.metadata.hostId, "host_previous");
  assert.deepEqual(stored.authority, authority);
});

test("stale or revoked handoff safely owner-reprovisions, and two entries stay independent", async () => {
  const h = harness({
    readEntryAgentKey: async (id) => `owner/${id}`,
    readGrant: async () => ({ metadata: metadata("owner/key"), authority, token: "secret_stale", entryId: "supervised_launch_1234567", lastInstalledDaemonGeneration: 1 }),
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
    readGrant: async (key) => grants.get(key) ?? null, readRevocationAttestation: async () => null,
    replaceGrant: async () => {},
    revokeEntry: async () => { throw new Error("no stopped entries expected"); },
    revokeEntryWithoutWorkerSession: async () => { throw new Error("no stopped entries expected"); },
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
        authority,
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
      return { ...h.grants.get(key)!, authority: h.grants.get(key)?.authority ?? null };
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
        authority,
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
      async isMaintenanceHeld() { return false; },
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
        owner_account_id: authority.ownerAccountId,
        scope_key: authority.scopeKey,
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
        owner_account_id: authority.ownerAccountId,
        scope_key: authority.scopeKey,
      } as T;
    }) as never;

    let manifestEntry = moved;
    let acknowledgements = 0;
    const installs: string[] = [];
    const daemon = {
      async isMaintenanceHeld() { return false; },
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
      async isMaintenanceHeld() { return false; },
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


test("maintenance rejects grant creation, activation, recovery and reconnect before hosted effects", async () => {
  const h = harness(); h.daemon.isMaintenanceHeld = async () => true;
  await assert.rejects(h.coordinator.createPausedAndInstall({ creationRequestId: "launch_1234567", roomIdentifier: "room_1", displayName: "Test", providerId: "codex", charter: "help", model: null, permissionProfileId: null, repoRootPath: "/tmp/repo" }), /maintenance/);
  await assert.rejects(h.coordinator.activateEntry(entry(), async () => assert.fail("activation")), /maintenance/);
  await assert.rejects(h.coordinator.reconnectEntry(entry()), /maintenance/);
  await assert.rejects(h.coordinator.prepareEntryForRuntimeRecovery(entry()), /maintenance/);
  await assert.rejects(h.coordinator.reconcileDesiredRunning(), /maintenance/);
  assert.deepEqual(h.events, []);
});


test("maintenance fences a grant operation that passed admission before its stored-grant read finished", async () => {
  const h = harness(); let held = false; let finish!: () => void; let started!: () => void;
  const gate = new Promise<void>(r => { finish = r; }); const entered = new Promise<void>(r => { started = r; });
  h.daemon.isMaintenanceHeld = async () => held;
  h.operations.readGrant = async () => { started(); await gate; return null; };
  const operation = h.coordinator.reconcileDesiredRunning();
  await entered; held = true; finish(); await assert.rejects(operation, /maintenance/);
  assert.equal(h.events.some(event => event.startsWith("provision:") || event.startsWith("identity:") || event.startsWith("install:")), false);
});
