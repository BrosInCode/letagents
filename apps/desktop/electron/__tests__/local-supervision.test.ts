import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { createElectronTestEnv } from "./harness.js";

const environment = createElectronTestEnv({ prefix: "local-supervision-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"],
  extraEnvFiles: { LETAGENTS_LOCAL_FILES_DIR: "files" } });
const { createLocalRoom } = await import("../main/rooms/local-store.js");
const { setChatStorageMode } = await import("../main/chat-storage/settings.js");
const { addLocalChatMessage, getLocalChatMessages } = await import("../main/rooms/messages/local-store.js");
const { getStoredAgentSession } = await import("../main/agents/state.js");
const { prepareLocalSupervisorGrant, revokeLocalSupervisorEntry } = await import("../main/rooms/local-supervision-authority.js");
const { requestLocalSupervisor, executeLocalSupervisorTool } = await import("../main/rooms/local-supervision-runtime.js");
const origin = "letagents-local://rooms";

async function worker(roomId: string, name: string, suffix: string) {
  const grant = await prepareLocalSupervisorGrant({ entryId: `supervised_test_${suffix}`, roomId, displayName: name, provider: "codex" });
  const body = { generation: 1, room_id: roomId, agent_key: grant.agentKey,
    agent_instance_id: `daemon:${grant.entryId}`, runtime: "codex", display_name: name, ide_label: "Codex" };
  const mint = () => requestLocalSupervisor(`${origin}/supervisor-host-grants/${grant.grantId}/worker-sessions`, {
    method: "POST", headers: { authorization: `Bearer ${grant.supervisorGrant}`, "x-letagents-supervisor-generation": "1" }, body: JSON.stringify(body),
  }).then(response => response.json()) as Promise<Record<string, string>>;
  const session = await mint();
  const request = (path: string, init: RequestInit = {}) => requestLocalSupervisor(`${origin}/rooms/${roomId}/${path}`, {
    ...init, headers: { authorization: `Bearer ${session.worker_bearer}` },
  }).then(response => response.json()) as Promise<any>;
  return { grant, session, request, mint };
}

// Any accidental cloud request is a test failure, including signed-out setup.
test.before(() => { globalThis.fetch = async () => { throw new Error("Local supervision attempted a network request"); }; });

test("local worker authority is scoped, stable, private, and independent of cloud storage preference", async () => {
  const roomId = "github.com/example/local-supervision"; // local identity need not have a local_ prefix
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "authority");
  assert.equal((await oak.mint()).session_id, oak.session.session_id);
  assert.equal(getStoredAgentSession(oak.session.session_id)?.agent_key, oak.grant.agentKey);
  assert.equal(getStoredAgentSession(oak.session.session_id)?.session_token, "");
  assert.ok(!(await readFile(environment.statePath!, "utf8")).includes(oak.session.worker_bearer));
  assert.equal((await stat(`${environment.localChatDbPath}.supervisor-key`)).mode & 0o777, 0o600);
  await setChatStorageMode("cloud");
  assert.equal((await oak.request("join")).room_id, roomId);
  await createLocalRoom({ roomIdentifier: "local_other" });
  await assert.rejects(() => requestLocalSupervisor(`${origin}/rooms/local_other/messages`, {
    headers: { authorization: `Bearer ${oak.session.worker_bearer}` },
  }), /authority/);
});

test("routing honors exact mentions, shared human fallback, self suppression, and threads", async () => {
  const roomId = "local_routing";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "oak_routing");
  const elm = await worker(roomId, "Elm", "elm_routing");
  const first = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak check this" });
  const oakPage = await oak.request("messages/poll");
  const elmPage = await elm.request("messages/poll");
  assert.equal(oakPage.messages[0].activation.for_current_agent.decision, "activate");
  assert.equal(elmPage.messages[0].activation.for_current_agent.decision, "silent");
  const fallback = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "Please investigate" });
  const page = await elm.request(`messages/poll?after=${first.id}`);
  assert.equal(page.messages[0].activation.for_current_agent.reason, "small_room");
  const reply = await oak.request("messages", { method: "POST", body: JSON.stringify({ text: "@everyone evidence", client_message_id: "reply_1" }) });
  assert.equal((await oak.request(`messages/poll?after=${fallback.id}`)).messages[0].activation.for_current_agent.reason, "self_message");
  assert.equal((await elm.request(`messages/poll?after=${fallback.id}`)).messages[0].activation.for_current_agent.reason, "broadcast");
  const thread = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "Continue here", reply_to: reply.id, thread_root_id: reply.id });
  assert.equal((await oak.request(`messages/poll?after=${reply.id}`)).messages[0].activation.for_current_agent.reason, "thread_participant");
  assert.equal((await elm.request(`messages/poll?after=${reply.id}`)).messages[0].activation.for_current_agent.decision, "unclear");
  assert.equal((await elm.request(`messages/poll?after=${reply.id}`)).last_observed_message_id, thread.id);
});

