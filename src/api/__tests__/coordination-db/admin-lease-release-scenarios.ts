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
  startApiServer,
  stopChildProcess,
} from "./harness.js";

type Request = { id: string; response: { body: string; actor: { id: string; kind: string } } | null };

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
