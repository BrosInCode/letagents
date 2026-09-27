import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemonMaintenance, readDaemonMaintenance, clearDaemonMaintenance, withDaemonMaintenanceOperation } from "../../../../shared/daemon-maintenance.mjs";
import { forceStopDaemon, performConfirmedMaintenance, type ForceDaemonRestartPort } from "../main/force-daemon-restart.js";

function fixture() {
  const events: string[] = [];
  let clock = 0;
  let state: "same" | "absent" | "zombie" | "changed" | "unverifiable" = "same";
  const target = { pid: 98765, kernelStartTime: "exact birth", command: "electron /app/daemon.js", expectedScriptPath: "/app/daemon.js", state: "live" as const };
  const port: ForceDaemonRestartPort = {
    identify: async () => target,
    persistHold: async () => { events.push("hold"); return { version: 1, id: "held", createdAt: new Date().toISOString() }; },
    observe: () => ({ kind: state }),
    signal: (identity, signal) => { assert.equal(identity, target); events.push(signal); return { kind: state }; },
    delay: async ms => { clock += ms; state = "absent"; }, now: () => clock, pollIntervalMs: 1,
    socketReleased: async () => { events.push("socket"); return true; },
    terminateTimeoutMs: 1, killTimeoutMs: 1,
  };
  return { port, target, events, advance: (ms: number) => { clock += ms; }, setState: (value: typeof state) => { state = value; } };
}