test("duplicate friendly names cannot broaden historical or new addressed delivery", async () => {
  const roomId = "local_duplicate_names";
  await createLocalRoom({ roomIdentifier: roomId });
  const first = await worker(roomId, "Oak", "duplicate_first");
  const message = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak inspect" });
  assert.equal((await first.request("messages")).messages[0].activation.for_current_agent.decision, "activate");
  const second = await worker(roomId, "Oak", "duplicate_second");
  assert.notEqual(first.grant.agentKey, second.grant.agentKey);
  assert.equal((await second.request("messages")).messages[0].activation.for_current_agent.decision, "silent");
  await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak inspect again" });
  for (const actor of [first, second]) assert.equal((await actor.request(`messages?after=${message.id}`)).messages[0].activation.for_current_agent.decision, "silent");
});

test("publication is idempotent and rejects altered replay; revocation and resume never revive old credentials", async () => {
  const roomId = "local_publication";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "publication");
  const send = (text: string) => oak.request("messages", { method: "POST", body: JSON.stringify({ text, client_message_id: "once" }) });
  const first = await send("A finished result");
  assert.equal((await send("A finished result")).id, first.id);
  assert.equal((await getLocalChatMessages(roomId)).messages.length, 1);
  await assert.rejects(() => send("A different result"), /different content/);
  await revokeLocalSupervisorEntry(oak.grant.entryId, oak.session.session_id);
  await assert.rejects(() => oak.request("messages"), /authority/);
  const resumed = await worker(roomId, "Oak", "publication");
  assert.notEqual(resumed.grant.grantId, oak.grant.grantId);
  assert.notEqual(resumed.session.session_id, oak.session.session_id);
  assert.equal(resumed.grant.agentKey, oak.grant.agentKey);
  await assert.rejects(() => oak.request("messages"), /authority/);
  const result = await executeLocalSupervisorTool({ provider: "codex", toolName: "read_messages", input: {},
    requestId: "read_1", roomId, apiUrl: origin, bearer: resumed.session.worker_bearer, cwd: environment.tempDir,
    agentSession: { session_id: resumed.session.session_id, agent_key: resumed.grant.agentKey, room_id: roomId } });
  assert.match(JSON.stringify(result.liveResult), /A finished result/);
});


test("local tools preserve task receipts and produce compatible task ownership reads", async () => {
  const roomId = "github.com/example/messages";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "board_contract");
  const execute = async (toolName: string, args: object) => {
    const result = await executeLocalSupervisorTool({ provider: "codex", toolName, input: args,
      requestId: toolName, roomId, apiUrl: origin, bearer: oak.session.worker_bearer, cwd: environment.tempDir,
      agentSession: { session_id: oak.session.session_id, agent_key: oak.grant.agentKey, room_id: roomId } });
    return JSON.parse(result.liveResult.content[0].text);
  };
  const input = { title: "Keep the cloud path working", client_task_id: "one-task" };
  const first = await execute("add_task", input);
  assert.equal((await execute("add_task", input)).task.id, first.task.id);
  await assert.rejects(execute("add_task", { ...input, title: "different" }), /different/);
  const prUrl = "https://github.com/example/messages/pull/1";
  await execute("update_task", { task_id: first.task.id, pr_url: prUrl });
  assert.equal((await execute("update_task", { task_id: first.task.id, status: "accepted" })).task.prUrl, prUrl);
  const { productionSupervisedDeliveryHttp } = await import(new URL("../../daemon/cloud-http.ts", import.meta.url).href);
  const ownership = { apiUrl: origin, roomId, bearer: oak.session.worker_bearer,
    agentSessionId: oak.session.session_id, signal: new AbortController().signal };
  assert.deepEqual(await productionSupervisedDeliveryHttp.ownedTasks!(ownership), []);
  assert.deepEqual(await productionSupervisedDeliveryHttp.ownedTasks!({ ...ownership, taskIds: [first.task.id, "task_missing"] }), []);
  await execute("post_reasoning", { summary: "Checking the cloud regression suite" });
  assert.match(JSON.stringify(await oak.request("messages")), /Checking the cloud regression suite/);
});

