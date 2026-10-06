import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createDaemonControlRequestHandler, type DaemonControlOperations } from "../control-request-router.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";
import type { HostApprovalChallenge, HostApprovalOperation } from "../../shared/host-approval-auth.js";

/**
 * A real daemon on its own socket and database. Everything a local process
 * can send to that socket is tried here: an agent's tools hold the socket
 * path, so this is what an agent could reach.
 */

/** The stored form of "on" is an exact `false` under this key. */
const KEY = "letagentsOwnerIsolation";
type Reply = { ok: boolean; result?: unknown; error?: string };

function daemonRequest(socketPath: string, method: string, params?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
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

function agent(id: string, provider: string, overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id, room_id: `room_${id}`, display_name: `Agent ${id}`, provider, model: null, charter: "Help the room",
    desired_state: "paused", observed_state: "absent", condition: "none",
    permission_profile_id: provider === "cursor" ? "sandboxed_write" : provider === "claude-code" ? "ask_before_write" : "full_access",
    provider_launch_policy: provider === "codex" ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } : {},
    // The daemon delivers this agent its room messages, as for every agent the desktop app creates.
    delivery_mode: "daemon_inbox",
    created_by: "desktop", created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

async function withDaemon(run: (context: {
  socketPath: string;
  generation: number;
  signed: (operation: HostApprovalOperation, input: unknown, key?: KeyObject) => { payload: string; signature: string };
  configuration: (entryId: string) => Promise<Record<string, unknown>>;
  setOwnSetup: (entryId: string, enabled: unknown, key?: KeyObject) => Promise<Reply>;
  storedPolicy: (entryId: string) => Record<string, unknown>;
  /** Writes the key into every stored policy behind the daemon's back, as no socket request can. */
  forceStoredKey: () => void;
  /** Makes the daemon hold a running process for this agent that started at the given configuration revision. */
  setRunning: (entryId: string, startedAtRevision: number | undefined | null) => void;
  roster: (entryId: string) => Promise<Record<string, unknown>>;
  outsider: KeyObject;
}) => Promise<void>, legacyManifest?: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "letagents-home-harness-"));
  const paths = { lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl") };
  const host = generateKeyPairSync("ed25519");
  const outsider = generateKeyPairSync("ed25519");
  await legacyManifest?.(root);
  // No provider port: nothing here can start a native agent.
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
    const setOwnSetup = async (entryId: string, enabled: unknown, key?: KeyObject) => daemonRequest(paths.socketPath,
      "supervisor.host_approval_request", signed("set_home_harness", {
        entryId, daemonGeneration: generation, expectedRevision: (await configuration(entryId)).config_revision, enabled,
      }, key));
    const storedPolicy = (entryId: string) => {
      const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
      try {
        const row = database.prepare("SELECT provider_launch_policy_json AS policy FROM agent_configurations WHERE agent_id=?").get(entryId) as { policy: string | null };
        return JSON.parse(row.policy ?? "{}") as Record<string, unknown>;
      } finally { database.close(); }
    };
    const forceStoredKey = () => {
      const database = new DatabaseSync(paths.manifestPath);
      try {
        database.exec(`UPDATE agent_configurations SET provider_launch_policy_present=1, provider_launch_policy_undefined=0,
          provider_launch_policy_json=json_set(coalesce(provider_launch_policy_json,'{}'), '$.${KEY}', json('false'))`);
      } finally { database.close(); }
    };
    const liveHandles = (daemon as unknown as { liveHandles: Map<string, Record<string, unknown>> }).liveHandles;
    const setRunning = (entryId: string, startedAtRevision: number | undefined | null) => {
      if (startedAtRevision === null) liveHandles.delete(entryId);
      else liveHandles.set(entryId, { workAttemptId: `attempt_${entryId}`, pid: null, providerContinuationId: null, observedState: "idle",
        ...(startedAtRevision === undefined ? {} : { appliedConfigurationRevision: startedAtRevision }) });
    };
    const roster = async (entryId: string) => {
      const listed = await daemonRequest(paths.socketPath, "manifest.list");
      assert.equal(listed.ok, true, listed.error);
      return (listed.result as Array<Record<string, unknown>>).find((item) => item.id === entryId)!;
    };
    await run({ socketPath: paths.socketPath, generation, signed, configuration, setOwnSetup, storedPolicy, forceStoredKey, setRunning, roster, outsider: outsider.privateKey });
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test("only the desktop app's signed request turns an agent's use of its owner's own setup on", { timeout: 60_000 }, async () => {
  await withDaemon(async ({ socketPath, generation, signed, configuration, setOwnSetup, storedPolicy, outsider }) => {
    const created = await daemonRequest(socketPath, "manifest.put", { entry: agent("supervised_owner", "codex") });
    assert.equal(created.ok, true, created.error);
    assert.equal((await configuration("supervised_owner")).home_harness, false, "a new agent starts without it");
    assert.equal((await configuration("supervised_owner")).home_harness_availability, "available");

    // 1. Creating an agent, as Add Agent or any socket caller does.
    for (const policy of [{ [KEY]: false }, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, [KEY]: false }]) {
      const refused = await daemonRequest(socketPath, "manifest.put", {
        entry: agent("supervised_smuggled", "codex", { provider_launch_policy: policy }),
      });
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? "", /turned on in the desktop app and cannot be supplied to manifest\.put/);
    }
    // Sent as JSON text, a policy can carry the key on its own `__proto__` property, or nested. Neither is stored.
    for (const policy of [
      JSON.parse(`{"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"},"__proto__":{"${KEY}":false}}`),
      JSON.parse(`{"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess","__proto__":{"${KEY}":false}}}`),
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, nested: { [KEY]: false } },
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, letagentsOwnerIsolationChangedAt1: false },
      // Look-alike, escaped and repeated spellings, as JSON text allows.
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, LetAgentsOwnerIsolation: false },
      { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, letagentsHomeHarness: true },
      JSON.parse('{"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"},"letagents\\u004fwnerIsolation":false}'),
      JSON.parse('{"approvalPolicy":"never","sandboxPolicy":{"type":"dangerFullAccess"},"letagentsOwnerIsolation":true,"letagentsOwnerIsolation":false}'),
    ]) {
      const entry = agent("supervised_smuggled", "codex", { provider_launch_policy: policy });
      assert.match(JSON.stringify(entry), /letagents/i, "the request does carry a key LetAgents keeps for itself");
      const refused = await daemonRequest(socketPath, "manifest.put", { entry });
      assert.equal(refused.ok, false, JSON.stringify(policy));
      assert.match(refused.error ?? "", /turned on in the desktop app and cannot be supplied to manifest\.put/);
    }
    assert.equal(((await daemonRequest(socketPath, "manifest.list")).result as Array<{ id: string }>).some((item) => item.id === "supervised_smuggled"), false);
    const flat = await daemonRequest(socketPath, "manifest.put", {
      entry: { ...agent("supervised_flat", "codex"), home_harness: true, homeHarness: true },
    });
    assert.equal(flat.ok, true, flat.error);
    assert.equal((await configuration("supervised_flat")).home_harness, false, "an unknown field on a new entry is not the setting");

    // 2. Re-sending a creation for an agent that exists never changes it.
    const replay = await daemonRequest(socketPath, "manifest.put", {
      entry: agent("supervised_owner", "codex", { provider_launch_policy: { [KEY]: false } }),
    });
    assert.equal(replay.ok, false);
    assert.equal((await configuration("supervised_owner")).home_harness, false);

    // 3. The ordinary settings update that the Inspector's Save sends.
    const fields = { model: null, reasoning_effort: null, charter: "Help the room", permission_profile_id: "full_access" };
    for (const params of [
      { configuration: { ...fields, home_harness: true, homeHarness: true, [KEY]: false } },
      { configuration: fields, home_harness: true, homeHarness: true, enabled: true },
    ]) {
      const revision = (await configuration("supervised_owner")).config_revision;
      const saved = await daemonRequest(socketPath, "supervisor.update_agent_configuration", {
        entry_id: "supervised_owner", daemon_generation: generation, expected_revision: revision, ...params,
      });
      assert.equal(saved.ok, true, saved.error);
      assert.equal((await configuration("supervised_owner")).home_harness, false);
    }
    const policyUpdate = await daemonRequest(socketPath, "supervisor.update_agent_configuration", {
      entry_id: "supervised_owner", daemon_generation: generation,
      expected_revision: (await configuration("supervised_owner")).config_revision,
      configuration: { ...fields, provider_launch_policy: { [KEY]: false } },
    });
    assert.equal((policyUpdate.result as { outcome?: string }).outcome, "invalid");

    // 4. The signed route without the desktop app's key.
    const unsignedInput = { entryId: "supervised_owner", daemonGeneration: generation, expectedRevision: 1, enabled: true };
    for (const envelope of [
      { operation: "set_home_harness", input: unsignedInput },
      { payload: JSON.stringify({ operation: "set_home_harness", input: unsignedInput }), signature: "A".repeat(86) + "==" },
      signed("set_home_harness", unsignedInput, outsider),
    ]) {
      const refused = await daemonRequest(socketPath, "supervisor.host_approval_request", envelope);
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? "", /could not be authenticated/);
    }
    // A signature over another operation is not this one.
    const listed = await daemonRequest(socketPath, "supervisor.host_approval_request", signed("list", { ...unsignedInput, roomId: "room_supervised_owner" }));
    assert.equal(listed.ok, false);
    assert.equal((await configuration("supervised_owner")).home_harness, false);
    assert.equal(Object.hasOwn(storedPolicy("supervised_owner"), KEY), false, "nothing an unsigned caller sent reached the stored policy");

    // 5. A signed request must say exactly what it changes.
    for (const input of [
      { entryId: "supervised_owner", daemonGeneration: generation, expectedRevision: 1 },
      { entryId: "supervised_owner", daemonGeneration: generation, expectedRevision: 1, enabled: "true" },
      { entryId: "supervised_owner", daemonGeneration: generation, expectedRevision: 1, enabled: true, extra: 1 },
      { entryId: "", daemonGeneration: generation, expectedRevision: 1, enabled: true },
      null,
    ]) {
      const malformed = await daemonRequest(socketPath, "supervisor.host_approval_request", signed("set_home_harness", input));
      assert.equal(malformed.ok, false, JSON.stringify(input));
    }
    const staleGeneration = await daemonRequest(socketPath, "supervisor.host_approval_request", signed("set_home_harness", {
      entryId: "supervised_owner", daemonGeneration: generation + 1, expectedRevision: 1, enabled: true,
    }));
    assert.equal((staleGeneration.result as { outcome?: string })?.outcome, "invalid");
    assert.equal((await configuration("supervised_owner")).home_harness, false);

    // 6. The desktop app's own signed request.
    const before = await configuration("supervised_owner");
    const onEnvelope = signed("set_home_harness", {
      entryId: "supervised_owner", daemonGeneration: generation, expectedRevision: before.config_revision, enabled: true,
    });
    const on = await daemonRequest(socketPath, "supervisor.host_approval_request", onEnvelope);
    assert.equal(on.ok, true, on.error);
    assert.equal((on.result as { outcome: string }).outcome, "updated");
    const after = await configuration("supervised_owner");
    assert.equal(after.home_harness, true);
    assert.equal(after.config_revision, (before.config_revision as number) + 1);
    assert.equal(after.runtime_configuration_revision, before.runtime_configuration_revision, "it waits for the agent's next start");
    assert.equal(storedPolicy("supervised_owner")[KEY], false, "on is stored as an exact false: isolation from the owner's setup is off");
    for (const [key, value] of Object.entries(storedPolicy("supervised_owner"))) {
      if (key.startsWith("letagents")) assert.equal(value, false, `${key}: an older build drops only a false value`);
    }
    const listedEntries = (await daemonRequest(socketPath, "manifest.list")).result as Array<Record<string, unknown>>;
    assert.equal(listedEntries.find((item) => item.id === "supervised_owner")?.home_harness, "on", "the roster can show which agents have it");
    assert.equal(Object.hasOwn(listedEntries.find((item) => item.id === "supervised_flat")!, "home_harness"), false);

    // A later ordinary save keeps the owner's choice, and still cannot change it.
    const kept = await daemonRequest(socketPath, "supervisor.update_agent_configuration", {
      entry_id: "supervised_owner", daemon_generation: generation, expected_revision: after.config_revision,
      configuration: { ...fields, permission_profile_id: "ask_before_write", home_harness: false },
    });
    assert.equal(kept.ok, true, kept.error);
    assert.equal((await configuration("supervised_owner")).home_harness, true);
    // So does every other write of the agent's row.
    assert.equal((await daemonRequest(socketPath, "manifest.set_display_name", { id: "supervised_owner", display_name: "Renamed" })).ok, true);
    assert.equal((await configuration("supervised_owner")).home_harness, true);

    const off = await setOwnSetup("supervised_owner", false);
    assert.equal((off.result as { outcome: string }).outcome, "updated");
    assert.equal(Object.hasOwn(off.result as object, "apply"), false, "no process ever started with it, so nothing is restarted");
    assert.equal((await configuration("supervised_owner")).home_harness, false);
    assert.equal(Object.hasOwn(storedPolicy("supervised_owner"), KEY), false);

    // 7. The app's own earlier request, captured and sent again by someone else, turns nothing back on:
    //    it names the revision it was made for, and that revision has passed.
    const replayed = await daemonRequest(socketPath, "supervisor.host_approval_request", onEnvelope);
    assert.equal((replayed.result as { outcome?: string })?.outcome, "conflict");
    assert.equal((await configuration("supervised_owner")).home_harness, false);
    assert.equal(Object.hasOwn(storedPolicy("supervised_owner"), KEY), false);
  });
});

