import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";
import type { HostApprovalChallenge, HostApprovalOperation } from "../../shared/host-approval-auth.js";
import { testDaemonEndpoint } from "./helpers/daemon-fixture.js";
import { connectDaemon } from "../../../../shared/daemon-endpoint.mjs";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";

/**
 * A real daemon on its own socket and database. An agent's tools hold the
 * socket path, so every request here is one an agent on the machine could send.
 */
type Reply = { ok: boolean; result?: unknown; error?: string };

function daemonRequest(socketPath: string, method: string, params?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const client = connectDaemon(socketPath);
    let received = "";
    let settled = false;
    const timeout = setTimeout(() => { client.destroy(); reject(new Error(`'${method}' did not answer`)); }, 10_000);
    client.setEncoding("utf8");
    client.once("error", (error) => { clearTimeout(timeout); reject(error); });
    client.once("close", () => {
      clearTimeout(timeout);
      if (!settled) reject(new Error(`Daemon connection closed before '${method}' returned a response.`));
    });
    client.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      settled = true;
      client.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    client.on("connect", () => client.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "test", method, params })}\n`));
  });
}

function agent(id: string, overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id, room_id: `room_${id}`, display_name: `Agent ${id}`, provider: "codex", model: null, charter: "Help the room",
    desired_state: "paused", observed_state: "absent", condition: "none", permission_profile_id: "full_access",
    provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    delivery_mode: "daemon_inbox",
    created_by: "desktop", created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

async function withDaemon(run: (context: {
  socketPath: string;
  manifestPath: string;
  generation: number;
  signed: (operation: HostApprovalOperation, input: unknown, key?: KeyObject) => { payload: string; signature: string };
  configuration: (entryId: string) => Promise<Record<string, unknown>>;
  setSharing: (entryId: string, enabled: unknown, key?: KeyObject) => Promise<Reply>;
  outsider: KeyObject;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "letagents-live-sharing-"));
  const paths = { lockPath: join(root, "daemon.lock"), ...testDaemonEndpoint(root),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl") };
  const host = generateKeyPairSync("ed25519");
  const outsider = generateKeyPairSync("ed25519");
  // No provider port: nothing here can start a native agent or reach a room server.
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false);
  try {
    await daemon.start({ getHostApprovalPublicKey: async () => host.publicKey.export({ format: "der", type: "spki" }).toString("base64") });
    const challengeReply = await daemonRequest(paths.socketPath, "supervisor.host_approval_challenge");
    assert.equal(challengeReply.ok, true, challengeReply.error);
    const challenge = challengeReply.result as HostApprovalChallenge;
    const generation = challenge.daemonGeneration;
    const signed = (operation: HostApprovalOperation, input: unknown, key: KeyObject = host.privateKey) => {
      const issuedAt = Date.now();
      const payload = JSON.stringify({ domain: "letagents.host-approval", version: 1, ...challenge,
        operation, input, issuedAt, expiresAt: issuedAt + 30_000 });
      return { payload, signature: sign(null, Buffer.from(payload), key).toString("base64") };
    };
    const configuration = async (entryId: string) => {
      const reply = await daemonRequest(paths.socketPath, "supervisor.get_agent_configuration", { entry_id: entryId, daemon_generation: generation });
      assert.equal(reply.ok, true, reply.error);
      return reply.result as Record<string, unknown>;
    };
    const setSharing = (entryId: string, enabled: unknown, key?: KeyObject) => daemonRequest(paths.socketPath,
      "supervisor.host_approval_request", signed("set_live_sharing", { entryId, daemonGeneration: generation, enabled }, key));
    await run({ socketPath: paths.socketPath, manifestPath: paths.manifestPath, generation, signed, configuration, setSharing, outsider: outsider.privateKey });
  } finally {
    await daemon.stop().catch(() => undefined);
    await removeTestDirectory(root);
  }
}

test("live sharing is off for a new agent and only the desktop app's signed request turns it on", { timeout: 60_000 }, async () => {
  await withDaemon(async ({ socketPath, manifestPath, generation, signed, configuration, setSharing, outsider }) => {
    assert.equal((await daemonRequest(socketPath, "manifest.put", { entry: agent("supervised_owner") })).ok, true);
    const fresh = await configuration("supervised_owner");
    assert.equal(fresh.share_live_activity, false, "a new agent does not share");
    assert.equal(fresh.live_sharing_availability, "available");

    // A flat manifest entry, or the ordinary settings save, cannot carry the choice.
    assert.equal((await daemonRequest(socketPath, "manifest.put", {
      entry: { ...agent("supervised_flat"), share_live_activity: true, shareLiveActivity: true },
    })).ok, true);
    assert.equal((await configuration("supervised_flat")).share_live_activity, false);
    const saved = await daemonRequest(socketPath, "supervisor.update_agent_configuration", {
      entry_id: "supervised_owner", daemon_generation: generation, expected_revision: fresh.config_revision,
      configuration: { model: null, reasoning_effort: null, charter: "Help the room", permission_profile_id: "full_access", share_live_activity: true },
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal((await configuration("supervised_owner")).share_live_activity, false);

    // Unsigned, wrongly signed, or signed for another operation: refused.
    const input = { entryId: "supervised_owner", daemonGeneration: generation, enabled: true };
    for (const envelope of [
      { operation: "set_live_sharing", input },
      { payload: JSON.stringify({ operation: "set_live_sharing", input }), signature: "A".repeat(86) + "==" },
      signed("set_live_sharing", input, outsider),
    ]) {
      const refused = await daemonRequest(socketPath, "supervisor.host_approval_request", envelope);
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? "", /could not be authenticated/);
    }
    for (const malformed of [
      { entryId: "supervised_owner", daemonGeneration: generation },
      { entryId: "supervised_owner", daemonGeneration: generation, enabled: "true" },
      { entryId: "supervised_owner", daemonGeneration: generation, enabled: true, extra: 1 },
      { entryId: "", daemonGeneration: generation, enabled: true },
      null,
    ]) {
      const refused = await daemonRequest(socketPath, "supervisor.host_approval_request", signed("set_live_sharing", malformed));
      assert.equal(refused.ok, false, JSON.stringify(malformed));
    }
    const stale = await setSharingAt(socketPath, signed, generation + 1);
    assert.equal((stale.result as { outcome?: string })?.outcome, "invalid");
    assert.equal((await configuration("supervised_owner")).share_live_activity, false);

    // The owner's own request: on at once, with no new launch revision, so nothing asks for a restart.
    const before = await configuration("supervised_owner");
    const on = await setSharing("supervised_owner", true);
    assert.equal(on.ok, true, on.error);
    assert.equal((on.result as { outcome: string }).outcome, "updated");
    const after = await configuration("supervised_owner");
    assert.equal(after.share_live_activity, true);
    assert.equal(after.config_revision, before.config_revision);
    assert.equal(after.runtime_configuration_revision, before.runtime_configuration_revision);
    assert.equal((await configuration("supervised_flat")).share_live_activity, false, "only that agent shares");

    // Rewriting the agent's manifest record keeps the owner's choice.
    const renamed = await daemonRequest(socketPath, "manifest.set_display_name", { id: "supervised_owner", display_name: "Renamed agent" });
    assert.equal(renamed.ok, true, renamed.error);
    assert.equal((await configuration("supervised_owner")).share_live_activity, true);

    const off = await setSharing("supervised_owner", false);
    assert.equal((off.result as { outcome: string }).outcome, "updated");
    assert.equal((await configuration("supervised_owner")).share_live_activity, false);

    const database = new DatabaseSync(manifestPath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
      assert.deepEqual({ ...database.prepare("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('agent_configurations') WHERE name='live_sharing'").get() },
        { type: "TEXT", required: 1, dflt_value: "'off'" });
      assert.equal(database.prepare("SELECT live_sharing FROM agent_configurations WHERE agent_id='supervised_owner'").get()!.live_sharing, "withdrawing",
        "turned off after sharing, the removal of what the room shows is remembered until the room confirms it");
      assert.equal(database.prepare("SELECT live_sharing FROM agent_configurations WHERE agent_id='supervised_flat'").get()!.live_sharing, "off");
    } finally { database.close(); }
  });
});

async function setSharingAt(socketPath: string, signed: (operation: HostApprovalOperation, input: unknown) => { payload: string; signature: string }, daemonGeneration: number) {
  return daemonRequest(socketPath, "supervisor.host_approval_request", signed("set_live_sharing", { entryId: "supervised_owner", daemonGeneration, enabled: true }));
}

test("an agent that fetches its own messages, or a rented agent, cannot share its live activity", { timeout: 60_000 }, async () => {
  await withDaemon(async ({ socketPath, configuration, setSharing }) => {
    assert.equal((await daemonRequest(socketPath, "manifest.put", { entry: agent("supervised_polling", { delivery_mode: "mcp_polling" }) })).ok, true);
    assert.equal((await configuration("supervised_polling")).live_sharing_availability, "polling");
    const refused = await setSharing("supervised_polling", true);
    assert.equal((refused.result as { outcome?: string }).outcome, "invalid");
    assert.match((refused.result as { error?: string }).error ?? "", /fetches its own room messages/);
    assert.equal((await configuration("supervised_polling")).share_live_activity, false);
    // Turning it off is always allowed.
    assert.equal(((await setSharing("supervised_polling", false)).result as { outcome?: string }).outcome, "updated");
  });
});

test("a schema 50 database gains the live sharing column off for every existing agent", async () => {
  assert.ok(DAEMON_STATE_SCHEMA_VERSION >= 51, "the live sharing column shipped in schema v51");
  const root = await mkdtemp(join(tmpdir(), "letagents-live-sharing-schema-"));
  const databasePath = join(root, "daemon-state.sqlite");
  try {
    const original = new ManifestStore(databasePath);
    await original.write(0, [agent("agent_1"), agent("agent_2")]);
    await original.close();
    const old = new DatabaseSync(databasePath);
    // Schema v50 has the image input column and no live sharing column.
    old.exec("ALTER TABLE agent_configurations DROP COLUMN live_sharing; UPDATE manifest_metadata SET schema_version=50; PRAGMA user_version=50");
    old.exec("UPDATE agent_configurations SET image_input=1 WHERE agent_id='agent_1'");
    old.close();
    const migrated = new ManifestStore(databasePath);
    try {
      assert.equal((await migrated.getAgentConfiguration("agent_1"))?.live_sharing, "off");
      assert.equal((await migrated.getAgentConfiguration("agent_1"))?.image_input, true, "the v50 image input choice survives the upgrade");
      assert.equal((await migrated.getAgentConfiguration("agent_2"))?.live_sharing, "off");
      assert.equal(await migrated.setAgentLiveSharing({ agentId: "agent_1", enabled: true }), "on");
      assert.equal(await migrated.setAgentLiveSharing({ agentId: "agent_2", enabled: false }), "off", "an agent that never shared has nothing to remove");
      assert.deepEqual([...(await migrated.liveSharingByAgent()).entries()].sort(), [["agent_1", "on"], ["agent_2", "off"]]);
      assert.equal(await migrated.setAgentLiveSharing({ agentId: "agent_1", enabled: false }), "withdrawing");
      assert.equal(await migrated.setAgentLiveSharing({ agentId: "agent_1", enabled: true }), "on", "on again wins over a pending removal");
      assert.equal(await migrated.markLiveSharingWithdrawn("agent_1"), "on", "a removal confirmed late never turns sharing off");
      assert.equal(await migrated.setAgentLiveSharing({ agentId: "agent_1", enabled: false }), "withdrawing");
      assert.equal(await migrated.markLiveSharingWithdrawn("agent_1"), "off");
      assert.equal(await migrated.setAgentLiveSharing({ agentId: "missing", enabled: true }), null);
      const inspection = new DatabaseSync(databasePath);
      try {
        assert.equal(inspection.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
        assert.throws(() => inspection.prepare("UPDATE agent_configurations SET live_sharing='maybe'").run(), /CHECK/);
      } finally { inspection.close(); }
    } finally { await migrated.close(); }
  } finally {
    await removeTestDirectory(root);
  }
});
