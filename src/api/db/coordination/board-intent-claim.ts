import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../client.js";
import { board_intents, board_manager_assignments, room_agent_session_bearers, room_agent_sessions,
  supervisor_host_grants, task_leases, task_locks, tasks } from "../schema.js";
import { toTask } from "../mappers.js";
import { getTaskRowById, updateTask } from "../tasks.js";
import { parseScopedId } from "../utils.js";
import { assertSupervisorGrantFenceTx } from "../auth/supervisor-grants.js";
import { approveBoardIntent, getBoardIntent, markBoardIntentTaskResult } from "./board-intent-lifecycle.js";
import { hashBoardIntentPayload } from "./board-intent-approval.js";
import { acquireLeaseFenceTx, LeaseFenceStaleError, type LeaseFence } from "./lease-rebind.js";
import { boardIntentPayloadForTaskMutation } from "../../board-intent-payloads.js";
import { evaluateCoordinationMutation } from "../../coordination-policy.js";
import { expireStaleTaskLeases } from "./task-leases.js";
import { buildLeasedBranchRef } from "../../github/lease-enforcement.js";
import type { BoardIntent, Task, TaskLeaseRow, TaskLockRow } from "../types.js";
import type { RoomAgentDeliveryCredentialFence } from "../../../shared/agent-presence.js";

type Transaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
type Worker = { agent_session_id: string; agent_key: string; agent_instance_id: string | null };

export class BoardIntentClaimConflictError extends Error {
  readonly code = "board_intent_claim_conflict";
}

function conflict(message: string): never { throw new BoardIntentClaimConflictError(message); }

// Sessions are durable intent principals: ordinary bearer rotation does not
// change their identity. Ending the exact session or revoking its host grant
// does. Grant -> session lock order matches worker registration/revocation.
async function lockWorkers(tx: Transaction, roomId: string, workers: Worker[]) {
  const ids = [...new Set(workers.map(worker => worker.agent_session_id))].sort();
  let authorityExpiresAt = Infinity;
  const observed = await tx.select().from(room_agent_sessions).where(inArray(room_agent_sessions.session_id, ids));
  for (const grantId of [...new Set(observed.flatMap(session => session.supervisor_grant_id ? [session.supervisor_grant_id] : []))].sort()) {
    const [grant] = await tx.select().from(supervisor_host_grants).where(eq(supervisor_host_grants.grant_id, grantId));
    if (!grant || !(await assertSupervisorGrantFenceTx(tx, { grant_id: grantId,
      generation: grant.current_generation, token_version: grant.token_version }))) conflict("The worker's host authority is no longer current.");
    authorityExpiresAt = Math.min(authorityExpiresAt, Date.parse(grant.expires_at));
    for (const session of observed.filter(session => session.supervisor_grant_id === grantId)) {
      if (grant.owner_account_id !== session.owner_account_id || !grant.allowed_room_ids.includes(roomId)
        || !grant.allowed_agent_keys.includes(session.agent_key)) conflict("The worker's host authority does not cover this claim.");
    }
  }
  const sessions = await tx.select().from(room_agent_sessions)
    .where(inArray(room_agent_sessions.session_id, ids)).orderBy(asc(room_agent_sessions.session_id)).for("share");
  for (const worker of workers) {
    const session = sessions.find(session => session.session_id === worker.agent_session_id);
    const before = observed.find(session => session.session_id === worker.agent_session_id);
    if (!session || !before || session.ended_at || session.session_kind !== "worker" || session.room_id !== roomId
      || session.agent_key !== worker.agent_key || session.agent_instance_id !== worker.agent_instance_id
      || session.supervisor_grant_id !== before.supervisor_grant_id) conflict("The exact proposing or approving worker session is no longer active.");
  }
  return { sessions, authorityExpiresAt };
}

