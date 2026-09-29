import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { createElectronTestEnv } from "./harness.js";
const { DaemonControlSocket } = await import(new URL("../../daemon/control-socket.ts", import.meta.url).href);
import { runWithLocalBoardOwner, requestLocalBoard, onLocalBoardChanged } from "../../../../shared/local-board-owner.mjs";

const env = createElectronTestEnv({ prefix: "local-board-service-", paths: ["state", "chatStorage", "localChatDb"] });
const store = await import("../main/rooms/local-store.js");
const service = await import("../main/rooms/local-board-service.js");
const socketPath = join(env.tempDir, "board.sock");
process.env.LETAGENTS_BOARD_SOCKET_PATH = socketPath;
let generation = 1;
let active = true;
let beforeMutation: (() => Promise<void>) | null = null;
let mutations = 0;
let watchStarted: (() => void) | null = null;
const owned = <T>(callback: () => T) => runWithLocalBoardOwner(() => {
  if (!active) throw new Error("The board service is restarting.");
}, callback);
const makeSocket = () => new DaemonControlSocket(socketPath, async (request: { method: string; params?: unknown }, signal: AbortSignal) => {
  if (request.method === "local_board.watch") { watchStarted?.(); return service.watchLocalBoard(request.params, generation, signal); }
  if (request.method !== "local_board.mutate") throw new Error("Unexpected request");
  mutations++;
  await beforeMutation?.();
  return owned(() => service.executeLocalBoardMutation(request.params));
});
let socket = makeSocket();
await owned(() => store.getLocalTaskDatabase());
await socket.start();
test.after(async () => { await socket.stop(); delete process.env.LETAGENTS_BOARD_SOCKET_PATH; });

const mutate = (operation: string, args: unknown[], extra: Record<string, unknown> = {}) => requestLocalBoard(
  "mutate", { domain: "desktop", operation, args, databasePath: env.localChatDbPath, ...extra });
const watch = (roomId: string, prior = { generation: 0, revision: -1 }, signal?: AbortSignal) =>
  requestLocalBoard<{ generation: number; revision: number; tasks: Array<{ id: string; title: string }> }>(
    "watch", { roomId, ...prior }, { signal, timeoutMs: 0 });

test("owner publishes committed changes only, including commit followed by a caller failure", async () => {
  const room = "commit-boundaries";
  const task = await store.addLocalTask(room, { title: "Before" });
  const changes: string[] = [];
  const off = onLocalBoardChanged(id => { if (id === room) changes.push(id); });
  const offBroken = onLocalBoardChanged(() => { throw new Error("Disconnected renderer"); });
  const db = await store.getLocalTaskDatabase();
  try {
    owned(() => {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE local_tasks SET title='Rollback' WHERE room_id=?").run(room);
      db.exec("ROLLBACK");
      db.exec("BEGIN IMMEDIATE; SAVEPOINT board_change");
      db.prepare("UPDATE local_tasks SET title='Savepoint rollback' WHERE room_id=?").run(room);
      db.exec("ROLLBACK TO board_change; RELEASE board_change; COMMIT");
    });
    assert.equal(changes.length, 0);
    assert.equal((await store.getLocalTask(room, task.id))?.title, "Before");
    assert.throws(() => owned(() => {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE local_tasks SET title='Committed' WHERE room_id=?").run(room);
      db.exec("COMMIT");
      throw new Error("Later artifact processing failed");
    }), /Later artifact/);
    assert.equal(changes.length, 1);
    assert.equal((await store.getLocalTask(room, task.id))?.title, "Committed");
    assert.throws(() => db.prepare("UPDATE local_tasks SET title='Bypass' WHERE room_id=?").run(room), /background service/);
    assert.equal(changes.length, 1);
  } finally { off(); offBroken(); }
});

