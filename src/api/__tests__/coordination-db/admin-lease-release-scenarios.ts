import assert from "node:assert/strict";
import test from "node:test";

import {
  bayActor,
  buildTaskRouteClient,
  createOwnerAuth,
  createWorkerPair,
  databaseTestOptions,
  dbApi,
  dawnActor,
  pool,
  startApiServer,
  stopChildProcess,
} from "./harness.js";

type Request = { id: string; version: number; source_message_id: string; response: { body: string; actor: { id: string; kind: string }; closed?: true } | null };

test(
  "a room admin's release from the app clears a lease and answers the requests that asked for it",
  databaseTestOptions,
  async (t) => {
    const { assignProjectAdmin, createProjectWithName, createSession, createTask, getActiveTaskLeases, updateTask } = dbApi;
    if (!assignProjectAdmin || !createProjectWithName || !createSession || !createTask || !getActiveTaskLeases || !updateTask) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({
      githubUserId: "252",
      token: "coordination-admin-release-owner-token",
    });
    const adminSession = "coordination-admin-release-session-token";
    await createSession(owner.id, adminSession, new Date(Date.now() + 60 * 60_000).toISOString(), "owner-github-token");
    const room = await createProjectWithName("coordination-admin-lease-release");
    await assignProjectAdmin(room.id, owner.id);
    const { bayCredentials, dawnCredentials } = await createWorkerPair({ roomId: room.id, ownerAccountId: owner.id, ownerLabel });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });
    const { leaseAction, patchTask, reviewLeaseAction } = buildTaskRouteClient({ port, roomId: room.id, ownerToken });
    const attention = `http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}/attention`;
    const ask = async (clientId: string, body: string, credentials: Record<string, string>) => {
      const response = await fetch(attention, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ client_id: clientId, category: "approval", title: "Room admin needed", body, ...credentials }),
      });
      assert.equal(response.status, 201, await response.text());
    };
    const requests = async () => {
      const response = await fetch(attention, { headers: { Cookie: `letagents_session=${adminSession}` } });
      assert.equal(response.status, 200);
      return new Map(((await response.json()).records as Request[]).map((record) => [record.id, record]));
    };

    // BayOtter does the work and submits it; DawnWinter takes the review.
    const task = await createTask(room.id, "Keyboard shortcuts", "Human");
    await updateTask(room.id, task.id, { status: "accepted" });
    const claim = await patchTask(task.id, {
      status: "assigned", assignee: bayActor.actor_label, assignee_agent_key: bayActor.actor_key, ...bayActor, ...bayCredentials,
    });
    assert.equal(claim.status, 200);
    assert.equal((await patchTask(task.id, { status: "in_review", ...bayActor, ...bayCredentials })).status, 200);
    const reviewClaim = await reviewLeaseAction(task.id, { action: "claim", ...dawnActor, ...dawnCredentials });
    assert.equal(reviewClaim.status, 200);
    const reviewLeaseId = (await reviewClaim.json()).lease.id as string;
    const workLeaseId = (await getActiveTaskLeases(room.id, task.id)).find((lease) => lease.kind === "work")!.id;

    // Each agent asks the owner to clear a lease it cannot clear itself.
    await ask("dawnwinter-stale-review-lease", `Release review lease ${reviewLeaseId} on ${task.id}; its session ended.`, dawnCredentials);
    await ask("bayotter-stale-work-lease", `Release work lease ${workLeaseId} on ${task.id}.`, bayCredentials);
    await ask("dawnwinter-other-request", "Which reviewer should take the next task?", dawnCredentials);
    await ask("dawnwinter-both-leases", `Release ${reviewLeaseId} and ${workLeaseId} so ${task.id} can be reassigned.`, dawnCredentials);

    // The owner clears the review lease from the task panel.
    const releasedReview = await reviewLeaseAction(task.id, { action: "release", lease_id: reviewLeaseId }, { sessionToken: adminSession });
    assert.equal(releasedReview.status, 200, await releasedReview.clone().text());
    assert.equal((await releasedReview.json()).released_lease.id, reviewLeaseId);
    let open = await requests();
    assert.equal(open.get("dawnwinter-stale-review-lease")?.response?.body, `Released the review lease ${reviewLeaseId} on ${task.id}.`);
    assert.deepEqual(open.get("dawnwinter-stale-review-lease")?.response?.actor.kind, "human");
    assert.equal(open.get("dawnwinter-stale-review-lease")?.response?.actor.id, owner.id);
    assert.equal(open.get("bayotter-stale-work-lease")?.response, null, "a request about another lease stays open");
    assert.equal(open.get("dawnwinter-other-request")?.response, null);
    assert.equal(open.get("dawnwinter-both-leases")?.response, null, "a request naming a lease still held stays open");

    // And the work lease.
    const releasedWork = await leaseAction(task.id, { action: "release", lease_id: workLeaseId }, { sessionToken: adminSession });
    assert.equal(releasedWork.status, 200, await releasedWork.clone().text());
    open = await requests();
    assert.equal(open.get("bayotter-stale-work-lease")?.response?.body, `Released the work lease ${workLeaseId} on ${task.id}.`);
    assert.equal(open.get("dawnwinter-both-leases")?.response?.body, `Released the work lease ${workLeaseId} on ${task.id}.`,
      "answered once every lease it names is released");
    assert.equal(open.get("dawnwinter-other-request")?.response, null);
    assert.deepEqual(await getActiveTaskLeases(room.id, task.id), []);

    // An agent releasing its own lease answers nothing: only a person can.
    const second = await createTask(room.id, "Session log", "Human");
    await updateTask(room.id, second.id, { status: "accepted" });
    assert.equal((await patchTask(second.id, {
      status: "assigned", assignee: bayActor.actor_label, assignee_agent_key: bayActor.actor_key, ...bayActor, ...bayCredentials,
    })).status, 200);
    const ownLeaseId = (await getActiveTaskLeases(room.id, second.id)).find((lease) => lease.kind === "work")!.id;
    await ask("bayotter-own-lease", `Should I let go of ${ownLeaseId}?`, bayCredentials);
    const releasedOwn = await leaseAction(second.id, { action: "release", lease_id: ownLeaseId, ...bayActor, ...bayCredentials });
    assert.equal(releasedOwn.status, 200, await releasedOwn.clone().text());
    assert.equal((await requests()).get("bayotter-own-lease")?.response, null);
  },
);