test("the roster shows what a running agent really has, not only what is saved", { timeout: 60_000 }, async () => {
  await withDaemon(async ({ socketPath, configuration, setOwnSetup, setRunning, roster }) => {
    const id = "supervised_owner";
    assert.equal((await daemonRequest(socketPath, "manifest.put", { entry: agent(id, "codex") })).ok, true);
    const state = async () => (await roster(id)).home_harness;
    const startedAt = (await configuration(id)).config_revision as number;

    // A process is running from before the switch is turned on.
    setRunning(id, startedAt);
    assert.equal(await state(), undefined);
    assert.equal(((await setOwnSetup(id, true)).result as { outcome: string }).outcome, "updated");
    assert.equal(await state(), "after_restart", "saved on, but this process started without it");
    assert.equal((await configuration(id)).home_harness_pending, true);
    // The agent restarts and its new process starts with the saved configuration.
    const onAt = (await configuration(id)).config_revision as number;
    setRunning(id, onAt);
    assert.equal(await state(), "on");

    // Turned off while that process runs: it still has the owner's setup, and the roster keeps saying so.
    const off = (await setOwnSetup(id, false)).result as { outcome: string; apply?: string; configuration: Record<string, unknown> };
    assert.equal(off.outcome, "updated");
    assert.equal(off.configuration.home_harness, false);
    assert.equal(await state(), "until_restart", "off is saved, but it is not off yet");
    // Stopped, nothing runs with it any more.
    setRunning(id, null);
    assert.equal(await state(), undefined);
    // A process whose starting revision is unknown is never assumed to have caught up with a later change.
    setRunning(id, undefined);
    assert.equal(((await setOwnSetup(id, true)).result as { outcome: string }).outcome, "updated");
    assert.equal(await state(), "after_restart");
  });
});

