import assert from "node:assert/strict";
import test from "node:test";

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSupervisorGrantAgentKey,
  decryptSupervisorGrantFromStorage,
  desktopSupervisorGrantInstallationId,
  encryptSupervisorGrantForStorage,
  getOrProvisionDesktopSupervisorGrantForAgent,
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
} from "../main/supervisor-grant.js";

const keychain = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`keychain:${value}`),
  decryptString: (value: Buffer) => value.toString("utf8").replace("keychain:", ""),
};

function metadata(agentKey: string, suffix: string) {
  return {
    grantId: `grant_${suffix}`, hostId: "desktop_host", installationId: `install_${suffix}`,
    allowedRoomIds: [`room_${suffix}`], allowedAgentKeys: [agentKey], generation: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const roomScope = (requestedRoomId: string, canonicalRoomId = requestedRoomId) => ({ requestedRoomId, canonicalRoomId });

async function withRegistry(testBody: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "letagents-supervisor-grant-"));
  const previous = process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH;
  const path = join(directory, "registry.json");
  process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = path;
  try { await testBody(path); }
  finally {
    if (previous === undefined) delete process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH;
    else process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("supervisor grant storage uses the injected Keychain adapter and never returns plaintext", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`keychain:${value}`),
    decryptString: (value: Buffer) => value.toString("utf8").replace("keychain:", ""),
  };
  const stored = encryptSupervisorGrantForStorage("lashg_secret", storage);
  assert.match(stored, /^safe:/);
  assert.doesNotMatch(stored, /lashg_secret/);
  assert.equal(decryptSupervisorGrantFromStorage(stored, storage), "lashg_secret");
});

test("supervisor grant storage fails closed without Keychain encryption", () => {
  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: (_value: string) => Buffer.alloc(0),
    decryptString: (_value: Buffer) => "",
  };
  assert.throws(() => encryptSupervisorGrantForStorage("lashg_secret", unavailable), /Keychain encryption is unavailable/);
  assert.equal(decryptSupervisorGrantFromStorage("plain:lashg_secret", unavailable), null);
});

test("supervisor grant registry keys are stable agent identities rather than display names", () => {
  assert.equal(canonicalSupervisorGrantAgentKey(" Agent_8F31 "), "agent_8f31");
  assert.throws(() => canonicalSupervisorGrantAgentKey("  "), /identity is required/);
});

test("encrypted registry retains disjoint grants for two desktop-managed agents", async () => {
  await withRegistry(async (path) => {
    await replaceDesktopSupervisorGrantForAgent({
      agentKey: "owner/agent-a", metadata: metadata("owner/agent-a", "a"), token: "lashg_secret_a",
      entryId: "entry-a", lastInstalledDaemonGeneration: 3,
    }, { storage: keychain });
    await replaceDesktopSupervisorGrantForAgent({
      agentKey: "owner/agent-b", metadata: metadata("owner/agent-b", "b"), token: "lashg_secret_b",
      entryId: "entry-b", lastInstalledDaemonGeneration: 7,
    }, { storage: keychain });
    const first = await readDesktopSupervisorGrantForAgent("OWNER/AGENT-A", { storage: keychain });
    const second = await readDesktopSupervisorGrantForAgent("owner/agent-b", { storage: keychain });
    assert.equal(first?.token, "lashg_secret_a");
    assert.equal(first?.entryId, "entry-a");
    assert.equal(first?.lastInstalledDaemonGeneration, 3);
    assert.equal(second?.token, "lashg_secret_b");
    assert.equal(second?.metadata.allowedRoomIds[0], "room_b");
    const file = await readFile(path, "utf8");
    assert.doesNotMatch(file, /lashg_secret_a|lashg_secret_b/);
    assert.match(file, /entry-a/);
    assert.match(file, /entry-b/);
  });
});

test("per-agent installation ids are stable and independently scoped", () => {
  const first = desktopSupervisorGrantInstallationId("desktop_host", "entry-a");
  assert.equal(first, desktopSupervisorGrantInstallationId("desktop_host", "entry-a"));
  assert.notEqual(first, desktopSupervisorGrantInstallationId("desktop_host", "entry-b"));
});