test("force restart persists the hold before signalling only the exact daemon", async () => {
  const f = fixture(); await forceStopDaemon(f.port);
  assert.deepEqual(f.events, ["hold", "SIGTERM", "socket"]);
});
test("force restart escalates only while the original process identity remains live", async () => {
  const f = fixture(); let waits = 0;
  f.port.delay = async ms => { f.advance(ms); f.setState(++waits === 1 ? "same" : "zombie"); };
  await forceStopDaemon(f.port);
  assert.deepEqual(f.events, ["hold", "SIGTERM", "SIGKILL", "socket"]);
});
for (const kind of ["changed", "unverifiable", "same"] as const) test(`force restart never reports completion for ${kind} identity after TERM`, async () => {
  const f = fixture(); f.port.delay = async ms => { f.advance(ms); f.setState(kind); };
  await assert.rejects(forceStopDaemon(f.port), /Could not confirm/);
  assert.equal(f.events.includes("socket"), false);
  assert.equal(f.events.includes("SIGKILL"), kind === "same");
});
for (const boundary of ["observe", "signal", "after_term"] as const) {
  for (const loss of ["changed", "unverifiable"] as const) test(`force restart observes absence after ${loss} at ${boundary}`, async () => {
    const f = fixture(); f.port.terminateTimeoutMs = 4;
    if (boundary === "observe") f.setState(loss);
    if (boundary === "signal") f.port.signal = () => ({ kind: loss });
    let polls = 0;
    f.port.delay = async ms => { f.advance(ms); polls++; f.setState(polls === 1 && boundary === "after_term" ? loss : polls === 2 ? "same" : "absent"); };
    await forceStopDaemon(f.port);
    assert.deepEqual(f.events, boundary === "after_term" ? ["hold", "SIGTERM", "socket"] : ["hold", "socket"]);
    assert.ok(f.port.now() <= 4);
  });
}
for (const later of ["same", "zombie", "changed", "unverifiable"] as const) test(`force restart cannot restore authority from ${later} after identity loss`, async () => {
  const f = fixture(); f.port.terminateTimeoutMs = 3; let polls = 0;
  f.port.delay = async ms => { f.advance(ms); f.setState(++polls === 1 ? "changed" : later); };
  await assert.rejects(forceStopDaemon(f.port), /stopped \(changed\)/);
  assert.deepEqual(f.events, ["hold", "SIGTERM"]); assert.equal(f.port.now(), 3);
});
test("force restart bounds identity-loss observation after KILL and still requires socket release", async () => {
  const f = fixture(); f.port.killTimeoutMs = 3; let polls = 0;
  f.port.delay = async ms => { f.advance(ms); f.setState(++polls === 1 ? "same" : polls === 2 ? "unverifiable" : "absent"); };
  f.port.socketReleased = async () => { f.events.push("socket"); return false; };
  await assert.rejects(forceStopDaemon(f.port), /still answers/);
  assert.deepEqual(f.events, ["hold", "SIGTERM", "SIGKILL", "socket"]); assert.equal(f.port.now(), 3);
});
for (const pid of [0, -98765, 1, process.pid, NaN]) test(`force restart refuses invalid daemon PID ${pid}`, async () => {
  const f = fixture(); f.target.pid = pid;
  await assert.rejects(forceStopDaemon(f.port), /safely identify/); assert.deepEqual(f.events, []);
});
test("force restart refuses another installation and a failed hold write", async () => {
  const f = fixture(); f.target.command = "electron /other/daemon.js";
  await assert.rejects(forceStopDaemon(f.port), /safely identify/); assert.deepEqual(f.events, []);
  f.target.command = "electron /app/daemon.js";
  f.port.persistHold = async () => { throw new Error("disk full"); };
  await assert.rejects(forceStopDaemon(f.port), /disk full/); assert.deepEqual(f.events, []);
});
test("force restart retains the hold if a different daemon owns the socket", async () => {
  const f = fixture(); f.port.socketReleased = async () => false;
  await assert.rejects(forceStopDaemon(f.port), /still answers/);
  assert.deepEqual(f.events, ["hold", "SIGTERM"]);
});
test("maintenance hold survives reopen, coalesces creation and requires exact resume identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-maintenance-")); const path = join(root, "hold.json");
  try {
    assert.equal(await readDaemonMaintenance(path), null);
    const a = await createDaemonMaintenance(path); const b = await createDaemonMaintenance(path);
    assert.deepEqual(a, b); assert.deepEqual(await readDaemonMaintenance(path), a);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const bytes = await readFile(path);
    await assert.rejects(clearDaemonMaintenance("wrong", path), /changed/);
    assert.deepEqual(await readFile(path), bytes);
    await clearDaemonMaintenance(a.id, path); assert.equal(await readDaemonMaintenance(path), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("maintenance corruption, readable-by-others and symlinks cannot silently resume supervision", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-maintenance-")); const path = join(root, "hold.json");
  try {
    await writeFile(path, "broken", { mode: 0o600 });
    await assert.rejects(readDaemonMaintenance(path)); await assert.rejects(createDaemonMaintenance(path));
    assert.equal(await readFile(path, "utf8"), "broken"); await rm(path);
    const hold = await createDaemonMaintenance(path); await chmod(path, 0o644);
    await assert.rejects(readDaemonMaintenance(path), /Unsafe/); await chmod(path, 0o600);
    const link = join(root, "link.json"); await symlink(path, link);
    await assert.rejects(readDaemonMaintenance(link)); assert.deepEqual(await readDaemonMaintenance(path), hold);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("maintenance action owns the hold through stop proof and competing resume cannot remove it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-maintenance-")); const path = join(root, "hold.json");
  try {
    let retained: unknown;
    await withDaemonMaintenanceOperation(async owner => {
      retained = owner; const hold = await owner.create();
      await assert.rejects(clearDaemonMaintenance(hold.id, path), /in progress/);
      await assert.rejects(createDaemonMaintenance(path), /in progress/);
      assert.deepEqual(await owner.read(), hold);
    }, path);
    assert.throws(() => (retained as { clear(id: string): unknown }).clear("any"), /has ended/);
    const hold = await readDaemonMaintenance(path); assert.ok(hold);
    await clearDaemonMaintenance(hold.id, path);
    const inode = (await stat(`${path}.lock`)).ino;
    await createDaemonMaintenance(path);
    assert.equal((await stat(`${path}.lock`)).ino, inode);
  } finally { await rm(root, { recursive: true, force: true }); }
});


for (const scenario of ["cancel", "force", "resume", "untrusted", "changed_sender", "stop_failed"] as const) test(`maintenance native confirmation ${scenario}`, async () => {
  const events: string[] = []; let assertions = 0;
  const operation = performConfirmedMaintenance({
    assertTrusted() { assertions++; if (scenario === "untrusted" || (scenario === "changed_sender" && assertions === 2)) throw new Error("untrusted"); },
    async confirm(resume) { events.push(`confirm:${resume}`); return scenario !== "cancel"; },
    async stop(resume) { events.push(`stop:${resume}`); if (scenario === "stop_failed") throw new Error("stop failed"); },
    relaunch() { events.push("relaunch"); },
  }, scenario === "resume");
  if (["untrusted", "changed_sender", "stop_failed"].includes(scenario)) await assert.rejects(operation);
  else await operation;
  assert.deepEqual(events, scenario === "untrusted" ? [] : scenario === "cancel" || scenario === "changed_sender" ? ["confirm:false"]
    : scenario === "stop_failed" ? ["confirm:false", "stop:false"] : [`confirm:${scenario === "resume"}`, `stop:${scenario === "resume"}`, "relaunch"]);
});
