import { isLocalBoardOwner, notifyLocalBoardChanged } from "./local-board-owner.mjs";

/** Commit-coupled board revisions. The daemon is the only board writer. */
export function ensureLocalTaskRevisionSchema(db) {
  // A newly installed standalone client must not migrate the board underneath
  // an older running daemon. The upgraded writer installs this schema itself.
  if (!isLocalBoardOwner()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS local_task_revisions (
    room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL
  )`);
  // Storage sync and worker heartbeat timestamps do not change the board.
  const sources = [
    ["local_tasks", ["title", "description", "status", "assignee", "assignee_agent_key",
      "assignee_agent_instance_id", "assignee_agent_session_id", "created_by", "pr_url",
      "workflow_artifacts_json", "workflow_refs_json", "review_lease_id", "review_holder_label",
      "review_agent_key", "review_agent_session_id", "review_updated_at"]],
    ["local_work_leases", ["status", "agent_key", "agent_session_id", "agent_instance_id",
      "actor_label", "epoch", "expires_at"]],
  ];
  for (const [table, columns] of sources) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      const changed = operation === "UPDATE"
        ? `WHEN ${columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}`
        : "";
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_owner_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table} ${changed}
        BEGIN
          SELECT CASE WHEN local_board_writer() != 1
            THEN RAISE(ABORT, 'Local board changes require the LetAgents background service.') END;
        END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_board_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} ${changed}
        BEGIN
          INSERT INTO local_task_revisions(room_id, revision) VALUES (${row}.room_id, 1)
          ON CONFLICT(room_id) DO UPDATE SET revision = revision + 1;
          SELECT local_board_changed(${row}.room_id,
            (SELECT revision - 1 FROM local_task_revisions WHERE room_id = ${row}.room_id));
        END`);
    }
  }
}

/**
 * Triggers collect dirty rooms, but only a completed commit can notify readers.
 * In particular, a rollback and a failed statement produce no change event.
 * All owner writes use this connection; socket loss causes reconnect catch-up.
 */
export function observeLocalTaskCommits(database) {
  const assertTransactionSupport = () => {
    if (typeof database.isTransaction !== "boolean") throw new Error("Local boards require SQLite transaction-state support.");
  };
  if (isLocalBoardOwner()) assertTransactionSupport();
  const dirty = new Map();
  const rawPrepare = database.prepare.bind(database);
  database.function("local_board_writer", () => {
    if (!isLocalBoardOwner()) return 0;
    assertTransactionSupport();
    return 1;
  });
  database.function("local_board_changed", (roomId, before) => {
    if (!dirty.has(roomId)) dirty.set(roomId, Number(before));
    return 0;
  });
  const flush = () => {
    if (database.isTransaction !== false || !dirty.size) return;
    const committed = [...dirty];
    dirty.clear();
    for (const [roomId, before] of committed) {
      const after = Number(rawPrepare("SELECT revision FROM local_task_revisions WHERE room_id=?").get(roomId)?.revision ?? 0);
      if (after !== before) notifyLocalBoardChanged(roomId);
    }
  };
  return new Proxy(database, {
    get(target, key) {
      if (key === "exec") return (...args) => { try { return target.exec(...args); } finally { flush(); } };
      if (key === "prepare") return (...args) => {
        const statement = rawPrepare(...args);
        return new Proxy(statement, {
          get(stmt, member) {
            const value = Reflect.get(stmt, member, stmt);
            if (typeof value !== "function") return value;
            if (!["run", "get", "all"].includes(member)) return value.bind(stmt);
            return (...values) => { try { return value.apply(stmt, values); } finally { flush(); } };
          },
        });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function readLocalTaskRevision(db, roomId) {
  return Number(db.prepare("SELECT revision FROM local_task_revisions WHERE room_id=?")
    .get(roomId)?.revision ?? 0);
}