test("concurrent provisioning preserves both grants and failed storage revokes only its own grant", async () => {
  await withRegistry(async () => {
    const requests: Array<Record<string, unknown>> = [];
    const revokedPaths: string[] = [];
    let releaseBoth!: () => void;
    const bothProvisioned = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const apiFetch = (async <T>(path: string, init?: { body?: string }) => {
      if (path.includes("/grant_") && !init?.body) {
        revokedPaths.push(path);
        return {} as T;
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      requests.push(body);
      const agentKey = (body.allowed_agent_keys as string[])[0]!;
      const index = requests.length;
      if (index === 2) releaseBoth();
      if (index <= 2) await bothProvisioned;
      return {
        grant_id: `grant_${index}`, host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: [agentKey], current_generation: 1,
        expires_at: new Date(Date.now() + 60_000).toISOString(), supervisor_grant: `lashg_secret_${index}`,
      } as T;
    }) as never;
    const [first, second] = await Promise.all([
      getOrProvisionDesktopSupervisorGrantForAgent({
        hostId: "desktop_host", entryId: "entry-a", agentKey: "owner/agent-a", roomScopes: [roomScope("room-a")],
      }, { storage: keychain, apiFetch }),
      getOrProvisionDesktopSupervisorGrantForAgent({
        hostId: "desktop_host", entryId: "entry-b", agentKey: "owner/agent-b", roomScopes: [roomScope("room-b")],
      }, { storage: keychain, apiFetch }),
    ]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.allowed_agent_keys), [["owner/agent-a"], ["owner/agent-b"]]);
    assert.notEqual(requests[0]!.installation_id, requests[1]!.installation_id);
    assert.equal(first.token, "lashg_secret_1");
    assert.equal(second.token, "lashg_secret_2");
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-a", { storage: keychain }))?.token, "lashg_secret_1");
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-b", { storage: keychain }))?.token, "lashg_secret_2");

    const failingStorage = {
      ...keychain,
      encryptString: (value: string) => {
        if (value === "lashg_secret_3") throw new Error("Keychain write failed");
        return keychain.encryptString(value);
      },
    };
    await assert.rejects(getOrProvisionDesktopSupervisorGrantForAgent({
      hostId: "desktop_host", entryId: "entry-c", agentKey: "owner/agent-c", roomScopes: [roomScope("room-c")],
    }, { storage: failingStorage, apiFetch }), /Keychain write failed/);
    assert.deepEqual(revokedPaths, ["/supervisor-host-grants/grant_3"]);
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-a", { storage: keychain }))?.token, "lashg_secret_1");
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-b", { storage: keychain }))?.token, "lashg_secret_2");
  });
});

test("concurrent same-agent get-or-provision performs one POST and returns one credential", async () => {
  await withRegistry(async (path) => {
    let posts = 0;
    let signalStarted!: () => void;
    let releasePost!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const released = new Promise<void>((resolve) => { releasePost = resolve; });
    const apiFetch = (async <T>(_path: string, init?: { body?: string }) => {
      posts += 1;
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      signalStarted();
      await released;
      return {
        grant_id: "grant_same", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_same_secret",
      } as T;
    }) as never;
    const input = {
      hostId: "desktop_host", entryId: "entry-same", agentKey: "owner/agent-same", roomScopes: [roomScope("room-same")],
    };
    const firstPromise = getOrProvisionDesktopSupervisorGrantForAgent(input, { storage: keychain, apiFetch });
    await started;
    const secondPromise = getOrProvisionDesktopSupervisorGrantForAgent(input, { storage: keychain, apiFetch });
    await Promise.resolve();
    assert.equal(posts, 1, "the second caller waits behind the complete same-agent lifecycle");
    releasePost();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(posts, 1);
    assert.deepEqual(second, first);
    assert.equal(first.token, "lashg_same_secret");
    const registry = JSON.parse(await readFile(path, "utf8")) as { grants: Record<string, unknown> };
    assert.deepEqual(Object.keys(registry.grants), ["owner/agent-same"]);
  });
});