test("turning the owner's own setup off restarts an idle agent that still has it, and never interrupts one that is working", async () => {
  const run = async (input: {
    enabled: boolean;
    saved: Record<string, unknown>;
    apply?: () => Promise<unknown> | unknown;
  }) => {
    const applied: unknown[] = [];
    const handler = createDaemonControlRequestHandler(
      { assertCurrent: async () => {}, currentGeneration: () => 7, isHandoffScheduled: () => false },
      {
        // The signature is checked by the verifier; here every request is the desktop app's own.
        hostApprovals: { verify: (params: unknown) => params },
        updateAgentConfiguration: async (request: unknown) => {
          assert.deepEqual(request, { entryId: "agent", daemonGeneration: 7, expectedRevision: 5, configuration: {}, homeHarness: input.enabled });
          return input.saved;
        },
        applyAgentConfiguration: (request: unknown) => { applied.push(request); return (input.apply ?? (() => ({ outcome: "restarting" })))(); },
      } as unknown as DaemonControlOperations,
    );
    const result = await handler({ version: DAEMON_PROTOCOL_VERSION, id: "test", method: "supervisor.host_approval_request",
      params: { operation: "set_home_harness", input: { entryId: "agent", daemonGeneration: 7, expectedRevision: 5, enabled: input.enabled } } } as never);
    return { result: result as Record<string, unknown>, applied };
  };
  const saved = (pending: unknown, outcome = "updated") => ({ outcome, configuration: { config_revision: 6, home_harness: false, home_harness_pending: pending } });

  // Off, and a process that started with the setup is still there: the agent is restarted through the ordinary apply path.
  const restarted = await run({ enabled: false, saved: saved(true) });
  assert.deepEqual(restarted.applied, [{ entryId: "agent", daemonGeneration: 7, expectedConfigurationRevision: 6 }]);
  assert.deepEqual(restarted.result, { ...saved(true), apply: "restarting" });
  // That path replaces only an idle agent. A turn in progress is left alone, and the answer says so.
  const busy = await run({ enabled: false, saved: saved(true), apply: () => ({ outcome: "busy_active_turn" }) });
  assert.equal(busy.result.apply, "busy_active_turn");
  assert.equal(busy.result.outcome, "updated", "the choice is saved either way");
  // A restart that fails or answers nothing readable is reported as not done, never as done.
  for (const apply of [() => { throw new Error("stopped"); }, () => Promise.reject(new Error("stopped")), () => null, () => ({ outcome: 1 })]) {
    assert.equal((await run({ enabled: false, saved: saved(true), apply })).result.apply, "unavailable");
  }
  // Nothing is restarted when no process has the setup, when it was turned on, or when nothing was saved.
  for (const untouched of [
    { enabled: false, saved: saved(false) },
    { enabled: false, saved: saved("true") },
    { enabled: true, saved: { outcome: "updated", configuration: { config_revision: 6, home_harness: true, home_harness_pending: true } } },
    { enabled: false, saved: saved(true, "conflict") },
    { enabled: false, saved: { outcome: "invalid", error: "The exact agent no longer exists." } },
  ]) {
    const outcome = await run(untouched);
    assert.deepEqual(outcome.applied, [], JSON.stringify(untouched));
    assert.deepEqual(outcome.result, untouched.saved);
  }
});

