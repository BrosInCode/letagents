import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LOCAL_ROOM_API_ORIGIN } from "../../../../../shared/room-api-origin.mjs";
import type { AgentMessageActivation } from "../../../../../shared/activation-routing.mjs";
import { parseWorkspaceReviewPage } from "../../../../../shared/workspace-review.mjs";
import { parseRoomAgentWorkSummary } from "../../../../../shared/room-agent-work.mjs";
import { addLocalChatMessage, getLocalChatMessages, getLatestLocalChatMessages,
  getLocalChatMessagesBefore, getLocalMessageThread } from "./messages/local-store.js";
import type { RoomMessagePayload } from "./messages/mappers.js";
import { getLocalRoom, listLocalTasks, addLocalTask, updateLocalTask, claimLocalTaskReviewLease,
  claimLocalTaskWorkLease, changeLocalTaskWorkLease } from "./local-store.js";
import { readLocalWorkLeases, heartbeatLocalWorkLeases, assertLocalWorkLeaseWorker } from "../../../../../shared/local-work-leases.mjs";
import { beginImmediate, rollback } from "./local-db.js";
import { getLocalRoomArtifacts, publishLocalRoomArtifact } from "./artifacts/local-store.js";
import { localSupervisionDatabase, authorizeLocalHost, authorizeLocalWorker,
  createLocalSupervisorSession, endLocalSupervisorSession } from "./local-supervision-authority.js";
export { prepareLocalSupervisorGrant } from "./local-supervision-authority.js";
export { executeLocalBoardMutation, watchLocalBoard } from "./local-board-service.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
const optional = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const json = (value: unknown, status = 200): Response => Response.json(value, { status });
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Older messages without captured recipients cannot acquire new delivery authority. */
async function routeMessage(roomId: string, message: RoomMessagePayload, agentKey: string) {
  const db = await localSupervisionDatabase();
  const stored = db.prepare("SELECT routes_json FROM local_supervisor_message_routes WHERE room_id=? AND message_id=?").get(roomId, message.id);
  const routes = stored ? JSON.parse(String(stored.routes_json)) as Record<string, AgentMessageActivation["for_current_agent"]> : {};
  return { ...message, created_at: message.timestamp, activation: { for_current_agent: routes[agentKey]
    ?? { decision: "silent", reason: "unaddressed", addressed: false } } };
}

