import { randomUUID } from "node:crypto";

/** Shared by desktop and MCP writers. All mutations run inside their write transaction. */
export function ensureLocalWorkLeaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_work_leases (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, task_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'work' CHECK(kind='work'),
      status TEXT NOT NULL CHECK(status IN ('active','released','revoked','expired')),
      agent_key TEXT NOT NULL, agent_session_id TEXT NOT NULL, agent_instance_id TEXT,
      actor_label TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
      expires_at TEXT, revoked_reason TEXT,
      FOREIGN KEY(room_id,task_id) REFERENCES local_tasks(room_id,task_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS local_work_lease_owner
      ON local_work_leases(room_id,task_id) WHERE status='active';
    CREATE INDEX IF NOT EXISTS local_work_lease_session ON local_work_leases(agent_session_id,status);
    CREATE TRIGGER IF NOT EXISTS local_work_lease_task_changed
      AFTER UPDATE OF status,assignee,assignee_agent_key,assignee_agent_session_id ON local_tasks
      BEGIN
        UPDATE local_work_leases SET status='revoked',revoked_reason='Task completed or ownership changed',updated_at=NEW.updated_at
        WHERE room_id=NEW.room_id AND task_id=NEW.task_id AND status='active'
          AND (NEW.status NOT IN ('assigned','in_progress','blocked','in_review')
            OR NEW.assignee_agent_key IS NOT agent_key
            OR NEW.assignee_agent_session_id IS NOT agent_session_id
            OR NEW.assignee IS NOT actor_label);
      END;
    CREATE TRIGGER IF NOT EXISTS local_work_lease_task_deleted AFTER DELETE ON local_tasks
      BEGIN DELETE FROM local_work_leases WHERE room_id=OLD.room_id AND task_id=OLD.task_id; END;
  `);
}

export function readLocalWorkLeases(db, roomId, taskId) {
  return db.prepare(`SELECT * FROM local_work_leases WHERE room_id=? AND task_id=? AND status='active'
    AND (expires_at IS NULL OR expires_at>?)`).all(roomId, taskId, new Date().toISOString());
}

export function assertLocalWorkLeaseWorker(db, roomId, worker) {
  if (!worker?.agent_key || !worker.session_id) throw new Error("A registered worker is required for task ownership.");
  const hasSessions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_supervisor_sessions'").get();
  const session = hasSessions && db.prepare(`SELECT s.ended_at,g.revoked_at,g.room_id,g.agent_key FROM local_supervisor_sessions s
    JOIN local_supervisor_grants g USING(grant_id) WHERE s.session_id=?`).get(worker.session_id);
  if ((worker.supervised && !session) || (session && (session.ended_at || session.revoked_at
    || session.room_id !== roomId || session.agent_key !== worker.agent_key))) {
    throw new Error("Local worker authority ended before the task mutation.");
  }
  return Boolean(session);
}

function taskRow(db, roomId, taskId) {
  const task = db.prepare("SELECT * FROM local_tasks WHERE room_id=? AND task_id=?").get(roomId, taskId);
  if (!task) throw new Error("Task not found.");
  return task;
}

function expireLeases(db, roomId, taskId, now) {
  db.prepare(`UPDATE local_work_leases SET status='expired',updated_at=?
    WHERE room_id=? AND task_id=? AND status='active' AND expires_at IS NOT NULL AND expires_at<=?`)
    .run(now, roomId, taskId, now);
}

function mintLease(db, roomId, taskId, worker, now) {
  const epoch = Number(db.prepare("SELECT COALESCE(MAX(epoch),-1)+1 AS epoch FROM local_work_leases WHERE room_id=? AND task_id=?")
    .get(roomId, taskId).epoch);
  const id = `local_work_${randomUUID()}`;
  db.prepare(`INSERT INTO local_work_leases(id,room_id,task_id,status,agent_key,agent_session_id,agent_instance_id,
    actor_label,epoch,created_at,updated_at,last_heartbeat_at) VALUES(?,?,?,'active',?,?,?,?,?,?,?,?)`)
    .run(id, roomId, taskId, worker.agent_key, worker.session_id, worker.agent_instance_id ?? null,
      worker.actor_label, epoch, now, now, now);
  return db.prepare("SELECT * FROM local_work_leases WHERE id=?").get(id);
}

function assignTask(db, roomId, taskId, worker, status, now) {
  db.prepare(`UPDATE local_tasks SET status=?,assignee=?,assignee_agent_key=?,assignee_agent_instance_id=?,
    assignee_agent_session_id=?,sync_dirty=1,updated_at=? WHERE room_id=? AND task_id=?`)
    .run(status, worker?.actor_label ?? null, worker?.agent_key ?? null, worker?.agent_instance_id ?? null,
      worker?.session_id ?? null, now, roomId, taskId);
}

export function claimLocalWorkLease(db, roomId, taskId, worker) {
  if (!assertLocalWorkLeaseWorker(db, roomId, worker)) throw new Error("A supervised worker is required for a local work lease.");
  const task = taskRow(db, roomId, taskId);
  const now = new Date().toISOString();
  expireLeases(db, roomId, taskId, now);
  const active = readLocalWorkLeases(db, roomId, taskId)[0];
  if (active) {
    if (active.agent_session_id !== worker.session_id || active.agent_key !== worker.agent_key) {
      throw new Error("This task is already owned by another worker. Use a lease handoff.");
    }
    return active; // Retry never changes the failure-time cutoff or ownership fence.
  }
  const reclaim = ['assigned', 'in_progress', 'blocked', 'in_review'].includes(task.status)
    && task.assignee_agent_key === worker.agent_key;
  if (task.status !== 'accepted' && !reclaim) throw new Error("Claim an accepted task, or reclaim your own assigned task.");
  if (task.assignee_agent_key && task.assignee_agent_key !== worker.agent_key) throw new Error("This task is assigned to another worker.");
  assignTask(db, roomId, taskId, worker, reclaim ? task.status : 'assigned', now);
  return mintLease(db, roomId, taskId, worker, now);
}

/** Worker APIs must call this after taking the write lock, before changing any task fields. */
export function assertLocalTaskLeaseMutation(db, task, worker, expected) {
  const supervised = assertLocalWorkLeaseWorker(db, task.room_id, worker);
  const active = readLocalWorkLeases(db, task.room_id, task.task_id)[0];
  if (expected !== undefined && ((active?.id ?? null) !== (expected?.id ?? null)
    || (active?.epoch ?? null) !== (expected?.epoch ?? null))) throw new Error("The task lease changed before this update.");
  const reviewOwner = task.review_lease_id && task.review_agent_key === worker.agent_key
    && task.review_agent_session_id === worker.session_id && task.status === 'in_review';
  if (active && (active.agent_session_id !== worker.session_id || active.agent_key !== worker.agent_key) && !reviewOwner) {
    throw new Error("This task's work lease belongs to another worker.");
  }
  if (!active && supervised && ['assigned','in_progress','blocked','in_review'].includes(task.status) && !reviewOwner) {
    throw new Error("Claim this task to establish a current work lease before updating it.");
  }
}

/** A null actor is reserved for the desktop's explicit human lease controls. */
export function changeLocalWorkLease(db, roomId, taskId, input, worker) {
  if (worker) assertLocalWorkLeaseWorker(db, roomId, worker);
  const task = taskRow(db, roomId, taskId);
  const now = new Date().toISOString();
  expireLeases(db, roomId, taskId, now);
  const active = readLocalWorkLeases(db, roomId, taskId)[0];
  if (!active) throw new Error("This task has no active work lease.");
  if ((input.lease_id && active.id !== input.lease_id)
    || (input.epoch !== undefined && active.epoch !== input.epoch)) throw new Error("The task lease changed. Refresh the task before trying again.");
  if (worker && (active.agent_session_id !== worker.session_id || active.agent_key !== worker.agent_key)) {
    throw new Error("Only the current worker can release or hand off this work lease.");
  }
  let target = null;
  if (input.action === 'handoff') {
    const targets = db.prepare(`SELECT s.session_id,s.instance_id,g.agent_key,s.public_json FROM local_supervisor_sessions s
      JOIN local_supervisor_grants g USING(grant_id) WHERE g.room_id=? AND g.agent_key=?
        AND g.revoked_at IS NULL AND s.ended_at IS NULL`)
      .all(roomId, input.target_actor_key ?? '').filter(row =>
        (!input.target_agent_session_id || row.session_id === input.target_agent_session_id)
        && (!input.target_actor_instance_id || row.instance_id === input.target_actor_instance_id));
    if (targets.length !== 1) throw new Error("Choose one active local worker session for this handoff.");
    const session = JSON.parse(targets[0].public_json);
    target = { ...session, supervised: true };
    assertLocalWorkLeaseWorker(db, roomId, target);
  } else if (input.action !== 'release') throw new Error("Unknown work lease action.");
  db.prepare("UPDATE local_work_leases SET status='released',updated_at=? WHERE id=?").run(now, active.id);
  assignTask(db, roomId, taskId, target, target ? (task.status === 'blocked' ? 'assigned' : task.status) : 'accepted', now);
  return { released_lease: { ...active, status: 'released', updated_at: now },
    new_lease: target ? mintLease(db, roomId, taskId, target, now) : null };
}

export function endLocalWorkerLeases(db, sessionId, now) {
  db.prepare(`UPDATE local_work_leases SET status='revoked',revoked_reason='Worker session ended',updated_at=?
    WHERE agent_session_id=? AND status='active'`).run(now, sessionId);
}

export function heartbeatLocalWorkLeases(db, sessionId, now) {
  db.prepare(`UPDATE local_work_leases SET last_heartbeat_at=?,updated_at=?
    WHERE agent_session_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)`)
    .run(now, now, sessionId, now);
  return db.prepare(`SELECT id,epoch FROM local_work_leases WHERE agent_session_id=? AND status='active'
    AND (expires_at IS NULL OR expires_at>?)`).all(sessionId, now);
}
