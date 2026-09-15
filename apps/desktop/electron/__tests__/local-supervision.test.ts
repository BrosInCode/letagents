import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createElectronTestEnv } from "./harness.js";

const environment = createElectronTestEnv({ prefix: "local-supervision-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"],
  extraEnvFiles: { LETAGENTS_LOCAL_FILES_DIR: "files" } });
const { createLocalRoom, addLocalTask, updateLocalTask, getLocalTask, getLocalTaskDatabase } = await import("../main/rooms/local-store.js");
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
  const tool = async (toolName: string, args: object) => {
    const result = await executeLocalSupervisorTool({ provider: "codex", toolName, input: args,
      requestId: randomUUID(), roomId, apiUrl: origin, bearer: session.worker_bearer, cwd: environment.tempDir,
      agentSession: { session_id: session.session_id, agent_key: grant.agentKey, room_id: roomId } });
    return JSON.parse(result.liveResult.content[0].text);
  };
  const owned = async (extra: { heldBefore?: string; taskIds?: string[] } = {}) => {
    const { productionSupervisedDeliveryHttp } = await import(new URL("../../daemon/cloud-http.ts", import.meta.url).href);
    return productionSupervisedDeliveryHttp.ownedTasks!({ apiUrl: origin, roomId, bearer: session.worker_bearer,
      agentSessionId: session.session_id, signal: new AbortController().signal, ...extra });
  };
  return { grant, session, request, mint, tool, owned };
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

