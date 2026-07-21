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
        hostId: "desktop_host", entryId: "entry-a", agentKey: "owner/agent-a", allowedRoomIds: ["room-a"],
      }, { storage: keychain, apiFetch }),
      getOrProvisionDesktopSupervisorGrantForAgent({
        hostId: "desktop_host", entryId: "entry-b", agentKey: "owner/agent-b", allowedRoomIds: ["room-b"],
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
      hostId: "desktop_host", entryId: "entry-c", agentKey: "owner/agent-c", allowedRoomIds: ["room-c"],
    }, { storage: failingStorage, apiFetch }), /Keychain write failed/);
    assert.deepEqual(revokedPaths, ["/supervisor-host-grants/grant_3"]);
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-a", { storage: keychain }))?.token, "lashg_secret_1");
    assert.equal((await readDesktopSupervisorGrantForAgent("owner/agent-b", { storage: keychain }))?.token, "lashg_secret_2");
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
      hostId: "desktop_host", entryId: "entry-a", agentKey: "owner/agent-a", allowedRoomIds: ["room_a"],
    }, {
      storage: unavailable,
      apiFetch: (async () => { requests += 1; throw new Error("must not run"); }) as never,
    }),
    /Keychain encryption is unavailable/,
  );
  assert.equal(requests, 0);
});