test("different aliases resolving to the same canonical room reuse one grant", async () => {
  await withRegistry(async () => {
    let posts = 0;
    const apiFetch = (async <T>(_path: string, init?: { body?: string }) => {
      posts += 1;
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return {
        grant_id: "grant_alias", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_alias",
      } as T;
    }) as never;
    const base = { hostId: "desktop_host", entryId: "entry-alias", agentKey: "owner/agent-alias" };
    const first = await getOrProvisionDesktopSupervisorGrantForAgent({
      ...base, roomScopes: [roomScope("JOIN-CODE", "room-canonical")],
    }, { storage: keychain, apiFetch });
    const second = await getOrProvisionDesktopSupervisorGrantForAgent({
      ...base, roomScopes: [roomScope("github.com/owner/repo", "room-canonical")],
    }, { storage: keychain, apiFetch });
    assert.equal(posts, 1);
    assert.equal(second.token, first.token);
    assert.deepEqual(second.metadata.allowedRoomIds, ["room-canonical"]);
  });
});

test("stale or under-scoped cached grant is revoked and reprovisioned", async () => {
  await withRegistry(async () => {
    const agentKey = "owner/agent-stale";
    const installationId = desktopSupervisorGrantInstallationId("desktop_host", "entry-stale");
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: {
        ...metadata(agentKey, "stale"), hostId: "desktop_host", installationId,
        allowedRoomIds: ["room-old"], expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      token: "lashg_old", entryId: "entry-stale",
    }, { storage: keychain });
    const calls: string[] = [];
    const apiFetch = (async <T>(path: string, init?: { body?: string }) => {
      calls.push(`${init?.body ? "POST" : "DELETE"} ${path}`);
      if (!init?.body) return {} as T;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        grant_id: "grant_replacement", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_replacement",
      } as T;
    }) as never;
    const result = await getOrProvisionDesktopSupervisorGrantForAgent({
      hostId: "desktop_host", entryId: "entry-stale", agentKey,
      roomScopes: [roomScope("room-old"), roomScope("room-new")],
    }, { storage: keychain, apiFetch });
    assert.deepEqual(calls, ["DELETE /supervisor-host-grants/grant_stale", "POST /supervisor-host-grants"]);
    assert.equal(result.token, "lashg_replacement");
    assert.deepEqual(result.metadata.allowedRoomIds, ["room-old", "room-new"]);
  });
});

test("already-revoked or response-lost cleanup still removes the exact stale entry and reprovisions", async () => {
  await withRegistry(async () => {
    const agentKey = "owner/agent-cleanup";
    const installationId = desktopSupervisorGrantInstallationId("desktop_host", "entry-cleanup");
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: {
        ...metadata(agentKey, "cleanup"), hostId: "desktop_host", installationId,
        allowedRoomIds: ["room-old"],
      },
      token: "lashg_cleanup_old", entryId: "entry-cleanup",
    }, { storage: keychain });
    const calls: string[] = [];
    const apiFetch = (async <T>(path: string, init?: { body?: string }) => {
      calls.push(`${init?.body ? "POST" : "DELETE"} ${path}`);
      if (!init?.body) throw Object.assign(new Error("delete response lost"), { status: 404 });
      assert.equal(await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }), null,
        "the exact stale local entry is removed even when DELETE acknowledgement is lost");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        grant_id: "grant_cleanup_new", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_cleanup_new",
      } as T;
    }) as never;
    const result = await getOrProvisionDesktopSupervisorGrantForAgent({
      hostId: "desktop_host", entryId: "entry-cleanup", agentKey,
      roomScopes: [roomScope("alias-new", "room-new")],
    }, { storage: keychain, apiFetch });
    assert.deepEqual(calls, ["DELETE /supervisor-host-grants/grant_cleanup", "POST /supervisor-host-grants"]);
    assert.equal(result.token, "lashg_cleanup_new");
  });
});

test("missing safeStorage fails before get-or-provision performs an API request", async () => {
  let requests = 0;
  const unavailable = {
    isEncryptionAvailable: () => false,
    encryptString: (_value: string) => Buffer.alloc(0),
    decryptString: (_value: Buffer) => "",
  };
  await assert.rejects(
    getOrProvisionDesktopSupervisorGrantForAgent({
      hostId: "desktop_host", entryId: "entry-a", agentKey: "owner/agent-a", roomScopes: [roomScope("room_a")],
    }, {
      storage: unavailable,
      apiFetch: (async () => { requests += 1; throw new Error("must not run"); }) as never,
    }),
    /Keychain encryption is unavailable/,
  );
  assert.equal(requests, 0);
});