test("a signed request still cannot give a rental, a Cursor agent, an Open Model agent or an agent that collects its own messages the owner's own setup", { timeout: 60_000 }, async () => {
  await withDaemon(async ({ socketPath, configuration, setOwnSetup, storedPolicy, forceStoredKey }) => {
    for (const [id, provider, availability, reason, deliveryMode] of [
      ["supervised_rental_0123456789abcdef", "cursor", "rental", /rented agent works for someone else/, "daemon_inbox"],
      ["supervised_rental_fedcba9876543210", "codex", "rental", /rented agent works for someone else/, "daemon_inbox"],
      ["supervised_cursor", "cursor", "unsupported", /no setup of yours/, "daemon_inbox"],
      ["supervised_open", "open-model", "unsupported", /no setup of yours/, "daemon_inbox"],
      // Agents on the older delivery, where each collects its own room messages: turning it off could not be enforced.
      ["supervised_polling_codex", "codex", "polling", /^Not available for this agent: it fetches its own messages, so LetAgents can't reliably switch your setup off again\.$/, "mcp_polling"],
      ["supervised_polling_claude", "claude-code", "polling", /it fetches its own messages/, undefined],
    ] as const) {
      const { delivery_mode: _delivered, ...polling } = agent(id, provider);
      const created = await daemonRequest(socketPath, "manifest.put", { entry: deliveryMode === "daemon_inbox" ? agent(id, provider)
        : { ...polling, ...(deliveryMode ? { delivery_mode: deliveryMode } : {}) } });
      assert.equal(created.ok, true, created.error);
      assert.equal((await configuration(id)).home_harness_availability, availability);
      const refused = await setOwnSetup(id, true);
      assert.equal(refused.ok, true, refused.error);
      assert.equal((refused.result as { outcome: string }).outcome, "invalid");
      assert.match((refused.result as { error: string }).error, reason);
      assert.equal((await configuration(id)).home_harness, false);
      assert.equal(Object.hasOwn(storedPolicy(id), KEY), false);
    }
    const listed = (await daemonRequest(socketPath, "manifest.list")).result as Array<Record<string, unknown>>;
    assert.equal(listed.some((item) => Object.hasOwn(item, "home_harness")), false);

    // A value that reached the stored policy some other way is still not the owner's choice for these agents.
    forceStoredKey();
    for (const id of ["supervised_rental_0123456789abcdef", "supervised_rental_fedcba9876543210", "supervised_cursor", "supervised_open", "supervised_polling_codex", "supervised_polling_claude"]) {
      assert.equal(storedPolicy(id)[KEY], false, "the test did plant the value");
      assert.equal((await configuration(id)).home_harness, false, id);
    }
    const planted = (await daemonRequest(socketPath, "manifest.list")).result as Array<Record<string, unknown>>;
    assert.equal(planted.some((item) => Object.hasOwn(item, "home_harness")), false, "no list or badge shows it for them");

    // And the next ordinary Save of such an agent takes the planted value out of what is stored.
    for (const [id, profile] of [["supervised_rental_fedcba9876543210", "full_access"], ["supervised_cursor", "sandboxed_write"], ["supervised_polling_codex", "full_access"]] as const) {
      const current = await configuration(id);
      const saved = await daemonRequest(socketPath, "supervisor.update_agent_configuration", {
        entry_id: id, daemon_generation: current.daemon_generation, expected_revision: current.config_revision,
        configuration: { model: null, reasoning_effort: null, charter: "Help the room, carefully", permission_profile_id: profile },
      });
      assert.equal((saved.result as { outcome?: string })?.outcome, "updated", `${id}: ${saved.error ?? JSON.stringify(saved.result)}`);
      assert.equal(Object.hasOwn(storedPolicy(id), KEY), false, id);
    }
  });
});

test("an imported manifest never brings the owner's own setup with it", { timeout: 60_000 }, async () => {
  const { createHash } = await import("node:crypto");
  await withDaemon(async ({ configuration, storedPolicy }) => {
    assert.equal((await configuration("supervised_imported")).home_harness, false);
    assert.deepEqual(storedPolicy("supervised_imported"), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  }, async (root) => {
    const manifest = { generation: 3, entries: [agent("supervised_imported", "codex", {
      desired_state: "stopped", observed_state: "stopped",
      provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, [KEY]: false },
    })] };
    await writeFile(join(root, "daemon-manifest.json"), JSON.stringify({
      checksum: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), manifest,
    }));
    // Proves the import ran, so the assertion above is about an imported row.
    const store = new ManifestStore(join(root, "daemon-state.sqlite"), join(root, "daemon-manifest.json"));
    try { assert.deepEqual((await store.load()).entries.map((item) => item.id), ["supervised_imported"]); } finally { await store.close(); }
  });
});

