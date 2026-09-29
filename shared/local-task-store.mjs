import { readLocalWorkLeases, assertLocalTaskLeaseMutation, assertLocalWorkLeaseWorker, claimLocalWorkLease, changeLocalWorkLease } from './local-work-leases.mjs';
import { runLocalSqliteWriteTransactionAsync } from './sqlite-thread-routing.mjs';
/** Existing standalone MCP task semantics, executed by the desktop board owner. */
export function createLocalTaskStore({ getDb, withWorkerStateFence, currentWorkerCall }) {
    const validLocalTaskTransitions = {
        proposed: ["accepted", "cancelled"],
        accepted: ["assigned", "cancelled"],
        assigned: ["in_progress", "in_review", "cancelled"],
        in_progress: ["blocked", "in_review", "done", "cancelled"],
        blocked: ["in_progress", "in_review", "cancelled"],
        in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
        merged: ["done", "accepted"],
        done: ["accepted"],
        cancelled: ["accepted"],
    };
    function resolveLocalTaskStatus(fromStatus, toStatus) {
        if (typeof toStatus !== "string" || !toStatus.trim())
            return fromStatus;
        const nextStatus = toStatus.trim();
        if (!validLocalTaskTransitions[fromStatus]?.includes(nextStatus)) {
            throw new Error(`Invalid transition: ${fromStatus} -> ${nextStatus}. ` +
                `Allowed: ${validLocalTaskTransitions[fromStatus]?.join(", ") || "none"}`);
        }
        return nextStatus;
    }
    function allocateLocalTaskId(database, roomId) {
        database
            .prepare(`
      INSERT INTO local_task_room_sequences (room_id, next_number)
      SELECT ?, COALESCE(MAX(CAST(SUBSTR(task_id, 6) AS INTEGER)), 0) + 1
      FROM local_tasks
      WHERE room_id = ? AND task_id GLOB 'task_[0-9]*'
      ON CONFLICT(room_id) DO NOTHING
    `)
            .run(roomId, roomId);
        const row = database
            .prepare("SELECT next_number FROM local_task_room_sequences WHERE room_id = ?")
            .get(roomId);
        const number = Number(row?.next_number || 0);
        if (!Number.isInteger(number) || number <= 0) {
            throw new Error("Local task sequence could not be allocated.");
        }
        database
            .prepare("UPDATE local_task_room_sequences SET next_number = next_number + 1 WHERE room_id = ?")
            .run(roomId);
        return `task_${number}`;
    }
    function mapTaskRow(row, database) {
        const reviewLeaseId = typeof row.review_lease_id === "string" && row.review_lease_id.trim()
            ? row.review_lease_id
            : null;
        return {
            id: String(row.task_id || ""),
            title: String(row.title || ""),
            description: typeof row.description === "string" ? row.description : null,
            status: String(row.status || "proposed"),
            assignee: typeof row.assignee === "string" ? row.assignee : null,
            assignee_agent_key: typeof row.assignee_agent_key === "string" ? row.assignee_agent_key : null,
            assignee_agent_instance_id: typeof row.assignee_agent_instance_id === "string" ? row.assignee_agent_instance_id : null,
            assignee_agent_session_id: typeof row.assignee_agent_session_id === "string" ? row.assignee_agent_session_id : null,
            created_by: typeof row.created_by === "string" ? row.created_by : null,
            pr_url: typeof row.pr_url === "string" ? row.pr_url : null,
            workflow_artifacts: parseJsonArray(row.workflow_artifacts_json, []),
            workflow_refs: parseJsonArray(row.workflow_refs_json, []),
            active_leases: [...readLocalWorkLeases(database, String(row.room_id), String(row.task_id))
                    .map(lease => ({ ...lease, holder_label: lease.actor_label })), ...(reviewLeaseId
                    ? [
                        {
                            id: reviewLeaseId,
                            kind: "review",
                            holder_label: typeof row.review_holder_label === "string"
                                ? row.review_holder_label
                                : null,
                            agent_key: typeof row.review_agent_key === "string"
                                ? row.review_agent_key
                                : null,
                            agent_session_id: typeof row.review_agent_session_id === "string"
                                ? row.review_agent_session_id
                                : null,
                            status: "active",
                            updated_at: typeof row.review_updated_at === "string"
                                ? row.review_updated_at
                                : null,
                        },
                    ]
                    : [])],
            created_at: String(row.created_at || ""),
            updated_at: String(row.updated_at || ""),
        };
    }
    function parseJsonArray(value, fallback) {
        if (typeof value !== "string" || !value.trim())
            return fallback;
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : fallback;
        }
        catch {
            return fallback;
        }
    }
    async function addLocalTask(roomId, input) {
        const trimmedRoomId = roomId.trim();
        const title = input.title.trim();
        if (!trimmedRoomId)
            throw new Error("No room is available for this request.");
        if (!title)
            throw new Error("Task title is required.");
        const database = await getDb();
        const now = new Date().toISOString();
        let taskId = "";
        await runLocalSqliteWriteTransactionAsync(database, () => withWorkerStateFence(() => {
            taskId = allocateLocalTaskId(database, trimmedRoomId);
            database
                .prepare(`
        INSERT INTO local_tasks (
          room_id, task_id, title, description, status, assignee, assignee_agent_key,
          assignee_agent_instance_id, assignee_agent_session_id,
          created_by, pr_url, workflow_artifacts_json, workflow_refs_json,
          synced_cloud_id, sync_key, sync_started_at, sync_dirty, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'proposed', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, 1, ?, ?)
      `)
                .run(trimmedRoomId, taskId, title, input.description?.trim() || null, input.created_by || "agent", `local-task:${trimmedRoomId}:${taskId}`, now, now);
        }));
        const task = await getLocalTask(trimmedRoomId, taskId);
        if (!task)
            throw new Error("Local task could not be created.");
        return task;
    }
    async function listLocalTasks(roomId, options = {}) {
        const clauses = ["room_id = ?"];
        const params = [roomId];
        if (options.status) {
            clauses.push("status = ?");
            params.push(options.status);
        }
        if (options.openOnly !== false) {
            clauses.push("status NOT IN ('done', 'cancelled')");
        }
        const database = await getDb();
        const tasks = database
            .prepare(`
      SELECT *
      FROM local_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
    `)
            .all(...params)
            .map(row => mapTaskRow(row, database));
        return { tasks, has_more: false };
    }
    async function listLocalActiveTaskOwnerLeases(roomId) {
        const database = await getDb();
        const rows = database
            .prepare(`
      SELECT
        MIN(COALESCE(NULLIF(TRIM(assignee), ''), assignee_agent_key)) AS actor_label,
        assignee_agent_key,
        assignee_agent_instance_id,
        assignee_agent_session_id
      FROM local_tasks
      WHERE room_id = ?
        AND status IN ('assigned', 'in_progress', 'blocked', 'in_review')
        AND assignee_agent_key IS NOT NULL
        AND TRIM(assignee_agent_key) <> ''
      GROUP BY CASE
        WHEN NULLIF(TRIM(assignee_agent_session_id), '') IS NOT NULL
          THEN 'session:' || TRIM(assignee_agent_session_id)
        WHEN NULLIF(TRIM(assignee_agent_instance_id), '') IS NOT NULL
          THEN 'instance:' || TRIM(assignee_agent_key) || ':' || TRIM(assignee_agent_instance_id)
        ELSE 'agent:' || TRIM(assignee_agent_key)
      END
      ORDER BY MIN(created_at) ASC
      LIMIT 2
    `)
            .all(roomId);
        return rows.map((row) => ({
            kind: "work",
            status: "active",
            actor_label: String(row.actor_label || row.assignee_agent_key || ""),
            agent_key: String(row.assignee_agent_key || ""),
            agent_instance_id: typeof row.assignee_agent_instance_id === "string"
                ? row.assignee_agent_instance_id
                : null,
            agent_session_id: typeof row.assignee_agent_session_id === "string"
                ? row.assignee_agent_session_id
                : null,
        }));
    }
    async function getLocalTask(roomId, taskId) {
        const database = await getDb();
        const row = database
            .prepare("SELECT * FROM local_tasks WHERE room_id = ? AND task_id = ?")
            .get(roomId, taskId);
        return row ? mapTaskRow(row, database) : null;
    }
    async function updateLocalTask(roomId, taskId, patch) {
        const database = await getDb();
        let observed = readLocalWorkLeases(database, roomId, taskId)[0] ?? null;
        return runLocalSqliteWriteTransactionAsync(database, () => withWorkerStateFence(() => {
            let row = database.prepare("SELECT * FROM local_tasks WHERE room_id=? AND task_id=?").get(roomId, taskId);
            if (!row)
                throw new Error("Task not found.");
            if (patch.expected_no_work_lease === true && readLocalWorkLeases(database, roomId, taskId).length) {
                throw new Error("The task lease changed. Refresh the task before trying again.");
            }
            const caller = currentWorkerCall();
            const worker = caller?.agent_key ? {
                agent_key: caller.agent_key, session_id: caller.session_id, actor_label: caller.actor_label || caller.agent_key,
                agent_instance_id: caller.agent_instance_id,
            } : null;
            const supervised = worker ? assertLocalWorkLeaseWorker(database, roomId, worker) : false;
            if (supervised && worker && patch.status === "assigned") {
                if ((patch.assignee_agent_key != null && patch.assignee_agent_key !== worker.agent_key)
                    || (patch.assignee != null && patch.assignee !== worker.actor_label)) {
                    throw new Error("Use handoff_task_lease to assign work to another worker.");
                }
                observed = claimLocalWorkLease(database, roomId, taskId, worker);
                row = database.prepare("SELECT * FROM local_tasks WHERE room_id=? AND task_id=?").get(roomId, taskId);
            }
            if (worker) {
                assertLocalTaskLeaseMutation(database, row, worker, observed);
                if ((supervised || observed) && ((patch.assignee !== undefined && patch.assignee !== row.assignee)
                    || (patch.assignee_agent_key !== undefined && patch.assignee_agent_key !== row.assignee_agent_key)
                    || (patch.assignee_agent_session_id !== undefined && patch.assignee_agent_session_id !== row.assignee_agent_session_id)
                    || (patch.assignee_agent_key !== undefined && patch.agent_session_id !== undefined && patch.agent_session_id !== row.assignee_agent_session_id)
                    || (patch.assignee_agent_instance_id !== undefined && patch.assignee_agent_instance_id !== row.assignee_agent_instance_id)
                    || (patch.assignee_agent_key !== undefined && patch.actor_instance_id !== undefined && patch.actor_instance_id !== row.assignee_agent_instance_id))) {
                    throw new Error("Use claim_task or handoff_task_lease to change task ownership.");
                }
            }
            else if (observed || readLocalWorkLeases(database, roomId, taskId).length) {
                throw new Error("A registered owning worker is required to update this leased task.");
            }
            const current = mapTaskRow(row, database);
            const nextStatus = supervised && patch.status === "assigned" ? current.status
                : patch.skip_transition_validation === true
                    ? typeof patch.status === "string" && patch.status.trim()
                        ? patch.status.trim()
                        : current.status
                    : resolveLocalTaskStatus(current.status, patch.status);
            const assigneeAgentKey = patch.assignee_agent_key === undefined
                ? current.assignee_agent_key
                : typeof patch.assignee_agent_key === "string"
                    ? patch.assignee_agent_key
                    : null;
            const assigneeAgentInstanceId = patch.assignee_agent_key === undefined || (worker && patch.assignee_agent_key === current.assignee_agent_key)
                ? current.assignee_agent_instance_id
                : assigneeAgentKey && typeof patch.assignee_agent_instance_id === "string"
                    ? patch.assignee_agent_instance_id
                    : assigneeAgentKey && typeof patch.actor_instance_id === "string"
                        ? patch.actor_instance_id
                        : null;
            const assigneeAgentSessionId = patch.assignee_agent_key === undefined || (worker && patch.assignee_agent_key === current.assignee_agent_key)
                ? current.assignee_agent_session_id
                : assigneeAgentKey && typeof patch.assignee_agent_session_id === "string"
                    ? patch.assignee_agent_session_id
                    : assigneeAgentKey && typeof patch.agent_session_id === "string"
                        ? patch.agent_session_id
                        : null;
            const workflowArtifacts = patch.workflow_artifacts === undefined
                ? JSON.stringify(current.workflow_artifacts)
                : JSON.stringify(Array.isArray(patch.workflow_artifacts) ? patch.workflow_artifacts : []);
            const now = new Date().toISOString();
            database
                .prepare(`
        UPDATE local_tasks
        SET status = ?,
            assignee = ?,
            assignee_agent_key = ?,
            assignee_agent_instance_id = ?,
            assignee_agent_session_id = ?,
            pr_url = ?,
            workflow_artifacts_json = ?,
            sync_dirty = 1,
            updated_at = ?
        WHERE room_id = ? AND task_id = ?
      `)
                .run(nextStatus, patch.assignee === undefined ? current.assignee : patch.assignee || null, assigneeAgentKey, assigneeAgentInstanceId, assigneeAgentSessionId, patch.pr_url === undefined ? current.pr_url : patch.pr_url || null, workflowArtifacts, now, roomId, taskId);
            return mapTaskRow(database.prepare("SELECT * FROM local_tasks WHERE room_id=? AND task_id=?").get(roomId, taskId), database);
        }));
    }
    async function changeLocalTaskWorkLease(roomId, taskId, input) {
        const database = await getDb();
        const observed = readLocalWorkLeases(database, roomId, taskId)[0];
        if (!observed)
            throw new Error("This task has no active work lease.");
        return runLocalSqliteWriteTransactionAsync(database, () => withWorkerStateFence(() => {
            const worker = currentWorkerCall();
            if (!worker?.agent_key)
                throw new Error("A registered owning worker is required to change this work lease.");
            const result = changeLocalWorkLease(database, roomId, taskId, {
                ...input, lease_id: input.lease_id ?? observed.id, epoch: input.epoch ?? observed.epoch,
            }, {
                agent_key: worker.agent_key, session_id: worker.session_id, actor_label: worker.actor_label || worker.agent_key,
            });
            const task = mapTaskRow(database.prepare("SELECT * FROM local_tasks WHERE room_id=? AND task_id=?").get(roomId, taskId), database);
            return { action: input.action, task, ...result };
        }));
    }
    async function claimLocalTaskReviewLease(roomId, taskId, input) {
        const current = await getLocalTask(roomId, taskId);
        if (!current)
            throw new Error("Task not found.");
        const actorKey = input.agent_key?.trim() || null;
        if (actorKey &&
            current.assignee_agent_key &&
            current.assignee_agent_key === actorKey) {
            throw new Error("A worker holding the task cannot also claim review authority.");
        }
        const currentReviewLease = current.active_leases?.find((lease) => lease.kind === "review");
        if (currentReviewLease?.agent_key &&
            actorKey &&
            currentReviewLease.agent_key !== actorKey) {
            throw new Error("Review authority is already held by another local reviewer.");
        }
        const database = await getDb();
        const now = new Date().toISOString();
        const leaseId = currentReviewLease?.id || `local_review_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await runLocalSqliteWriteTransactionAsync(database, () => withWorkerStateFence(() => database
            .prepare(`
      UPDATE local_tasks
      SET review_lease_id = ?,
          review_holder_label = ?,
          review_agent_key = ?,
          review_agent_session_id = ?,
          review_updated_at = ?,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
            .run(leaseId, input.holder_label?.trim() || actorKey || "Local reviewer", actorKey, input.agent_session_id?.trim() || null, now, now, roomId, taskId)));
        const task = await getLocalTask(roomId, taskId);
        const lease = task?.active_leases?.find((entry) => entry.id === leaseId);
        if (!task || !lease)
            throw new Error("Review authority could not be claimed.");
        return { task, lease };
    }
    async function releaseLocalTaskReviewLease(roomId, taskId, input = {}) {
        const current = await getLocalTask(roomId, taskId);
        if (!current)
            throw new Error("Task not found.");
        const currentReviewLease = current.active_leases?.find((lease) => lease.kind === "review") || null;
        if (input.lease_id &&
            currentReviewLease &&
            input.lease_id !== currentReviewLease.id) {
            throw new Error("Review lease id did not match the active local review authority.");
        }
        const database = await getDb();
        const now = new Date().toISOString();
        await runLocalSqliteWriteTransactionAsync(database, () => withWorkerStateFence(() => database
            .prepare(`
      UPDATE local_tasks
      SET review_lease_id = NULL,
          review_holder_label = NULL,
          review_agent_key = NULL,
          review_agent_session_id = NULL,
          review_updated_at = NULL,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
            .run(now, roomId, taskId)));
        const task = await getLocalTask(roomId, taskId);
        if (!task)
            throw new Error("Task not found.");
        return {
            task,
            released_lease: currentReviewLease
                ? { ...currentReviewLease, status: "released" }
                : null,
        };
    }
    return { addLocalTask, listLocalTasks, listLocalActiveTaskOwnerLeases, getLocalTask, updateLocalTask, changeLocalTaskWorkLease, claimLocalTaskReviewLease, releaseLocalTaskReviewLease };
}