async function publishLocalWork(grant: ObjectValue, sessionId: string, body: ObjectValue) {
  if (body.room_id !== grant.room_id || !/^msg_[1-9]\d*$/.test(String(body.source_message_id))
    || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new Error("Invalid local work identity.");
  const summary = parseRoomAgentWorkSummary(body.summary);
  const review = body.review_page === undefined ? null : parseWorkspaceReviewPage(body.review_page);
  if (!summary || (body.review_page !== undefined && (!review || summary.version !== 3))) throw new Error("Invalid local work summary or review page.");
  const db = await localSupervisionDatabase();
  const conflict = new Error("Local work revision conflict.");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Recheck revocation and publication scope inside the same write transaction.
    if (!db.prepare(`SELECT 1 FROM local_supervisor_sessions s JOIN local_supervisor_grants g USING(grant_id)
      WHERE g.grant_id=? AND g.revoked_at IS NULL AND s.session_id=? AND s.ended_at IS NULL`)
      .get(grant.grant_id, sessionId)
      || !db.prepare("SELECT 1 FROM local_chat_messages WHERE room_id=? AND number=?")
        .get(grant.room_id, Number(String(body.source_message_id).slice(4)))) throw new Error("Local work publisher or source is unavailable.");
    const current = db.prepare("SELECT * FROM local_supervisor_work WHERE room_id=? AND source_message_id=? AND agent_key=?")
      .get(grant.room_id, body.source_message_id, grant.agent_key);
    const serialized = JSON.stringify(summary);
    if (current && (Number(current.revision) > Number(body.revision)
      || (current.revision === body.revision && current.summary_json !== serialized))) throw conflict;
    const attemptId = current?.attempt_id ?? randomUUID();
    if (review) {
      const priorRow = db.prepare("SELECT page_json FROM local_supervisor_work_review_pages WHERE attempt_id=? LIMIT 1").get(attemptId);
      const prior = priorRow ? parseWorkspaceReviewPage(JSON.parse(String(priorRow.page_json))) : null;
      const page = db.prepare("SELECT page_json FROM local_supervisor_work_review_pages WHERE attempt_id=? AND page_index=?").get(attemptId, review.index);
      if ((priorRow && (!prior || prior.digest !== review.digest || prior.total !== review.total))
        || (page && page.page_json !== JSON.stringify(review))) throw conflict;
      db.prepare(`INSERT INTO local_supervisor_work_review_pages(attempt_id,page_index,page_json) VALUES(?,?,?)
        ON CONFLICT DO NOTHING`).run(attemptId, review.index, JSON.stringify(review));
    }
    const now = current && current.revision === body.revision ? current.updated_at : new Date().toISOString();
    db.prepare(`INSERT INTO local_supervisor_work(room_id,source_message_id,agent_key,attempt_id,revision,summary_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,source_message_id,agent_key) DO UPDATE SET
      revision=excluded.revision,summary_json=excluded.summary_json,updated_at=excluded.updated_at`)
      .run(grant.room_id, body.source_message_id, grant.agent_key, attemptId, body.revision, serialized, now);
    db.exec("COMMIT");
    return json({ status: current?.revision === body.revision ? "replayed" : current ? "updated" : "created",
      work: { attempt_id: attemptId, room_id: grant.room_id, source_message_id: body.source_message_id,
        agent_key: grant.agent_key, revision: body.revision, summary, updated_at: now },
      ...(review ? { review_digest: review.digest, review_page: review.index } : {}),
    });
  } catch (error) {
    db.exec("ROLLBACK");
    if (error === conflict) return json({ code: "revision_conflict" }, 409);
    throw error;
  }
}

