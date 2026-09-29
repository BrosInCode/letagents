import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";
import { createDaemonMaintenance, clearDaemonMaintenance, daemonMaintenancePath, readDaemonMaintenance } from "../../../../shared/daemon-maintenance.mjs";

function request(path: string, method: string, params?: unknown): Promise<{ ok: boolean; result: any; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let text = "";
    socket.on("connect", () => socket.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: method, method, params }) + "\n"));
    socket.on("error", reject); socket.on("data", chunk => { text += chunk; if (text.includes("\n")) { socket.end(); resolve(JSON.parse(text.split("\n")[0]!)); } });
  });
}
function snapshot(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()]));
  } finally { db.close(); }
}

test("maintenance cold boot preserves all durable rows and refuses work until explicit resume", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  const paths = { lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"), attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root };
  const entry: DaemonManifestEntry = { id: "agent", room_id: "room", display_name: "Preserved", provider: "cursor", model: null, charter: "saved input", desired_state: "running", observed_state: "failed", condition: "coordination_blocked", permission_profile_id: "sandboxed_write", created_by: "fixture", created_at: "2026-01-01T00:00:00.000Z" };
  const store = new ManifestStore(paths.manifestPath); await store.write(0, [entry]); await store.close();
  const savedFile = join(root, "saved-work.txt"); await writeFile(savedFile, "user work");
  const seed = new DatabaseSync(paths.manifestPath);
  try {
    seed.prepare(`INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,created_at,updated_at)
      VALUES('inbox','agent','room','message','{}','{}',1,'awaiting_result',1,'action','reply','ambiguous-turn',NULL,?,?)`).run(entry.created_at, entry.created_at);
    seed.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES('inbox','agent','room','original-attempt','original-execution','saved-continuation','ambiguous-turn')").run();
    seed.prepare(`INSERT INTO supervised_agent_effects(effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,created_at,updated_at)
      VALUES('effect','agent','room','original-execution','ambiguous-turn','request','send_message','{}',1,'executing',?,?)`).run(entry.created_at, entry.created_at);
  } finally { seed.close(); }
  const before = snapshot(paths.manifestPath);
  const hold = await createDaemonMaintenance(daemonMaintenancePath(root));
  const unexpected = async () => { assert.fail("held boot must never call a native provider"); };
  const provider = new Proxy({}, { get: () => unexpected });
  const seenGenerations: number[] = [];
  try {
    for (let boot = 0; boot < 2; boot++) {
      const daemon = new SupervisorDaemon(paths, "darwin", provider as never, true);
      await daemon.start();
      try {
      const status = await request(paths.socketPath, "daemon.negotiate");
      assert.equal(status.result.maintenance_hold_id, hold.id);
      assert.ok(Object.values(status.result.capabilities).every(flag => flag === false));
      seenGenerations.push(status.result.generation);
      const list = await request(paths.socketPath, "manifest.list"); assert.equal(list.ok, true);
      assert.equal(list.result[0].id, entry.id); assert.equal(list.result[0].desired_state, "running");
      for (const method of ["manifest.put", "manifest.resume", "supervisor.install_host_grant", "agent.runtime_recovery", "manifest.watch_state", "agent.stream", "host_approvals.enroll"]) {
        const rejected = await request(paths.socketPath, method, { entry });
        assert.equal(rejected.ok, false, method); assert.match(rejected.error!, /maintenance/, method);
      }
      assert.equal(snapshot(paths.manifestPath), before, "no normalization, outcomes or provider receipts may be manufactured");
      } finally {
        assert.equal((await request(paths.socketPath, "daemon.prepare_handoff")).ok, true);
        await daemon.waitForHandoff();
      }
      assert.equal(snapshot(paths.manifestPath), before);
      assert.deepEqual(await readDaemonMaintenance(daemonMaintenancePath(root)), hold);
    }
    assert.equal(seenGenerations[1], seenGenerations[0]! + 1);
    await clearDaemonMaintenance(hold.id, daemonMaintenancePath(root));
    const resumed = new SupervisorDaemon(paths, "darwin");
    try {
      await resumed.start(); const status = await request(paths.socketPath, "daemon.negotiate");
      assert.equal(status.result.maintenance_hold_id, null); assert.equal(status.result.capabilities.agent_lifecycle_v1, true);
      const db = new DatabaseSync(paths.manifestPath, { readOnly: true });
      try { assert.equal((db.prepare("SELECT state FROM supervised_agent_effects WHERE effect_id='effect'").get() as {state: string}).state, "uncertain", "only normal resume applies existing interrupted-effect normalization"); }
      finally { db.close(); }
    } finally { await resumed.stop(); }
    assert.equal(await readFile(savedFile, "utf8"), "user work");
  } finally { await rm(root, { recursive: true, force: true }); }
});