test("watch waits for its room and catches up after the service reconnects", async () => {
  const room = "reconnect-board";
  const initial = await watch(room);
  const controller = new AbortController();
  let delivered = false;
  const waiting = watch(room, initial, controller.signal).then(value => { delivered = true; return value; });
  await store.addLocalTask("unrelated-board", { title: "Other room" });
  assert.equal(delivered, false);
  const task = await store.addLocalTask(room, { title: "Agent task" });
  const updated = await waiting;
  assert.equal(updated.tasks[0]?.id, task.id);
  assert.ok(updated.revision > initial.revision);
  const listening = new Promise<void>(resolve => { watchStarted = resolve; });
  const lost = assert.rejects(watch(room, updated), /disconnected/);
  await listening;
  watchStarted = null;
  await socket.stop();
  await lost;
  await owned(() => store.updateLocalTask(room, task.id, { title: "While disconnected" }));
  generation++;
  socket = makeSocket();
  await socket.start();
  const recovered = await watch(room, updated);
  assert.equal(recovered.tasks[0]?.title, "While disconnected");
  assert.equal(recovered.generation, generation);
  const stopped = watch(room, recovered, controller.signal);
  controller.abort();
  await assert.rejects(stopped, /subscription closed/);
});

test("standalone worker identity is checked at the owner, after request delivery", async () => {
  const room = "worker-fence";
  const worker = { session_id: "worker-session", session_token: "private-test-token", room_id: room,
    agent_key: "local/worker", agent_instance_id: `worker_${"a".repeat(32)}`, actor_label: "Canonical worker", ended_at: null };
  const state = { agent_sessions: { [worker.session_id]: worker } };
  await writeFile(env.statePath!, JSON.stringify(state));
  const extra = { domain: "mcp", statePath: env.statePath, worker };
  const task = await mutate("addLocalTask", [room, { title: "Worker task" }], extra) as { id: string };
  await assert.rejects(mutate("updateLocalTask", [room, task.id, { status: "accepted" }], {
    ...extra, worker: { ...worker, session_token: "replaced" },
  }), /authority ended|connection was replaced/);
  await assert.rejects(mutate("updateLocalTask", [room, task.id, { status: "accepted" }], {
    ...extra, worker: { ...worker, agent_instance_id: "not-the-registered-instance" },
  }), /authority ended|connection was replaced/);
  beforeMutation = async () => { await writeFile(env.statePath!, JSON.stringify({ agent_sessions: {} })); };
  try {
    await assert.rejects(mutate("updateLocalTask", [room, task.id, { status: "accepted" }], extra), /authority ended/);
  } finally { beforeMutation = null; }
  assert.equal((await store.getLocalTask(room, task.id))?.status, "proposed");
  await assert.rejects(mutate("addLocalTask", [room, { title: "Wrong store" }], { databasePath: join(env.tempDir, "other.sqlite") }), /different local data store/);
});

test("a caller disconnect does not cancel or retry an admitted mutation", async () => {
  const room = "lost-mutation-reply";
  let release!: () => void;
  let admitted!: () => void;
  const received = new Promise<void>(resolve => { admitted = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  beforeMutation = async () => { admitted(); await blocked; };
  const before = mutations;
  const client = createConnection(socketPath);
  await new Promise<void>(resolve => client.once("connect", resolve));
  client.write(`${JSON.stringify({ version: 3, id: randomUUID(), method: "local_board.mutate", params: {
    domain: "desktop", operation: "addLocalTask", args: [room, { title: "Only once" }], databasePath: env.localChatDbPath,
  } })}\n`);
  await received;
  client.destroy();
  const changed = watch(room);
  release();
  beforeMutation = null;
  await changed;
  // Wait for the admitted owner call to settle; there is no second client request.
  for (let n = 0; n < 20 && !(await store.listLocalTasks(room)).length; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations, before + 1);
  assert.equal((await store.listLocalTasks(room)).length, 1);
});


test("valid large edits and board imports retain their existing input capacity", async () => {
  const room = "large-board-payloads";
  const task = await store.addLocalTask(room, { title: "Long description" });
  // UTF-8 makes this larger than both the old 64 KiB cap and 100,000 bytes.
  const description = "語".repeat(100_000);
  const updated = await store.updateLocalTask(room, task.id, { description });
  assert.equal(updated.description, description);
  await store.importLocalTasks("imported-large-board", [updated, { ...updated, id: "second-task" }]);
  const imported = await store.listLocalTasks("imported-large-board");
  assert.equal(imported.length, 2);
  assert.ok(imported.every(row => row.description === description));
});