test("local saved work is atomic, replayable, and readable while signed out", async () => {
  const roomId = "local_saved_work";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "saved_work");
  const source = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak make a change" });
  const { encodeWorkspaceReview } = await import("../../../../shared/workspace-review.mjs");
  const { WorkspaceReviewSession } = await import("../main/workspace-review.js");
  const { pollDesktopRoomAgentWork } = await import("../main/rooms/agent-work.js");
  const { randomUUID } = await import("node:crypto");
  const snapshot = { captured_at: "2026-09-15T00:00:00.000Z", branch: "feature", base_revision: "a".repeat(40), state: "ready" as const,
    files: [{ path: "hello.ts", previous_path: null, status: "added" as const, additions: 1, deletions: 0, binary: false }],
    additions: 1, deletions: 0, hidden_files: 0,
    patch: "diff --git a/hello.ts b/hello.ts\nnew file mode 100644\n--- /dev/null\n+++ b/hello.ts\n@@ -0,0 +1 @@\n+export const hello = true;\n", patch_truncated: false };
  const full = { version: 1 as const, workspace: snapshot, contribution: snapshot };
  const encoded = encodeWorkspaceReview(full);
  const summary = { version: 3, recorded_state: "completed", evidence_incomplete: false, elapsed_ms: 50,
    operation_counts: { unresolved: 0, succeeded: 1, failed: 0, denied_before_start: 0,
      cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 },
    workspace: snapshot, contribution: { changes: snapshot, summary: "Added hello" } };
  const page = { index: 0, total: 1, digest: encoded.digest, data: encoded.data };
  const publish = (review_page: unknown, revision = 1) => requestLocalSupervisor(
    `${origin}/supervisor-host-grants/${oak.grant.grantId}/worker-sessions/${oak.session.session_id}/agent-work`, {
      method: "POST", headers: { authorization: `Bearer ${oak.grant.supervisorGrant}`, "x-letagents-supervisor-generation": "1" },
      body: JSON.stringify({ room_id: roomId, source_message_id: source.id, revision, summary, review_page }),
    });
  await assert.rejects(publish({ ...page, total: 0 }), /Invalid local work/);
  const before = await pollDesktopRoomAgentWork(roomId);
  assert.equal(before.status, "ready");
  if (before.status === "ready") assert.deepEqual(before.response.snapshot, { work: [], truncated: false });
  const first = await (await publish(page)).json();
  const replay = await (await publish(page)).json();
  assert.equal(replay.status, "replayed");
  assert.deepEqual(replay.work, first.work);
  assert.equal((await publish({ ...page, data: "AAAA" }, 2)).status, 409);
  assert.equal((await publish({ ...page, digest: "b".repeat(64) }, 2)).status, 409);
  const saved = await pollDesktopRoomAgentWork(roomId);
  assert.equal(saved.status, "ready");
  if (saved.status === "ready" && saved.response.changed) assert.equal(saved.response.snapshot.work[0].revision, 1);
  const reader = new WorkspaceReviewSession({ roomId, sourceMessageId: source.id, agentKey: oak.grant.agentKey,
    attemptId: first.work.attempt_id, requestId: randomUUID() }, { databasePath: `${environment.tempDir}/absent-daemon.sqlite` });
  try {
    const opened = await reader.open();
    assert.equal(opened.status, "ready");
    if (opened.status === "ready") assert.equal(opened.review.workspace.files[0].path, "hello.ts");
  } finally { await reader.close(); }
});