test(
  "a request shows once in its room; a person can close it; a room admin retiring an agent closes only its open requests",
  databaseTestOptions,
  async (t) => {
    const { assignProjectAdmin, createProjectWithName, createSession } = dbApi;
    if (!assignProjectAdmin || !createProjectWithName || !createSession || !pool) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }
    const { owner, ownerLabel, ownerToken } = await createOwnerAuth({ githubUserId: "352", token: "coordination-retire-owner-token" });
    const adminSession = "coordination-retire-admin-session-token";
    await createSession(owner.id, adminSession, new Date(Date.now() + 60 * 60_000).toISOString(), "owner-github-token");
    const room = await createProjectWithName("coordination-retire-requests");
    await assignProjectAdmin(room.id, owner.id);
    const { bayCredentials, dawnCredentials } = await createWorkerPair({ roomId: room.id, ownerAccountId: owner.id, ownerLabel });
    const { child, port } = await startApiServer();
    t.after(async () => { await stopChildProcess(child); });

    const base = `http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}`;
    const asAdmin = { "Content-Type": "application/json", Cookie: `letagents_session=${adminSession}` };
    const asAgent = { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` };
    const ask = (clientId: string, body: string, credentials: Record<string, string>) => fetch(`${base}/attention`, {
      method: "POST", headers: asAgent,
      body: JSON.stringify({ client_id: clientId, category: "question", title: "Which port?", body, ...credentials }),
    });
    const requests = async () => {
      const response = await fetch(`${base}/attention`, { headers: asAdmin });
      assert.equal(response.status, 200);
      return new Map(((await response.json()).records as Request[]).map((record) => [record.id, record]));
    };
    const roomMessages = async () => (await pool.query<{ number: number; text: string; sender: string; source: string; publisher_agent_key: string | null; reply_to_number: number | null }>(
      "SELECT number, text, sender, source, publisher_agent_key, reply_to_number FROM messages WHERE room_id = $1 ORDER BY number", [room.id])).rows;

    // The request is shown in the room once, however often the agent retries.
    assert.equal((await ask("bay-open-1", "Pick 80 or 443.", bayCredentials)).status, 201);
    assert.equal((await ask("bay-open-1", "Pick 80 or 443.", bayCredentials)).status, 201);
    assert.equal((await ask("bay-open-1", "Something else.", bayCredentials)).status, 409);
    let notices = (await roomMessages()).filter((message) => message.text.startsWith("Needs you"));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].text, "Needs you · Question: Which port?\n\nPick 80 or 443.\n\nWaiting for an answer in Inbox (bay-open-1).");
    assert.deepEqual([notices[0].sender, notices[0].source, notices[0].publisher_agent_key], [bayActor.actor_label, "agent", bayActor.actor_key]);
    assert.equal((await requests()).get("bay-open-1")?.source_message_id, `msg_${notices[0].number}`);

    for (const [id, credentials] of [["bay-open-2", bayCredentials], ["bay-answered", bayCredentials], ["dawn-open", dawnCredentials], ["dawn-closed", dawnCredentials]] as const) {
      assert.equal((await ask(id, "Pick one.", credentials)).status, 201);
    }
    const answer = await fetch(`${base}/attention/bay-answered/respond`, { method: "POST", headers: asAdmin, body: JSON.stringify({ expected_version: 1, response: "Port 443." }) });
    assert.equal(answer.status, 200, await answer.clone().text());

    // Only a person closes a request; the agent that asked is told in the room.
    const agentClose = await fetch(`${base}/attention/dawn-closed/close`, { method: "POST", headers: asAgent, body: JSON.stringify({ expected_version: 1, ...dawnCredentials }) });
    assert.equal(agentClose.status, 403);
    const close = await fetch(`${base}/attention/dawn-closed/close`, { method: "POST", headers: asAdmin, body: JSON.stringify({ expected_version: 1 }) });
    assert.equal(close.status, 200, await close.clone().text());
    assert.deepEqual(((await close.json()).record as Request).response?.closed, true);
    assert.equal((await fetch(`${base}/attention/dawn-closed/close`, { method: "POST", headers: asAdmin, body: JSON.stringify({ expected_version: 2 }) })).status, 409);
    const dawnNotice = (await roomMessages()).find((message) => message.text.includes("(dawn-closed)") && message.text.startsWith("Needs you"))!;
    const closeMessage = (await roomMessages()).find((message) => message.text.endsWith("Human response (dawn-closed):\n\nClosed without an answer."))!;
    assert.equal(closeMessage.reply_to_number, dawnNotice.number, "the close replies to the request");

    // DawnWinter leaving by itself keeps its open request for its return.
    const left = await fetch(`${base}/agent-sessions/${encodeURIComponent(dawnCredentials.agent_session_id)}/disconnect`, {
      method: "POST", headers: asAgent, body: JSON.stringify(dawnCredentials),
    });
    assert.equal(left.status, 200, await left.clone().text());
    assert.equal((await requests()).get("dawn-open")?.response, null);

    // The room admin disconnects BayOtter: its open requests are closed for the admin.
    const retired = await fetch(`${base}/agent-sessions/${encodeURIComponent(bayCredentials.agent_session_id)}/disconnect`, { method: "POST", headers: asAdmin, body: "{}" });
    assert.equal(retired.status, 200, await retired.clone().text());
    const after = await requests();
    for (const id of ["bay-open-1", "bay-open-2"]) {
      assert.equal(after.get(id)?.response?.body, "Agent retired.", id);
      assert.equal(after.get(id)?.response?.closed, true, id);
      assert.equal(after.get(id)?.response?.actor.id, owner.id, id);
    }
    assert.equal(after.get("bay-answered")?.response?.body, "Port 443.", "an answered request keeps its answer");
    assert.equal(after.get("dawn-open")?.response, null, "another agent keeps its requests");
    const told = (await roomMessages()).filter((message) => message.text.endsWith("\n\nAgent retired."));
    assert.equal(told.length, 2);
    assert.ok(told.every((message) => message.text.startsWith("@agent:emmymay/bayotter\n\nHuman response (bay-open-")));
    notices = (await roomMessages()).filter((message) => message.text.startsWith("Needs you"));
    assert.equal(notices.length, 5, "one notice per request");
  },
);