/** Storage implementation of the existing wire contract; no socket, listener, or network fetch. */
export async function requestLocalSupervisor(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(rawUrl);
  if (`${url.protocol}//${url.host}` !== LOCAL_ROOM_API_ORIGIN || url.username || url.password || url.hash) throw new Error("Invalid local room endpoint.");
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const body = typeof init.body === "string" ? object(JSON.parse(init.body)) : {};
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "supervisor-host-grants") {
    const grantId = required(parts[1], "grant id");
    const grant = await authorizeLocalHost(grantId, bearer, Number(headers.get("x-letagents-supervisor-generation")));
    if (parts[2] === "worker-sessions" && parts.length === 3 && init.method === "POST") {
      return json(await createLocalSupervisorSession(grant, body as Parameters<typeof createLocalSupervisorSession>[1]));
    }
    if (parts[2] === "worker-sessions" && parts[4] === "end" && init.method === "POST") {
      await endLocalSupervisorSession(grantId, parts[3]);
      return json({ ended: true });
    }
    if (parts[2] === "worker-sessions" && parts[4] === "agent-work" && init.method === "POST") {
      return publishLocalWork(grant, parts[3], body);
    }
    // Remote delegation is a cloud account capability. Host-native approval
    // remains available and is already journaled by the daemon for local agents.
    if (parts[2] === "execution-delegations" && parts.length === 3) return json({ delegation_instance_ids: [], next_cursor: null });
    if (parts[2] === "execution-delegation-decisions" && parts.length === 3) return json({ decision_ids: [], next_cursor: null });
    return json({ error: "This operation is unavailable for local room authority." }, 404);
  }
  if (parts[0] !== "rooms") return json({ error: "Unknown local room operation." }, 404);
  const resource = parts.reduce((found, part, index) => index > 1 && ["messages", "agent-sessions", "tasks", "join"].includes(part) ? index : found, -1);
  if (resource < 0) return json({ error: "Unknown local room resource." }, 404);
  const roomId = parts.slice(1, resource).join("/");
  const session = await authorizeLocalWorker(roomId, bearer);
  const operation = parts.slice(resource);
  if (operation[0] === "join") return json({ room_id: roomId });
  if (operation[0] === "messages") {
    if (init.method === "POST") {
      const message = await addLocalChatMessage(roomId, { sender: session.actor_label,
        text: required(body.text, "message text"), source: "agent", publisher_agent_key: session.agent_key,
        publisher_agent_session_id: session.session_id, idempotency_key: `local-supervised:${session.agent_key}:${required(body.client_message_id, "client message id")}`,
        reply_to: optional(body.reply_to), thread_root_id: optional(body.thread_root_id) });
      return json({ ...message, room_id: roomId });
    }
    const latest = url.searchParams.get("before") === "latest";
    const after = url.searchParams.get("after");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 100));
    let page = latest ? await getLatestLocalChatMessages(roomId, { limit, include_prompt_only: true })
      : await getLocalChatMessages(roomId, { after, limit, include_prompt_only: true });
    if (operation[1] === "poll" && !page.messages.length) {
      await delay(500, undefined, { signal: init.signal ?? undefined });
      page = await getLocalChatMessages(roomId, { after, limit, include_prompt_only: true });
    }
    const messages = await Promise.all(page.messages.map((message) => routeMessage(roomId, message, session.agent_key)));
    return json({ room_id: roomId, messages, has_more: page.has_more,
      last_observed_message_id: page.messages.at(-1)?.id ?? after ?? null });
  }
  if (operation[0] === "agent-sessions" && operation[2] === "native-activity" && init.method === "POST") {
    if (operation[1] !== session.session_id) throw new Error("Local native activity belongs to another worker.");
    const db = await localSupervisionDatabase();
    beginImmediate(db);
    try {
      assertLocalWorkLeaseWorker(db, roomId, { ...session, supervised: true });
      const row = db.prepare("SELECT native_sequence,native_observed_at FROM local_supervisor_sessions WHERE session_id=?").get(session.session_id)!;
      const observed = Date.parse(String(body.observed_at));
      if (!Number.isSafeInteger(body.sequence) || !Number.isFinite(observed) || !["working", "idle"].includes(String(body.status))) throw new Error("Invalid local native activity.");
      if (Number(body.sequence) <= Number(row.native_sequence) || (row.native_observed_at && observed < Date.parse(String(row.native_observed_at)))) {
        db.exec("COMMIT");
        return json({ accepted: false, lease_heartbeats: [] });
      }
      db.prepare("UPDATE local_supervisor_sessions SET native_sequence=?,native_observed_at=?,native_status=? WHERE session_id=?")
        .run(body.sequence, body.observed_at, body.status, session.session_id);
      const lease_heartbeats = heartbeatLocalWorkLeases(db, session.session_id, new Date().toISOString());
      db.exec("COMMIT");
      return json({ accepted: true, lease_heartbeats });
    } catch (error) { rollback(db); throw error; }
  }
  if (operation[0] === "tasks") {
    const db = await localSupervisionDatabase();
    const tasks = (await listLocalTasks(roomId)).map(task => ({ ...task,
      active_leases: readLocalWorkLeases(db, roomId, task.id) }));
    if (operation[1]) {
      const task = tasks.find(task => task.id === operation[1]);
      return task ? json({ ...task, room_id: roomId }) : json({ error: "Task not found." }, 404);
    }
    return json({ room_id: roomId, tasks, has_more: false });
  }
  return json({ error: "Unknown local room operation." }, 404);
}