// ---- What an earlier writer left in a stored policy does not decide a launch with the owner's own setup.

const { deriveProviderConfigurationSnapshot, entryLaunchPolicy } = await import("../provider-configuration.js");
const { attestProviderSpawnPolicy } = await import("../../electron/main/agents/provider-spawn-configuration.js");
const { claudeCliLaunchArgs, claudeLaunchPolicyArgs, claudeChildEnvironment, claudeOwnerSetupStartEnvironment } = await import("../../electron/main/agents/claude-code-provider-adapter.js");
const { inspectClaudeCodeVersion, resolveClaudeCodeExecutable } = await import("../../electron/main/agents/claude-code-version.js");

/** The installed Claude Code, when it is one the adapter supports. Asked its version in a scratch home. */
function installedClaude(scratch: string): string | null {
  if (process.env.LETAGENTS_SKIP_CLAUDE_CONTRACT === "1") return null;
  try {
    const bin = resolveClaudeCodeExecutable(process.env);
    const version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, HOME: scratch, CLAUDE_CONFIG_DIR: join(scratch, ".claude") } });
    return inspectClaudeCodeVersion(version, "Ask before writes").supported ? bin : null;
  } catch {
    return null;
  }
}

test("a policy an unsigned creation stored keeps nothing of a project running once the owner signs the switch on", { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "letagents-home-harness-launch-"));
  try {
    await withDaemon(async ({ socketPath, setOwnSetup, storedPolicy, configuration }) => {
      // Any local process can create an agent, and its policy may name any option of the agent app.
      const claudeStored = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, settingSources: "user,project,local" };
      const codexStored = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, config: { mcp_servers: { evil: { command: "/repo/evil" } } } };
      for (const [id, provider, policy] of [["supervised_claude_seeded", "claude-code", claudeStored], ["supervised_codex_seeded", "codex", codexStored]] as const) {
        const created = await daemonRequest(socketPath, "manifest.put", { entry: agent(id, provider, { permission_profile_id: "full_access", provider_launch_policy: policy }) });
        assert.equal(created.ok, true, created.error);
        assert.equal((await configuration(id)).home_harness, false);
        // The owner turns the switch on, with a request the desktop app signed.
        assert.equal(((await setOwnSetup(id, true)).result as { outcome: string }).outcome, "updated");
        // What is stored is the agent's own policy, unchanged, and the owner's choice beside it.
        const stored = storedPolicy(id);
        assert.deepEqual(Object.fromEntries(Object.entries(stored).filter(([key]) => !key.startsWith("letagents"))), policy, id);
        assert.equal(stored[KEY], false);
      }
      const launchOf = async (id: string, provider: "claude-code" | "codex") => {
        const revision = (await configuration(id)).config_revision as number;
        const snapshot = deriveProviderConfigurationSnapshot(
          { provider, model: null, reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: revision },
          entryLaunchPolicy({ id, provider, deliveryMode: "daemon_inbox" }, storedPolicy(id)));
        assert.equal(snapshot.homeHarness, true, id);
        return attestProviderSpawnPolicy(provider, { ...snapshot, workAttemptId: "attempt", roomId: "room", cwd: "/work/attempt",
          agentDisplayName: "Agent", supervisorEntryId: id, deliveryMode: "daemon_inbox" } as never);
      };
      // The launch is built from the access level alone.
      assert.deepEqual(await launchOf("supervised_codex_seeded", "codex"), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
      const attested = await launchOf("supervised_claude_seeded", "claude-code");
      assert.deepEqual(attested, { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true });

      // And through the installed Claude Code: a project whose settings run a hook and whose .mcp.json adds a server.
      const home = join(scratch, "home");
      const project = join(scratch, "project");
      const hookRan = join(scratch, "project-hook-ran");
      const serverRan = join(scratch, "project-server-ran");
      await mkdir(join(home, ".claude"), { recursive: true });
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(join(home, ".claude", ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
      await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({
        enableAllProjectMcpServers: true, hooks: { SessionStart: [{ hooks: [{ type: "command", command: `/usr/bin/touch ${hookRan}` }] }] },
      }));
      await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { repo_only: { command: "/usr/bin/touch", args: [serverRan] } } }));
      const roomConfig = join(scratch, "room.json");
      await writeFile(roomConfig, JSON.stringify({ mcpServers: {} }));
      const args = claudeCliLaunchArgs({ approvalProfileLabel: null, homeHarness: true, ownerMcpStartupMs: 5_000, cwd: project,
        mcpConfigPath: roomConfig, policyArgs: claudeLaunchPolicyArgs(attested), model: null, session: { sessionId: crypto.randomUUID() } });
      assert.deepEqual(args.flatMap((arg, index) => args[index - 1] === "--setting-sources" ? [arg] : []), ["user"], "the owner's settings alone, once");
      const claude = installedClaude(home);
      if (!claude) return;
      const child = spawn(claude, args, {
        cwd: project, stdio: ["pipe", "pipe", "ignore"], detached: true,
        // Nothing listens on the discard port, and the key is not a key.
        env: claudeChildEnvironment({ env: claudeOwnerSetupStartEnvironment(5_000, true), ownerSetup: true }, {
          PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        }),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const servers = await new Promise<string[]>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Claude Code printed no init line in time")), 60_000);
          child.once("error", reject);
          child.once("exit", (code) => reject(new Error(`Claude Code exited before init (${code})`)));
          createInterface({ input: child.stdout! }).on("line", (line) => {
            try {
              const message = JSON.parse(line) as { type?: string; subtype?: string; mcp_servers?: Array<{ name: string }> };
              if (message.type === "system" && message.subtype === "init") resolve((message.mcp_servers ?? []).map((server) => server.name));
            } catch { /* Not a stream-json line. */ }
          });
          child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`);
        });
        assert.deepEqual({ servers, hookRan: existsSync(hookRan), serverRan: existsSync(serverRan) }, { servers: [], hookRan: false, serverRan: false },
          "the project's hook did not run and its server did not start");
      } finally {
        clearTimeout(timer);
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
