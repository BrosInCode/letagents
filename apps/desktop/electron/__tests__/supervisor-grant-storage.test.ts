import assert from "node:assert/strict";
import test from "node:test";

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSupervisorGrantAgentKey,
  decryptSupervisorGrantFromStorage,
  desktopSupervisorGrantInstallationId,
  encryptSupervisorGrantForStorage,
  getOrCreateDesktopCodexAgentIdentity,
  getOrProvisionDesktopSupervisorGrantForAgent,
  provisionDesktopSupervisorGrant,
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
  revokeDesktopSupervisorGrant,
} from "../main/supervisor-grant.js";
import { DesktopApiError } from "../main/auth.js";

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
  assert.equal(canonicalSupervisorGrantAgentKey(" EmmyMay/Agent_8F31 "), "EmmyMay/Agent_8F31");
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
    const first = await readDesktopSupervisorGrantForAgent("owner/agent-a", { storage: keychain });
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

test("identity resolution preserves server casing and repairs a lowercased legacy mapping", async () => {
  await withRegistry(async (path) => {
    const entryId = "supervised_mixed_case_owner";
    await writeFile(path, `${JSON.stringify({
      version: 4,
      grants: {},
      entryAgentKeys: { [entryId]: "emmymay/desktop-codex-stale" },
    })}\n`, "utf8");
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const resolved = await getOrCreateDesktopCodexAgentIdentity({
      entryId,
      displayName: "StoneRidge",
    }, {
      apiFetch: (async <T>(requestPath: string, init?: { body?: string }) => {
        requests.push({ path: requestPath, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
        return { canonical_key: "EmmyMay/desktop-codex-canonical" } as T;
      }) as never,
    });
    assert.equal(resolved, "EmmyMay/desktop-codex-canonical");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.path, "/agents");
    const registry = JSON.parse(await readFile(path, "utf8")) as { entryAgentKeys: Record<string, string> };
    assert.equal(registry.entryAgentKeys[entryId], "EmmyMay/desktop-codex-canonical");
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

test("narrowing the canonical room set rotates away excess authority", async () => {
  await withRegistry(async () => {
    let posts = 0;
    let deletes = 0;
    const apiFetch = (async <T>(_path: string, init?: { body?: string }) => {
      if (!init?.body) { deletes += 1; return {} as T; }
      posts += 1;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        grant_id: `grant_scope_${posts}`, host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: `lashg_scope_${posts}`,
      } as T;
    }) as never;
    const base = { hostId: "desktop_host", entryId: "entry-scope", agentKey: "owner/agent-scope" };
    await getOrProvisionDesktopSupervisorGrantForAgent({
      ...base, roomScopes: [roomScope("alias-a", "room-a"), roomScope("alias-b", "room-b")],
    }, { storage: keychain, apiFetch });
    const narrowed = await getOrProvisionDesktopSupervisorGrantForAgent({
      ...base, roomScopes: [roomScope("another-a", "room-a")],
    }, { storage: keychain, apiFetch });
    assert.equal(posts, 2);
    assert.equal(deletes, 1);
    assert.deepEqual(narrowed.metadata.allowedRoomIds, ["room-a"]);
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

test("pre-send DELETE failure preserves local recovery until an acknowledged retry", async () => {
  await withRegistry(async () => {
    const agentKey = "owner/agent-presend";
    const installationId = desktopSupervisorGrantInstallationId("desktop_host", "entry-presend");
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: {
        ...metadata(agentKey, "presend"), hostId: "desktop_host", installationId,
        allowedRoomIds: ["room-old"],
      },
      token: "lashg_presend_old", entryId: "entry-presend",
    }, { storage: keychain });
    let deletes = 0;
    let posts = 0;
    const apiFetch = (async <T>(_path: string, init?: { body?: string }) => {
      if (!init?.body) {
        deletes += 1;
        if (deletes === 1) throw new Error("network unreachable before send");
        return {} as T;
      }
      posts += 1;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        grant_id: "grant_presend_new", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_presend_new",
      } as T;
    }) as never;
    const input = {
      hostId: "desktop_host", entryId: "entry-presend", agentKey,
      roomScopes: [roomScope("alias-new", "room-new")],
    };
    await assert.rejects(
      getOrProvisionDesktopSupervisorGrantForAgent(input, { storage: keychain, apiFetch }),
      /network unreachable before send/,
    );
    assert.equal(posts, 0);
    assert.equal((await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }))?.token, "lashg_presend_old");
    const recovered = await getOrProvisionDesktopSupervisorGrantForAgent(input, { storage: keychain, apiFetch });
    assert.equal(deletes, 2);
    assert.equal(posts, 1);
    assert.equal(recovered.token, "lashg_presend_new");
  });
});

test("lost DELETE response preserves local recovery, then an explicit 404 retry reprovisions", async () => {
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
    let deleteAttempts = 0;
    const apiFetch = (async <T>(path: string, init?: { body?: string }) => {
      calls.push(`${init?.body ? "POST" : "DELETE"} ${path}`);
      if (!init?.body) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("delete response lost after server revoke");
        throw new DesktopApiError(404, { error: "Active supervisor grant not found." });
      }
      assert.equal(await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }), null,
        "an acknowledged 404 removes the exact stale local entry before POST");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        grant_id: "grant_cleanup_new", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_cleanup_new",
      } as T;
    }) as never;
    const input = {
      hostId: "desktop_host", entryId: "entry-cleanup", agentKey,
      roomScopes: [roomScope("alias-new", "room-new")],
    };
    await assert.rejects(
      getOrProvisionDesktopSupervisorGrantForAgent(input, { storage: keychain, apiFetch }),
      /delete response lost after server revoke/,
    );
    assert.deepEqual(calls, ["DELETE /supervisor-host-grants/grant_cleanup"]);
    assert.equal((await readDesktopSupervisorGrantForAgent(agentKey, { storage: keychain }))?.token, "lashg_cleanup_old",
      "ambiguous transport failure preserves the recoverable encrypted credential");

    const result = await getOrProvisionDesktopSupervisorGrantForAgent(input, { storage: keychain, apiFetch });
    assert.deepEqual(calls, [
      "DELETE /supervisor-host-grants/grant_cleanup",
      "DELETE /supervisor-host-grants/grant_cleanup",
      "POST /supervisor-host-grants",
    ]);
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

test("legacy provision cannot overwrite a concurrent managed registry save", async () => {
  await withRegistry(async () => {
    let signalPost!: () => void;
    let releasePost!: () => void;
    const postStarted = new Promise<void>((resolve) => { signalPost = resolve; });
    const postReleased = new Promise<void>((resolve) => { releasePost = resolve; });
    const apiFetch = (async <T>(_path: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      signalPost();
      await postReleased;
      return {
        grant_id: "grant_manual", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_manual",
      } as T;
    }) as never;
    const manual = provisionDesktopSupervisorGrant({
      hostId: "desktop_host", installationId: "manual-install", allowedRoomIds: ["room-manual"],
      allowedAgentKeys: ["owner/agent-manual"],
    }, { storage: keychain, apiFetch });
    await postStarted;
    const managed = replaceDesktopSupervisorGrantForAgent({
      agentKey: "owner/agent-managed", metadata: metadata("owner/agent-managed", "managed"),
      token: "lashg_managed", entryId: "entry-managed",
    }, { storage: keychain });
    releasePost();
    await Promise.all([manual, managed]);
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-manual", { storage: keychain }))?.token, "lashg_manual");
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-managed", { storage: keychain }))?.token, "lashg_managed");
  });
});

test("legacy provision accepts a registry with identity metadata but no actual grants", async () => {
  await withRegistry(async (path) => {
    await writeFile(path, `${JSON.stringify({
      version: 4, grants: {}, entryAgentKeys: { "entry-preserved": "owner/preserved" },
    })}\n`, "utf8");
    let posts = 0;
    const apiFetch = (async <T>(_path: string, init?: { body?: string }) => {
      posts += 1;
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return {
        grant_id: "grant_manual", host_id: body.host_id, installation_id: body.installation_id,
        allowed_room_ids: body.allowed_room_ids, allowed_agent_keys: body.allowed_agent_keys,
        current_generation: 1, expires_at: new Date(Date.now() + 60_000).toISOString(),
        supervisor_grant: "lashg_manual",
      } as T;
    }) as never;
    await provisionDesktopSupervisorGrant({
      hostId: "desktop_host", installationId: "manual-install", allowedRoomIds: ["room-manual"],
      allowedAgentKeys: ["owner/agent-manual"],
    }, { storage: keychain, apiFetch });
    assert.equal(posts, 1);
    const registry = JSON.parse(await readFile(path, "utf8")) as { grants: Record<string, unknown>; entryAgentKeys: Record<string, string> };
    assert.deepEqual(Object.keys(registry.grants), ["owner/agent-manual"]);
    assert.equal(registry.entryAgentKeys["entry-preserved"], "owner/preserved");
  });
});

test("global revoke cannot erase a concurrent managed save it did not revoke", async () => {
  await withRegistry(async () => {
    await replaceDesktopSupervisorGrantForAgent({
      agentKey: "owner/agent-old", metadata: metadata("owner/agent-old", "old"),
      token: "lashg_old", entryId: "entry-old",
    }, { storage: keychain });
    let signalDelete!: () => void;
    let releaseDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { signalDelete = resolve; });
    const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const revoked: string[] = [];
    const apiFetch = (async <T>(path: string) => {
      revoked.push(path);
      signalDelete();
      await deleteReleased;
      return {} as T;
    }) as never;
    const revoke = revokeDesktopSupervisorGrant({ apiFetch });
    await deleteStarted;
    const managed = replaceDesktopSupervisorGrantForAgent({
      agentKey: "owner/agent-new", metadata: metadata("owner/agent-new", "new"),
      token: "lashg_new", entryId: "entry-new",
    }, { storage: keychain });
    releaseDelete();
    await Promise.all([revoke, managed]);
    assert.deepEqual(revoked, ["/supervisor-host-grants/grant_old"]);
    assert.equal(await readDesktopSupervisorGrantForAgent("owner/agent-old", { storage: keychain }), null);
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-new", { storage: keychain }))?.token, "lashg_new");
  });
});