export async function readLocalSupervisorWork(roomId: string, afterCursor: string | null) {
  const db = await localSupervisionDatabase();
  const rows = db.prepare("SELECT * FROM local_supervisor_work WHERE room_id=? ORDER BY updated_at DESC,attempt_id LIMIT 51").all(roomId);
  const work = rows.slice(0, 50).map((row) => ({ attempt_id: row.attempt_id, room_id: roomId,
    source_message_id: row.source_message_id, agent_key: row.agent_key, revision: row.revision,
    summary: JSON.parse(String(row.summary_json)), updated_at: row.updated_at }));
  const snapshot = { work, truncated: rows.length > 50 };
  const cursor = `rw1.${hash(roomId)}.${hash(snapshot)}`;
  return { room_id: roomId, cursor, changed: cursor !== afterCursor, snapshot: cursor === afterCursor ? null : snapshot };
}

type LocalToolInput = {
  provider: string; toolName: string; input: unknown; requestId: string; roomId: string;
  apiUrl: string; bearer: string; cwd: string; agentSession: { session_id: string; agent_key: string; room_id: string };
};
/** The daemon performs the same effect fencing and journaling before entering either transport. */
export async function executeLocalSupervisorTool(input: LocalToolInput) {
  if (input.apiUrl !== LOCAL_ROOM_API_ORIGIN) throw new Error("Invalid local tool authority.");
  const worker = await authorizeLocalWorker(input.roomId, input.bearer, input.agentSession.session_id);
  if (worker.agent_key !== input.agentSession.agent_key || worker.runtime !== input.provider
    || input.agentSession.room_id !== input.roomId) throw new Error("Local tool worker identity changed.");
  const args = object(input.input);
  const leaseWorker = { ...worker, supervised: true };
  if (args.room_id && args.room_id !== input.roomId) throw new Error("This tool is scoped to the agent's local room.");
  let value: unknown;
  switch (input.toolName) {
    case "get_current_room": value = { room_id: input.roomId, storage: "local", room: await getLocalRoom(input.roomId) }; break;
    case "read_messages": {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
      value = args.before_message_id ? await getLocalChatMessagesBefore(input.roomId, String(args.before_message_id), { limit })
        : args.after_message_id ? await getLocalChatMessages(input.roomId, { after: String(args.after_message_id), limit })
          : await getLatestLocalChatMessages(input.roomId, { limit });
      break;
    }
    case "send_message":
    case "send_thread_message":
    case "post_status":
    case "post_reasoning": {
      const text = input.toolName === "post_status" ? `[status] ${required(args.status, "status")}`
        : input.toolName === "post_reasoning" ? `[reasoning] ${required(args.summary, "summary")}` : required(args.text, "text");
      const thread = optional(args.thread_parent_id ?? args.thread_root_id ?? args.root_message_id);
      if (input.toolName === "send_thread_message" && !thread) throw new Error("A thread parent is required.");
      const message = await addLocalChatMessage(input.roomId, { sender: worker.actor_label, text,
        source: "agent", publisher_agent_key: worker.agent_key, publisher_agent_session_id: worker.session_id,
        idempotency_key: `local-supervised-tool:${worker.agent_key}:${input.requestId}`,
        reply_to: optional(args.reply_to ?? args.reply_to_id) ?? (thread ? thread : null), thread_root_id: thread });
      value = { room_id: input.roomId, message }; break;
    }
    case "get_board": value = { room_id: input.roomId, tasks: await listLocalTasks(input.roomId) }; break;
    case "create_task":
    case "add_task": value = { task: await addLocalTask(input.roomId, { title: required(args.title, "title"),
      description: optional(args.description), createdBy: worker.actor_label,
      clientTaskId: `${worker.agent_key}:${required(args.client_task_id, "client task id")}` }) }; break;
    case "claim_task": value = await claimLocalTaskWorkLease(input.roomId, required(args.task_id, "task id"), leaseWorker); break;
    case "complete_task":
    case "update_task": value = { task: await updateLocalTask(input.roomId, required(args.task_id, "task id"), {
      status: input.toolName === "complete_task" ? "in_review" : optional(args.status),
      ...(Object.hasOwn(args, "pr_url") ? { prUrl: optional(args.pr_url) } : {}),
      ...(Object.hasOwn(args, "assignee") ? { assignee: optional(args.assignee) } : {}),
      ...(Object.hasOwn(args, "assignee_agent_key") ? { assigneeAgentKey: optional(args.assignee_agent_key) } : {}),
      ...(Array.isArray(args.workflow_artifacts) ? { workflowArtifacts: args.workflow_artifacts as never } : {}),
    }, leaseWorker) }; break;
    case "release_task_lease":
    case "handoff_task_lease": value = await changeLocalTaskWorkLease(input.roomId, required(args.task_id, "task id"), {
      action: input.toolName === "release_task_lease" ? "release" : "handoff", lease_id: optional(args.lease_id),
      ...(args.epoch !== undefined ? { epoch: Number(args.epoch) } : {}),
      target_actor_key: optional(args.target_agent_key), target_actor_instance_id: optional(args.target_actor_instance_id),
      target_agent_session_id: optional(args.target_agent_session_id),
    }, leaseWorker); break;
    case "claim_task_review": value = await claimLocalTaskReviewLease(input.roomId, required(args.task_id, "task id"), {
      holderLabel: worker.actor_label, agentKey: worker.agent_key, agentSessionId: worker.session_id,
    }); break;
    case "get_room_artifacts": value = await getLocalRoomArtifacts(input.roomId, { taskId: optional(args.task_id), limit: Math.min(100, Number(args.limit) || 100) }); break;
    case "publish_room_artifact": value = await publishLocalRoomArtifact({ roomId: input.roomId, artifact: object(args.artifact),
      taskId: optional(args.task_id), linkedTaskIds: Array.isArray(args.linked_task_ids) ? args.linked_task_ids : [], worker: leaseWorker }); break;
    case "get_message_thread": value = await getLocalMessageThread(input.roomId, required(args.root_message_id ?? args.message_id, "message id")); break;
    default: {
      const result = { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "local_room_tool_unavailable",
        error: `${input.toolName} is not available in local rooms. Continue with the available room tools.` }) }] };
      return { liveResult: result, durableResult: result };
    }
  }
  const liveResult = { content: [{ type: "text", text: JSON.stringify(value) }] };
  const readOnly = ["get_current_room", "read_messages", "get_board", "get_room_artifacts", "get_message_thread"].includes(input.toolName);
  return { liveResult, durableResult: !readOnly || Buffer.byteLength(JSON.stringify(liveResult)) <= 16_384 ? liveResult
    : { content: [{ type: "text", text: "The local read completed. Read again to retrieve its full result." }] } };
}

/** Read retained work with exact local room and attempt identity; never follows a cloud alias. */
export async function readLocalSupervisorWorkEntry(roomId: string, attemptId: string, pageIndex?: number) {
  if (!await getLocalRoom(roomId)) throw new Error("This local room is no longer available.");
  const db = await localSupervisionDatabase();
  const row = db.prepare("SELECT * FROM local_supervisor_work WHERE room_id=? AND attempt_id=?").get(roomId, attemptId);
  if (!row) throw new Error("This local work review is no longer available.");
  if (pageIndex !== undefined) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error("Invalid local review page.");
    const page = db.prepare("SELECT page_json FROM local_supervisor_work_review_pages WHERE attempt_id=? AND page_index=?").get(attemptId, pageIndex);
    return page ? { status: "ready", page: JSON.parse(String(page.page_json)) } : { status: "pending", page: null };
  }
  return { attempt_id: row.attempt_id, room_id: row.room_id, source_message_id: row.source_message_id,
    agent_key: row.agent_key, revision: row.revision, summary: JSON.parse(String(row.summary_json)), updated_at: row.updated_at };
}