test("daemon restart restores local authority and the unread cursor without cloud access", async () => {
  const { join } = await import("node:path");
  const { SupervisorDaemon } = await import(new URL("../../daemon/main.ts", import.meta.url).href);
  const { ManifestStore } = await import(new URL("../../daemon/manifest-store.ts", import.meta.url).href);
  const { productionSupervisedDeliveryHttp } = await import(new URL("../../daemon/cloud-http.ts", import.meta.url).href);
  const roomId = "github.com/example/restart-messages";
  await createLocalRoom({ roomIdentifier: roomId });
  const paths = { lockPath: join(environment.tempDir, "d.lock"), socketPath: join(environment.tempDir, "d.sock"),
    manifestPath: join(environment.tempDir, "daemon.sqlite"), auditPath: join(environment.tempDir, "audit.log"),
    attemptsPath: join(environment.tempDir, "attempts.sqlite"), attemptsRoot: join(environment.tempDir, "attempts"),
    workspaceRoot: join(environment.tempDir, "workspaces") };
  const entry = {
    id: "supervised_restart_regression", room_id: roomId, local_room_id: roomId, display_name: "Oak", provider: "codex",
    model: null, charter: "Check restart", desired_state: "paused", observed_state: "absent", condition: "none",
    permission_profile_id: "read_only", delivery_mode: "daemon_inbox", created_by: "test", created_at: new Date().toISOString(),
  };
  const store = new ManifestStore(paths.manifestPath);
  await store.write(0, [entry]); await store.close();
  let daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const first = await daemon.workerAuthority.mintHostWorkerAuthorization((await daemon.store.getEntry(entry.id))!);
    assert.ok(first);
    await daemon.supervisedInbox.bootstrapCursor({ agent_id: entry.id, room_id: roomId, last_observed_message_id: "msg_0" });
    const message = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak finish this" });
    await daemon.stop(); daemon = new SupervisorDaemon(paths, "darwin"); await daemon.start();
    const resumed = await daemon.workerAuthority.mintHostWorkerAuthorization((await daemon.store.getEntry(entry.id))!);
    assert.ok(resumed);
    assert.equal(resumed.agentSessionId, first.agentSessionId);
    assert.equal(resumed.bearer, first.bearer);
    assert.equal((await daemon.supervisedInbox.cursor(entry.id))?.last_observed_message_id, "msg_0");
    const page = await productionSupervisedDeliveryHttp.poll({ roomId, apiUrl: resumed.apiUrl, bearer: resumed.bearer,
      afterMessageId: "msg_0", signal: new AbortController().signal });
    assert.equal(page.messages[0].id, message.id);
    assert.equal(page.messages[0].activation?.for_current_agent.decision, "activate");
  } finally { await daemon.stop(); }
});

test("local participant and presence metadata uses native observation and revocation", async () => {
  const roomId = "local_presence";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "presence");
  const { readLocalSupervisorPresence } = await import("../main/rooms/local-supervision-authority.js");
  const observed = new Date().toISOString();
  await oak.request(`agent-sessions/${oak.session.session_id}/native-activity`, { method: "POST",
    body: JSON.stringify({ sequence: 1, observed_at: observed, status: "working" }) });
  const live = await readLocalSupervisorPresence(roomId);
  assert.equal(live.participants[0].agentKey, oak.grant.agentKey);
  assert.equal(live.presence[0].status, "working");
  assert.equal(live.presence[0].lastHeartbeatAt, observed);
  await revokeLocalSupervisorEntry(oak.grant.entryId);
  const ended = await readLocalSupervisorPresence(roomId);
  assert.equal(ended.participants[0].activityState, "offline");
  assert.deepEqual(ended.presence, []);
});