/** Null means legacy/unverified: the caller must retain the explicit token follow-up. */
export async function approveTaskClaimBoardIntent(input: {
  room_id: string; intent_id: string; decision_by: string; reason?: string | null;
  manager?: Worker & { credential_fence: RoomAgentDeliveryCredentialFence };
}): Promise<{ intent: BoardIntent; task: Task | null } | null> {
  return db.transaction(async tx => {
    const [initial] = await tx.select().from(board_intents).where(and(
      eq(board_intents.room_id, input.room_id), eq(board_intents.id, input.intent_id)));
    if (!initial || initial.action_type !== "task_claim" || !initial.proposer_worker_auth_kind) return null;
    const taskId = initial.task_id ?? (typeof initial.payload.task_id === "string" ? initial.payload.task_id : null);
    const taskNumber = taskId && parseScopedId(taskId, "task");
    if (!taskNumber || !initial.proposer_agent_session_id || !initial.proposer_actor_key || !initial.proposer_actor_label
      || initial.payload_hash !== hashBoardIntentPayload(boardIntentPayloadForTaskMutation({ taskId,
        status: "assigned", assignee: initial.proposer_actor_label, assigneeAgentKey: initial.proposer_actor_key }))) {
      conflict("The claim must name the exact registered proposer and task.");
    }
    // Used is a receipt, never permission to recreate a released/rebound lease.
    if (initial.status === "used") return { intent: (await getBoardIntent(input, tx))!,
      task: await getTaskRowById(input.room_id, taskId, tx).then(task => task ? toTask(task) : null) };
    const proposer: Worker = { agent_session_id: initial.proposer_agent_session_id,
      agent_key: initial.proposer_actor_key, agent_instance_id: initial.proposer_actor_instance_id };
    await expireStaleTaskLeases(input.room_id, new Date(), tx);
    const leases = await tx.select().from(task_leases).where(and(eq(task_leases.room_id, input.room_id),
      eq(task_leases.task_id, taskId), eq(task_leases.status, "active")));
    const existingWork = leases.find(lease => lease.kind === "work");
    const fence: LeaseFence | undefined = existingWork?.agent_session_id === proposer.agent_session_id
      ? { lease_id: existingWork.id, room_id: input.room_id, task_id: taskId, kind: "work",
        expected_epoch: existingWork.epoch, agent_session_id: proposer.agent_session_id } : undefined;
    // Preserve the shared lease -> grant -> session/task order used by rebind.
    if (fence && !(await acquireLeaseFenceTx(tx, fence))) throw new LeaseFenceStaleError();
    const authority = await lockWorkers(tx, input.room_id, input.manager ? [proposer, input.manager] : [proposer]);
    const workers = authority.sessions;
    if (workers.find(session => session.session_id === proposer.agent_session_id)!.actor_label !== initial.proposer_actor_label) {
      conflict("The registered proposer identity changed.");
    }
    if (initial.proposer_worker_auth_kind === "bearer") {
      const [bearer] = await tx.select().from(room_agent_session_bearers).where(and(
        eq(room_agent_session_bearers.session_id, proposer.agent_session_id),
        eq(room_agent_session_bearers.room_id, input.room_id), isNull(room_agent_session_bearers.revoked_at)))
        .orderBy(desc(room_agent_session_bearers.generation)).limit(1).for("share");
      const session = workers.find(session => session.session_id === proposer.agent_session_id)!;
      if (!bearer || Date.parse(bearer.expires_at) <= Date.now()
        || bearer.supervisor_grant_id !== session.supervisor_grant_id
        || !bearer.capabilities.includes("coordination.self_write")) conflict("The proposing worker no longer has claim authority.");
      authority.authorityExpiresAt = Math.min(authority.authorityExpiresAt, Date.parse(bearer.expires_at));
    }
    if (input.manager) {
      const manager = workers.find(session => session.session_id === input.manager!.agent_session_id)!;
      const credential = input.manager.credential_fence;
      if (credential.kind === "session_token") {
        if (manager.token_hash !== credential.token_hash) conflict("The manager credential changed.");
      } else {
        const [bearer] = await tx.select().from(room_agent_session_bearers).where(and(
          eq(room_agent_session_bearers.session_id, manager.session_id), eq(room_agent_session_bearers.bearer_id, credential.bearer_id),
          eq(room_agent_session_bearers.generation, credential.generation), isNull(room_agent_session_bearers.revoked_at))).for("share");
        if (!bearer || Date.parse(bearer.expires_at) <= Date.now() || bearer.room_id !== input.room_id
          || bearer.supervisor_grant_id !== manager.supervisor_grant_id
          || !bearer.capabilities.includes("coordination.self_write")) conflict("The manager credential is no longer current.");
        authority.authorityExpiresAt = Math.min(authority.authorityExpiresAt, Date.parse(bearer.expires_at));
      }
      const [assignment] = await tx.select().from(board_manager_assignments).where(and(
        eq(board_manager_assignments.room_id, input.room_id), eq(board_manager_assignments.agent_session_id, manager.session_id),
        eq(board_manager_assignments.agent_key, manager.agent_key), eq(board_manager_assignments.status, "active"),
        isNull(board_manager_assignments.released_at))).for("share");
      if (!assignment) conflict("The approving worker is no longer the Board Manager.");
    }
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.room_id, input.room_id), eq(tasks.number, taskNumber))).for("update");
    const intent = await getBoardIntent(input, tx);
    if (intent?.status === "used") return { intent, task: task ? toTask(task) : null };
    if (!task || (task.status !== "accepted" && !(task.status === "assigned"
      && task.assignee_agent_key === proposer.agent_key && task.assignee === initial.proposer_actor_label))) {
      conflict("Claim an accepted task, or recover the same worker's assigned task.");
    }
    const locks = await tx.select().from(task_locks).where(and(eq(task_locks.room_id, input.room_id), isNull(task_locks.cleared_at)));
    const decision = evaluateCoordinationMutation({ mutation: "task_claim", taskId, requiredLeaseKind: "work",
      actor: { actorLabel: initial.proposer_actor_label, agentKey: proposer.agent_key,
        agentInstanceId: proposer.agent_instance_id, agentSessionId: proposer.agent_session_id },
      leases: leases as TaskLeaseRow[], locks: locks as TaskLockRow[] });
    if (decision.kind === "deny" && decision.code !== "missing_lease") conflict(decision.reason);
    if (existingWork && (!fence || decision.kind !== "allow")) conflict("The existing work lease cannot be replaced by claim approval.");
    if (authority.authorityExpiresAt <= Date.now()) conflict("The worker or manager authority expired before approval could commit.");
    // A previous server may already have recorded approval during rollout.
    // Consume its exact unexpired approval without extending the deadline.
    const approved = intent?.status === "approved" ? intent : (await approveBoardIntent(input, tx))?.intent;
    if (!approved) conflict("Pending board intent not found or expired.");
    const claimed = await updateTask(input.room_id, taskId, { status: "assigned", assignee: initial.proposer_actor_label,
      assignee_agent_key: proposer.agent_key }, {
      boardIntentApproval: { room_id: input.room_id, action_type: "task_claim", payload: initial.payload,
        intent_id: initial.id, trusted_worker: { agent_session_id: proposer.agent_session_id, agent_key: proposer.agent_key } },
      ...(fence ? { leaseFence: fence } : { workLeaseCreation: {
        agent_key: proposer.agent_key, agent_instance_id: proposer.agent_instance_id, agent_session_id: proposer.agent_session_id,
        actor_label: initial.proposer_actor_label, created_by: initial.proposer_actor_label, output_intent: task.title,
        branch_ref: buildLeasedBranchRef({ taskId, agentKey: proposer.agent_key }),
      } }),
    }, tx);
    if (!claimed) conflict("The claim task no longer exists.");
    if (!initial.task_id) await markBoardIntentTaskResult({ room_id: input.room_id, intent_id: initial.id, task_id: taskId }, tx);
    return { intent: (await getBoardIntent(input, tx))!, task: claimed };
  });
}