test("local work claims have one owner and retries preserve exact lease identity", async () => {
  const roomId = "local_work_claims";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "work_claim_oak");
  const elm = await worker(roomId, "Elm", "work_claim_elm");
  const task = await addLocalTask(roomId, { title: "One owner" });
  await assert.rejects(oak.tool("claim_task", { task_id: task.id }), /accepted/);
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  const results = await Promise.allSettled([oak, elm].map(actor => actor.tool("claim_task", { task_id: task.id })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = results[0].status === "fulfilled" ? oak : elm;
  const loser = winner === oak ? elm : oak;
  const first = (await winner.request(`tasks/${task.id}`)).active_leases[0];
  assert.equal(first.agent_session_id, winner.session.session_id);
  assert.equal(first.kind, "work");
  assert.equal(first.epoch, 0);
  await winner.tool("update_task", { task_id: task.id, status: "in_progress" });
  const replay = await winner.tool("claim_task", { task_id: task.id });
  assert.equal(replay.task.status, "in_progress");
  assert.deepEqual(replay.lease, first);
  assert.deepEqual(await winner.owned(), [{ id: task.id, title: task.title, leaseId: first.id, epoch: 0 }]);
  assert.deepEqual(await loser.owned(), []);
  assert.deepEqual(await winner.owned({ heldBefore: new Date(Date.parse(first.created_at) - 1).toISOString() }), []);
  await assert.rejects(loser.tool("update_task", { task_id: task.id, status: "in_review" }), /another worker/);
  assert.equal((await getLocalTask(roomId, task.id))?.status, "in_progress");
  await winner.tool("complete_task", { task_id: task.id });
  assert.deepEqual(await winner.owned(), [], "review work cannot authorize failed-turn continuation");
});

test("separate local writers racing to claim a task create exactly one work lease", async () => {
  const roomId = "local_work_process_race";
  await createLocalRoom({ roomIdentifier: roomId });
  const actors = await Promise.all([worker(roomId, "Oak", "race_oak"), worker(roomId, "Elm", "race_elm")]);
  const task = await addLocalTask(roomId, { title: "Claim across processes" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  const { spawn } = await import("node:child_process");
  const moduleUrl = new URL("../main/rooms/local-store.ts", import.meta.url).href;
  const children = actors.map(actor => {
    const identity = { agent_key: actor.grant.agentKey, session_id: actor.session.session_id,
      actor_label: actor.session.actor_label, agent_instance_id: `daemon:${actor.grant.entryId}`, supervised: true };
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const { claimLocalTaskWorkLease, getLocalTaskDatabase } = await import(${JSON.stringify(moduleUrl)});
      await getLocalTaskDatabase();
      process.stdout.write('ready');
      await new Promise(resolve => process.stdin.once('data', resolve));
      try { await claimLocalTaskWorkLease(${JSON.stringify(roomId)}, ${JSON.stringify(task.id)}, ${JSON.stringify(identity)}); }
      catch (error) { process.stderr.write(String(error)); process.exitCode = 2; }
      process.stdin.destroy();
    `], { stdio: ["pipe", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", chunk => { errors += String(chunk); });
    return { child, ready: new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve()); child.once("error", reject);
    }), done: new Promise<number | null>((resolve, reject) => {
      child.once("exit", code => resolve(code)); child.once("error", reject);
    }), errors: () => errors };
  });
  try {
    await Promise.all(children.map(child => child.ready));
    for (const { child } of children) child.stdin.end("claim");
    const codes = await Promise.all(children.map(child => child.done));
    assert.deepEqual(codes.slice().sort(), [0, 2], children.map(child => child.errors()).join("\n"));
    assert.equal((await Promise.all(actors.map(actor => actor.owned()))).flat().length, 1);
    assert.equal((await getLocalTask(roomId, task.id))?.activeLeases.length, 1);
  } finally { for (const { child } of children) if (child.exitCode === null) child.kill(); }
});

test("assigning through update_task creates a lease and task artifact mutations commit atomically", async () => {
  const roomId = "local_work_artifacts";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "work_artifacts_oak");
  const elm = await worker(roomId, "Elm", "work_artifacts_elm");
  const task = await addLocalTask(roomId, { title: "Atomic task artifacts" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  const assigned = await oak.tool("update_task", { task_id: task.id, status: "assigned" });
  assert.equal(assigned.task.assigneeAgentKey, oak.grant.agentKey);
  assert.equal((await oak.owned()).length, 1);
  await oak.tool("update_task", { task_id: task.id, status: "in_progress" });
  const artifact = { provider: "git", kind: "branch", ref: "codex/local-work", title: "Original" };
  await oak.tool("update_task", { task_id: task.id, workflow_artifacts: [artifact] });
  const db = await getLocalTaskDatabase();
  db.exec(`CREATE TRIGGER fail_task_artifact_for_test BEFORE INSERT ON local_room_artifacts
    WHEN NEW.title='Reject this write' BEGIN SELECT RAISE(ABORT,'injected artifact failure'); END`);
  try {
    await assert.rejects(oak.tool("update_task", { task_id: task.id, status: "in_review",
      workflow_artifacts: [{ ...artifact, title: "Reject this write" }] }), /injected artifact failure/);
    const saved = await getLocalTask(roomId, task.id);
    assert.equal(saved?.status, "in_progress");
    assert.deepEqual(saved?.workflowArtifacts, [artifact]);
  } finally { db.exec("DROP TRIGGER fail_task_artifact_for_test"); }
  await oak.tool("handoff_task_lease", { task_id: task.id, target_agent_key: elm.grant.agentKey });
  await assert.rejects(oak.tool("publish_room_artifact", { task_id: task.id, artifact }), /another worker/);
  await assert.rejects(oak.tool("publish_room_artifact", { artifact }), /another worker/,
    "omitting task_id must not bypass checks on an already linked artifact");
  const published = await elm.tool("publish_room_artifact", { task_id: task.id, artifact: { ...artifact, title: "Successor" } });
  assert.equal(published.artifact.title, "Successor");
});

test("local lease handoff, release, completion, and stale epochs stop the old owner", async () => {
  const roomId = "local_work_handoff";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "work_handoff_oak");
  const elm = await worker(roomId, "Elm", "work_handoff_elm");
  const task = await addLocalTask(roomId, { title: "Hand off existing work" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  const first = await oak.tool("claim_task", { task_id: task.id });
  await oak.tool("update_task", { task_id: task.id, status: "in_progress" });
  await assert.rejects(oak.tool("release_task_lease", { task_id: task.id, lease_id: first.lease.id, epoch: 1 }), /changed/);
  await assert.rejects(elm.tool("release_task_lease", { task_id: task.id, lease_id: first.lease.id }), /current worker/);
  await assert.rejects(oak.tool("handoff_task_lease", { task_id: task.id, target_agent_key: "missing" }), /active local worker/);
  assert.equal((await oak.owned()).length, 1);
  const handoff = await oak.tool("handoff_task_lease", { task_id: task.id, lease_id: first.lease.id,
    target_agent_key: elm.grant.agentKey, target_agent_session_id: elm.session.session_id });
  assert.equal(handoff.released_lease.id, first.lease.id);
  assert.equal(handoff.new_lease.epoch, 1);
  assert.notEqual(handoff.new_lease.id, first.lease.id);
  assert.deepEqual(await oak.owned(), []);
  assert.equal((await elm.owned())[0].leaseId, handoff.new_lease.id);
  await assert.rejects(oak.tool("update_task", { task_id: task.id, pr_url: "https://example.com/stale" }), /another worker/);
  await assert.rejects(elm.tool("release_task_lease", { task_id: task.id, lease_id: first.lease.id }), /changed/);
  const released = await elm.tool("release_task_lease", { task_id: task.id, lease_id: handoff.new_lease.id });
  assert.equal(released.task.status, "accepted");
  assert.equal(released.task.assigneeAgentKey, null);
  assert.deepEqual(await elm.owned(), []);
  const reclaimed = await elm.tool("claim_task", { task_id: task.id });
  assert.equal(reclaimed.lease.epoch, 2);
  const { assertLocalTaskLeaseMutation } = await import("../../../../shared/local-work-leases.mjs");
  const db = await getLocalTaskDatabase();
  const row = db.prepare("SELECT * FROM local_tasks WHERE room_id=? AND task_id=?").get(roomId, task.id)!;
  assert.throws(() => assertLocalTaskLeaseMutation(db, row, { agent_key: elm.grant.agentKey,
    session_id: elm.session.session_id, actor_label: "Elm", supervised: true }, handoff.new_lease), /lease changed/);
  await elm.tool("update_task", { task_id: task.id, status: "in_progress" });
  await elm.tool("update_task", { task_id: task.id, status: "done" });
  assert.deepEqual(await elm.owned(), []);
  assert.equal((await getLocalTask(roomId, task.id))?.activeLeases.length, 0);
});

test("local assignments do not acquire authority without a claim and native heartbeat cannot revive ended ownership", async () => {
  const roomId = "local_work_authority";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "work_authority");
  const task = await addLocalTask(roomId, { title: "Retained task" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  await updateLocalTask(roomId, task.id, { status: "assigned", assignee: oak.session.actor_label, assigneeAgentKey: oak.grant.agentKey });
  assert.deepEqual(await oak.owned(), [], "legacy assignment is not execution authority");
  await assert.rejects(oak.tool("update_task", { task_id: task.id, status: "in_progress" }), /work lease/);
  const claim = await oak.tool("claim_task", { task_id: task.id });
  const heartbeat = await oak.request(`agent-sessions/${oak.session.session_id}/native-activity`, {
    method: "POST", body: JSON.stringify({ sequence: 1, observed_at: "2099-01-01T00:00:00Z", status: "working" }),
  });
  assert.deepEqual(heartbeat.lease_heartbeats, [{ id: claim.lease.id, epoch: 0 }]);
  const lease = (await oak.request(`tasks/${task.id}`)).active_leases[0];
  assert.ok(Date.parse(lease.last_heartbeat_at) < Date.parse("2099-01-01"), "lease heartbeat uses local receipt time");
  const duplicate = await oak.request(`agent-sessions/${oak.session.session_id}/native-activity`, {
    method: "POST", body: JSON.stringify({ sequence: 1, observed_at: "2099-01-01T00:00:00Z", status: "working" }),
  });
  assert.equal(duplicate.accepted, false);
  assert.deepEqual(duplicate.lease_heartbeats, []);
  await revokeLocalSupervisorEntry(oak.grant.entryId);
  const resumed = await worker(roomId, "Oak", "work_authority");
  assert.deepEqual(await resumed.owned(), []);
  await assert.rejects(oak.tool("update_task", { task_id: task.id, status: "in_progress" }), /authority/);
  const newClaim = await resumed.tool("claim_task", { task_id: task.id });
  assert.equal(newClaim.lease.epoch, 1);
  assert.notEqual(newClaim.lease.id, claim.lease.id);
  assert.equal(newClaim.lease.agent_session_id, resumed.session.session_id);
  await revokeLocalSupervisorEntry(resumed.grant.entryId);
  const { withWorkerCall } = await import(new URL("../../../../src/mcp/worker-call-context.ts", import.meta.url).href);
  const mcp = await import(new URL("../../../../src/mcp/local-state/local-chat.ts", import.meta.url).href);
  await assert.rejects(withWorkerCall({ ...getStoredAgentSession(resumed.session.session_id), ended_at: null },
    () => mcp.updateLocalTask(roomId, task.id, { pr_url: "https://example.com/stale" })), /authority ended/);
  assert.equal((await getLocalTask(roomId, task.id))?.prUrl, null);
});

test("MCP supervised claims establish exact ownership and missing leases cannot authorize progress", async () => {
  const roomId = "local_work_mcp_claim";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "mcp_claim");
  const task = await addLocalTask(roomId, { title: "MCP ownership" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  await updateLocalTask(roomId, task.id, { status: "assigned", assignee: oak.session.actor_label, assigneeAgentKey: oak.grant.agentKey });
  const { withWorkerCall } = await import(new URL("../../../../src/mcp/worker-call-context.ts", import.meta.url).href);
  const mcp = await import(new URL("../../../../src/mcp/local-state/local-chat.ts", import.meta.url).href);
  const call = (patch: object) => withWorkerCall(getStoredAgentSession(oak.session.session_id),
    () => mcp.updateLocalTask(roomId, task.id, patch));
  await assert.rejects(call({ status: "in_progress" }), /work lease/);
  const claimed = await call({ status: "assigned", assignee: oak.session.actor_label, assignee_agent_key: oak.grant.agentKey });
  assert.equal(claimed.active_leases.length, 1);
  assert.equal(claimed.active_leases[0].agent_session_id, oak.session.session_id);
  assert.equal(claimed.assignee_agent_session_id, oak.session.session_id);
  await call({ status: "in_progress" });
  const retry = await call({ status: "assigned", assignee_agent_key: oak.grant.agentKey });
  assert.equal(retry.status, "in_progress");
  assert.equal(retry.active_leases[0].id, claimed.active_leases[0].id);
  await assert.rejects(call({ assignee_agent_key: oak.grant.agentKey, assignee_agent_session_id: "another-session" }), /ownership/);
  assert.equal((await oak.owned())[0].leaseId, claimed.active_leases[0].id);
});

test("legacy desktop and MCP assignments remain lease-free when their sessions end", async () => {
  const roomId = "local_work_legacy_compatibility";
  await createLocalRoom({ roomIdentifier: roomId });
  const { saveAgentSession, markAgentSessionEnded } = await import("../main/agents/state.js");
  const identity = saveAgentSession({ session_id: "legacy-work-session", session_token: "local-test",
    room_id: roomId, session_kind: "worker", runtime: "codex:test", actor_label: "Legacy",
    agent_key: "local/legacy", agent_instance_id: "desktop-codex:legacy", display_name: "Legacy",
    owner_label: "Local QA", ide_label: "Codex", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const desktop = await addLocalTask(roomId, { title: "Legacy desktop task" });
  await updateLocalTask(roomId, desktop.id, { status: "accepted" });
  await updateLocalTask(roomId, desktop.id, { status: "assigned", assignee: identity.actor_label,
    assigneeAgentKey: identity.agent_key }, { ...identity, agent_key: identity.agent_key!, actor_label: identity.actor_label! });
  assert.deepEqual((await getLocalTask(roomId, desktop.id))?.activeLeases, []);
  const artifact = { provider: "git", kind: "branch", ref: "codex/legacy-work", title: "Legacy work",
    id: null, number: null, url: null, state: null };
  const published = await updateLocalTask(roomId, desktop.id, { status: "in_progress", workflowArtifacts: [artifact] },
    { ...identity, agent_key: identity.agent_key!, actor_label: identity.actor_label! });
  assert.deepEqual(published.workflowArtifacts, [artifact]);
  assert.deepEqual(published.activeLeases, []);
  const { withWorkerCall } = await import(new URL("../../../../src/mcp/worker-call-context.ts", import.meta.url).href);
  const mcp = await import(new URL("../../../../src/mcp/local-state/local-chat.ts", import.meta.url).href);
  const external = await addLocalTask(roomId, { title: "Legacy MCP task" });
  await updateLocalTask(roomId, external.id, { status: "accepted" });
  const assigned = await withWorkerCall(identity, () => mcp.updateLocalTask(roomId, external.id,
    { status: "assigned", assignee: identity.actor_label, assignee_agent_key: identity.agent_key }));
  assert.deepEqual(assigned.active_leases, []);
  const progressed = await withWorkerCall(identity, () => mcp.updateLocalTask(roomId, external.id, { status: "in_progress" }));
  assert.equal(progressed.status, "in_progress");
  markAgentSessionEnded(identity.session_id);
  const db = await getLocalTaskDatabase();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_work_leases WHERE agent_session_id=?").get(identity.session_id)?.count, 0);
});

test("desktop and MCP readers share local leases and legacy writes cannot leave stale ownership", async () => {
  const roomId = "local_work_shared_store";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "work_shared");
  const task = await addLocalTask(roomId, { title: "Shared local ownership" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  const claim = await oak.tool("claim_task", { task_id: task.id });
  const mcp = await import(new URL("../../../../src/mcp/local-state/local-chat.ts", import.meta.url).href);
  assert.equal((await mcp.getLocalTask(roomId, task.id)).active_leases[0].id, claim.lease.id);
  await assert.rejects(mcp.updateLocalTask(roomId, task.id, { status: "in_progress" }), /owning worker/);
  await updateLocalTask(roomId, task.id, { assignee: "Someone else", assigneeAgentKey: "local/another" });
  assert.deepEqual(await oak.owned(), []);
  assert.deepEqual((await mcp.getLocalTask(roomId, task.id)).active_leases, []);
});

test("a legacy release observed before a new claim cannot revoke its successor", async () => {
  const roomId = "local_work_legacy_release";
  await createLocalRoom({ roomIdentifier: roomId });
  const oak = await worker(roomId, "Oak", "legacy_release");
  const task = await addLocalTask(roomId, { title: "Keep the successor lease" });
  await updateLocalTask(roomId, task.id, { status: "accepted" });
  const first = await oak.tool("claim_task", { task_id: task.id });
  await oak.tool("release_task_lease", { task_id: task.id });
  assert.deepEqual((await getLocalTask(roomId, task.id))?.activeLeases, []);
  // The legacy action observed no active lease, then another writer won a claim.
  const successor = await oak.tool("claim_task", { task_id: task.id });
  await assert.rejects(updateLocalTask(roomId, task.id, { status: "accepted", assignee: null,
    assigneeAgentKey: null, validateStatus: false, expectedNoWorkLease: true }), /lease changed/);
  const mcp = await import(new URL("../../../../src/mcp/local-state/local-chat.ts", import.meta.url).href);
  await assert.rejects(mcp.updateLocalTask(roomId, task.id, { status: "accepted", skip_transition_validation: true,
    assignee: null, assignee_agent_key: null, expected_no_work_lease: true }), /lease changed/);
  const { updateDesktopRoomTaskLease } = await import("../main/rooms/tasks.js");
  await assert.rejects(updateDesktopRoomTaskLease(roomId, task.id, { action: "release", lease_id: first.lease.id }), /lease changed/);
  assert.equal((await oak.owned())[0].leaseId, successor.lease.id);
});

test("local leased task recovery survives restart and obeys the existing cloud continuation fences", async () => {
  const { SupervisedAgentInboxStore } = await import(new URL("../../daemon/supervised-agent-inbox-store.ts", import.meta.url).href);
  const { SupervisedAgentDelivery } = await import(new URL("../../daemon/supervised-agent-delivery.ts", import.meta.url).href);
  const { productionSupervisedDeliveryHttp } = await import(new URL("../../daemon/cloud-http.ts", import.meta.url).href);
  for (const scenario of ["continue", "completed", "handoff", "replacement", "normal_reply"] as const) {
    const roomId = `local_continuity_${scenario}`;
    await createLocalRoom({ roomIdentifier: roomId });
    let owner = await worker(roomId, "Oak", `continuity_${scenario}`);
    const task = await addLocalTask(roomId, { title: "Finish the existing local task" });
    await updateLocalTask(roomId, task.id, { status: "accepted" });
    const claimed = await owner.tool("claim_task", { task_id: task.id });
    await owner.tool("update_task", { task_id: task.id, status: "in_progress" });
    const source = await addLocalChatMessage(roomId, { sender: "You", source: "browser", text: "@Oak finish this task" });
    const path = `${environment.tempDir}/continuity-${scenario}.sqlite`;
    let store = new SupervisedAgentInboxStore(path);
    const connection = { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-birth" };
    const handle = { workAttemptId: "attempt", providerContinuationId: "thread", pid: 1, providerConnection: connection, observedState: "working" };
    const agent = () => ({ agentId: owner.grant.entryId, roomId, apiUrl: origin, provider: "codex", deliveryMode: "daemon_inbox",
      agentSessionId: owner.session.session_id, bearer: owner.session.worker_bearer, handle, providerConnection: connection,
      executionGenerationId: "generation-1", daemonGeneration: 1, workAttemptId: "attempt", providerContinuationId: "thread" });
    let nativeStarts = 0;
    let delivery: InstanceType<typeof SupervisedAgentDelivery>;
    const port = (run: (handle: any, request: any, options: any) => Promise<any>) => ({
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true,
        permissionPromptBridging: false, survivesRestart: true, turnControl: "unsupported", continuationRepair: "unsupported" }),
      spawn: async () => { throw new Error("unexpected spawn"); }, attach: async () => null,
      attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unexpected resume"); },
      poke: async () => {}, stop: async () => ({}), onExit: async () => () => {}, runRoomTurn: run,
      recoverRoomTurn: async () => { throw new Error("A durably failed turn must not replay."); },
    });
    delivery = new SupervisedAgentDelivery(store, port(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.(); nativeStarts++;
      await options?.checkpointTurnStarted?.("failed-turn");
      const terminal = { turnId: "failed-turn", providerContinuationId: "thread",
        outcome: scenario === "normal_reply" ? "reply" : "failed", text: scenario === "normal_reply" ? "Done for now" : null,
        evidence: "stream", error: scenario === "normal_reply" ? undefined : "HTTP 503 Service Unavailable" };
      await options?.checkpointTerminalResult?.(terminal);
      delivery.fence();
      return terminal;
    }), productionSupervisedDeliveryHttp, async () => true, 0);
    try {
      await store.ingestPoll({ agent_id: owner.grant.entryId, room_id: roomId, last_observed_message_id: source.id,
        messages: [{ source_message_id: source.id, source_message: source, activation: {} }] });
      await delivery.pump(agent());
      await delivery.fenceAndDrain(); await store.close();
      assert.equal((await owner.mint()).session_id, owner.session.session_id);
      assert.equal((await owner.owned())[0].leaseId, claimed.lease.id);
      if (scenario === "completed") await owner.tool("update_task", { task_id: task.id, status: "done" });
      if (scenario === "handoff") {
        const other = await worker(roomId, "Elm", "continuity_target");
        await owner.tool("handoff_task_lease", { task_id: task.id, target_agent_key: other.grant.agentKey });
      }
      if (scenario === "replacement") {
        await revokeLocalSupervisorEntry(owner.grant.entryId);
        owner = await worker(roomId, "Oak", `continuity_${scenario}`);
        await owner.tool("claim_task", { task_id: task.id });
      }
      store = new SupervisedAgentInboxStore(path);
      delivery = new SupervisedAgentDelivery(store, port(async (_handle, request, options) => {
        await options?.beforeNativeDispatch?.(); nativeStarts++;
        assert.equal(scenario, "continue", "only the unchanged owner may continue failed work");
        assert.match(JSON.stringify(request.sourceMessage), /existing authorized work/);
        await options?.checkpointTurnStarted?.("continuation-turn");
        await owner.tool("update_task", { task_id: task.id, status: "done" });
        return { turnId: "continuation-turn", outcome: "reply", text: "LOCAL_TASK_RECOVERED" };
      }), productionSupervisedDeliveryHttp, async () => true, 0);
      await delivery.pump({ ...agent(), executionGenerationId: "generation-2", daemonGeneration: 2 });
      await delivery.pump({ ...agent(), executionGenerationId: "generation-2", daemonGeneration: 2 });
      assert.equal(nativeStarts, scenario === "continue" ? 2 : 1, scenario);
      assert.equal((await store.cursor(owner.grant.entryId)).last_observed_message_id, source.id);
      if (scenario === "continue") {
        assert.equal((await getLocalTask(roomId, task.id))?.status, "done");
        assert.equal((await getLocalChatMessages(roomId)).messages.filter(message => message.text === "LOCAL_TASK_RECOVERED").length, 1);
      }
    } finally { await delivery.fenceAndDrain(); await store.close(); }
  }
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