test("routing captures names and membership at send time and retains receipt-based human follow-ups", async () => {
  const roomId = "local_durable_routing";
  await createLocalRoom({ roomIdentifier: roomId });
  const old = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak old message" });
  const oak = await worker(roomId, "Oak", "durable_oak");
  const elm = await worker(roomId, "Elm", "durable_elm");
  const ash = await worker(roomId, "Ash", "durable_ash");
  const human = (text: string) => addLocalChatMessage(roomId, { sender: "You", source: "browser", text });
  const directed = await human("@Oak investigate");
  await prepareLocalSupervisorGrant({ entryId: oak.grant.entryId, roomId, displayName: "Maple", provider: "codex" });
  const decision = async (actor: typeof oak, id: string) => (await actor.request("messages")).messages
    .find((message: any) => message.id === id).activation.for_current_agent;
  assert.equal((await decision(oak, old.id)).decision, "silent");
  assert.equal((await decision(oak, directed.id)).decision, "activate");
  assert.equal(getStoredAgentSession(oak.session.session_id)?.display_name, "Maple");
  const followup = await human("Continue with the fix");
  assert.equal((await decision(oak, followup.id)).reason, "recent_conversation");
  for (const other of [elm, ash]) assert.notEqual((await decision(other, followup.id)).decision, "activate");
  await human("@everyone review");
  await elm.request("messages", { method: "POST", body: JSON.stringify({ text: "An observation", client_message_id: "ordinary-post" }) });
  const ambiguous = await human("Continue");
  for (const actor of [oak, elm, ash]) assert.notEqual((await decision(actor, ambiguous.id)).decision, "activate");
  const next = await human("@everyone inspect this too");
  await elm.request("messages", { method: "POST", body: JSON.stringify({ text: "Review completed",
    client_message_id: `supervised-room:${elm.grant.entryId}:${roomId}:${next.id}:reply:v1` }) });
  const last = await human("Continue with that");
  assert.equal((await decision(elm, last.id)).reason, "recent_conversation");
  for (const threaded of [false, true]) {
    const request = await human("@everyone inspect the quoted issue");
    await elm.request("messages", { method: "POST", body: JSON.stringify({ text: "Exact answer",
      client_message_id: `quoted-${threaded}`, reply_to: request.id,
      ...(threaded ? { thread_root_id: request.id } : {}) }) });
    const follow = await human("Continue with that answer");
    assert.equal((await decision(elm, follow.id)).reason, "recent_conversation");
    assert.notEqual((await decision(oak, follow.id)).decision, "activate");
  }
  const { addLocalChatMessage: addMcpMessage } = await import(new URL("../../../../src/mcp/local-state/local-chat.ts", import.meta.url).href);
  const external = await addMcpMessage(roomId, { sender: "Existing agent", source: "agent", text: "@Maple review",
    publisher_agent_key: "local/existing", publisher_agent_session_id: "local_existing_session" });
  await prepareLocalSupervisorGrant({ entryId: oak.grant.entryId, roomId, displayName: "Birch", provider: "codex" });
  assert.equal((await decision(oak, external.id)).reason, "explicit_mention");
});

test("a concurrent thread correction retries the entire send before persisting recipients", async () => {
  const roomId = "local_concurrent_routing";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "concurrent_oak");
  const elm = await worker(roomId, "Elm", "concurrent_elm");
  const root = await oak.request("messages", { method: "POST", body: JSON.stringify({ text: "Thread origin", client_message_id: "root" }) });
  const thread = { sender: "You", source: "browser", text: "Continue in this thread", reply_to: root.id, thread_root_id: root.id };
  await addLocalChatMessage(roomId, thread);
  const rootNumber = Number(root.id.slice(4));
  const { spawn } = await import("node:child_process");
  // The second writer invalidates the projection after the sender's repair,
  // but before the sender can acquire its write transaction.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB);
    db.exec('BEGIN IMMEDIATE');
    console.log('locked');
    await new Promise(resolve => setTimeout(resolve, 180));
    db.prepare('UPDATE local_chat_messages SET sender=?,publisher_agent_key=? WHERE room_id=? AND number=?')
      .run(${JSON.stringify(elm.session.actor_label)},${JSON.stringify(elm.grant.agentKey)},${JSON.stringify(roomId)},${rootNumber});
    db.prepare('INSERT INTO local_chat_thread_routing_invalidated_roots_v2(room_id,thread_root_number,cleanup_completed) VALUES(?,?,0)')
      .run(${JSON.stringify(roomId)},${rootNumber});
    db.prepare('DELETE FROM local_chat_thread_routing_root_state_v2 WHERE room_id=? AND thread_root_number=?')
      .run(${JSON.stringify(roomId)},${rootNumber});
    db.exec('COMMIT'); db.close();
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
  const sent = await addLocalChatMessage(roomId, thread);
  assert.equal(await exited, 0);
  const activation = async (actor: typeof oak) => (await actor.request("messages")).messages
    .find((message: any) => message.id === sent.id).activation.for_current_agent;
  assert.notEqual((await activation(oak)).decision, "activate");
  assert.equal((await activation(elm)).reason, "thread_participant");
  const messages = (await getLocalChatMessages(roomId)).messages;
  assert.equal(messages.length, 3, "rollback cannot leave a duplicate send");
  assert.equal(sent.id, `msg_${rootNumber + 2}`, "rollback cannot consume the message sequence");
});
