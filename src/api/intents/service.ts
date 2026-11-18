import type { ApiActor } from "../../../shared/api/actor.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import {
  intentCapability,
  parseIntentPayload,
  type Intent,
  type IntentKind,
  type IntentState,
  type TaskCreatePayload,
  type TaskUpdatePayload,
  type TicketCommentPayload,
  type TicketTransitionPayload,
} from "../../../shared/api/intents.mjs";
import { ROOM_RESOURCE_INTENTS } from "../../../shared/room-resource-invalidation.mjs";
import {
  ApiIntentClientIdConflictError,
  findApiIntentByClientId,
  getApiIntent,
  getRunningApiIntent,
  insertApiIntent,
  listApiIntents,
  listStaleRunningApiIntents,
  moveApiIntent,
  sameClientIntent,
  type ApiIntentRow,
} from "../db/api-intents.js";
import type { WorkflowEffect } from "../db/types/effects.js";
import type { Project } from "../db/types.js";
import { GitHubAccessUnavailableError } from "../github/repo-access.js";
import { emitProjectMessage, queueRoomResourceInvalidation } from "../server/events.js";
import type { RoomAccessAccount } from "../rooms/access.js";
import { resolvePolicy, type ResolvedApiPolicy } from "../v1/policy.js";
import {
  checkTaskUpdate,
  createDefaultTaskIntentBoard,
  intentClientTaskId,
  runTaskCreate,
  runTaskUpdate,
  TaskIntentRefusal,
  type TaskIntentBoard,
} from "./task-executor.js";
import {
  createDefaultTicketIntentDeps,
  intentEffectKey,
  intentIdFromEffectKey,
  planTicketWrite,
  ticketEffectOutcome,
  ticketEffectRequest,
  type TicketIntentDeps,
  type TicketWritePlan,
} from "./ticket-executor.js";

/** A person's role in the room as their own routes decide it; `none` when they can no longer open it. */
export type IntentRoomRole = "admin" | "participant" | "none";

export interface IntentServiceDeps {
  resolvePolicy(roomId: string, capability: "tasks.propose" | "tickets.propose", actor: ApiActor): Promise<ResolvedApiPolicy>;
  /**
   * The proposer's role now. With `account` (a live request) it is decided
   * with that credential; with only the id (an admin approving later) it is
   * decided with the person's stored GitHub credential for a repository room.
   */
  roomRole(room: Project, who: { accountId: string; account?: RoomAccessAccount | null }): Promise<IntentRoomRole>;
  board(): Promise<TaskIntentBoard>;
  tickets(): Promise<TicketIntentDeps | null>;
  /** The room notice that asks a room admin to decide. */
  notifyApprovers(room: Project, intent: ApiIntentRow): Promise<void>;
  /** An `intents` pointer event for the room. */
  invalidate(roomId: string): void;
  now(): string;
}

let defaultBoard: Promise<TaskIntentBoard> | null = null;
let defaultTickets: Promise<TicketIntentDeps | null> | null = null;

export const defaultIntentServiceDeps: IntentServiceDeps = {
  resolvePolicy,
  roomRole: decideIntentRoomRole,
  board: () => (defaultBoard ??= createDefaultTaskIntentBoard()),
  tickets: () => (defaultTickets ??= createDefaultTicketIntentDeps()),
  notifyApprovers: postApprovalNotice,
  invalidate: (roomId) => queueRoomResourceInvalidation(roomId, ROOM_RESOURCE_INTENTS),
  now: () => new Date().toISOString(),
};

export function toIntent(row: ApiIntentRow): Intent {
  return {
    id: row.id,
    kind: row.kind as IntentKind,
    payload: row.payload,
    state: row.state as IntentState,
    proposedBy: {
      principal: {
        kind: row.principal_kind as "person" | "agent",
        id: row.principal_id,
        ...(row.principal_login ? { login: row.principal_login } : {}),
      },
      ...(row.via_kind && row.via_id ? {
        via: {
          kind: row.via_kind as "page" | "job" | "integration",
          id: row.via_id,
          ...(row.via_version === null ? {} : { version: row.via_version }),
        },
      } : {}),
    },
    clientIntentId: row.client_intent_id,
    decidedBy: row.decided_by,
    decidedAt: isoTime(row.decided_at),
    result: row.result ?? null,
    error: row.error,
    createdAt: isoTime(row.created_at)!,
    updatedAt: isoTime(row.updated_at)!,
  };
}

/** Postgres answers timestamps in its own text form; the API sends ISO 8601. */
function isoTime(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** What a run needs that the room can change while an intent waits: decided again at each run. */
type RunContext =
  | { kind: "task"; isAdmin: boolean }
  | { kind: "ticket"; plan: TicketWritePlan };

/**
 * Proposes one write for an actor in a room. Pages and people reach it
 * through `intents.propose`; agents will reach it through MCP. Room policy
 * decides:
 * - `deny`: refused with `not_granted`; nothing is stored. (The /api/v1
 *   capability check already refuses it before any handler runs.)
 * - `confirm`: a page asks the viewer in an app-drawn sheet before it calls,
 *   so a call that arrives is confirmed: it runs.
 * - `allow`: runs now.
 * - `approve`: waits as `pending_approval`; a room message asks a room admin.
 *   A ticket write the viewer's own connection runs on the room's tracker
 *   site needs no admin while the default rule (`own_tracker_connection`)
 *   applies.
 * Checks that could never pass (an unknown task, a ticket outside the room
 * filter, a change only an admin may make) refuse at once instead of waiting.
 */
export async function proposeIntent(
  input: {
    actor: ApiActor;
    room: Project;
    /** The signed-in person behind a person actor; null for an agent. */
    account: RoomAccessAccount | null;
    kind: IntentKind;
    payload: unknown;
    /** The caller's retry key (`clientIntentId`). */
    clientIntentId?: string;
    /** The policy the caller already resolved for this call (the /api/v1 check); read here otherwise. */
    policy?: ResolvedApiPolicy;
  },
  deps: IntentServiceDeps = defaultIntentServiceDeps,
): Promise<{ intent: Intent; created: boolean }> {
  const { actor, room, kind } = input;
  const parsed = parseIntentPayload(kind, input.payload);
  if (!parsed.success) {
    throw new ApiError("invalid_input", parsed.error.issues.map((issue) => `payload.${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  const payload = parsed.data as Record<string, unknown>;
  if (input.clientIntentId) {
    // A retry: the first intent, as it is now. Nothing is checked or run again.
    const first = await findApiIntentByClientId(room.id, actor.principal, input.clientIntentId);
    if (first) return { intent: toIntent(await refreshIntent(room.id, clientIntent(first, kind, payload), deps)), created: false };
  }
  const capability = intentCapability({ kind });
  const policy = input.policy ?? await deps.resolvePolicy(room.id, capability, actor);
  if (policy.mode === "deny") {
    throw new ApiError("not_granted", `This room does not allow "${capability}" through the LetAgents API.`);
  }
  let mode: "allow" | "approve" = policy.mode === "approve" ? "approve" : "allow";

  let context: RunContext;
  if (kind === "task.create" || kind === "task.update") {
    if (!actsInPersonOrThroughPage(actor) || !input.account) {
      throw new ApiError("not_granted",
        "Board changes through the API need the person in the LetAgents app or a page they opened; agents and tokens use board intents.");
    }
    const role = await deps.roomRole(room, { accountId: actor.principal.id, account: input.account });
    if (role === "none") throw new ApiError("not_participant", "You are not a participant in this room.");
    context = { kind: "task", isAdmin: role === "admin" };
    if (kind === "task.update") {
      await refusalAsApiError(checkTaskUpdate(await deps.board(), {
        roomId: room.id, payload: payload as TaskUpdatePayload, isAdmin: context.isAdmin,
      }));
    }
  } else {
    const tickets = await deps.tickets();
    if (!tickets) throw new ApiError("no_source", "Tracker connectors are not set up on this server.");
    const plan = await planTicketWrite(tickets, {
      roomId: room.id,
      key: (payload as TicketTransitionPayload | TicketCommentPayload).key,
      accountId: actor.principal.kind === "person" ? actor.principal.id : null,
    });
    context = { kind: "ticket", plan };
    // Only the viewer's own connection writes as the viewer, and only while
    // the viewer acts in person or through a page they opened. Any other
    // write (the filter owner's credentials, or the person's own connection
    // used by a token or an agent's integration) waits for a room admin, also
    // when the room set this capability to allow or confirm.
    if (!plan.own || !actsInPersonOrThroughPage(actor)) mode = "approve";
    else if (mode === "approve" && policy.rule === "own_tracker_connection") mode = "allow";
  }

  const now = deps.now();
  if (mode === "approve") {
    const { row, created } = await clientIdConflictAsApiError(insertApiIntent({
      roomId: room.id, kind, payload, actor, state: "pending_approval", clientIntentId: input.clientIntentId, now,
    }));
    if (created) {
      deps.invalidate(room.id);
      try {
        await deps.notifyApprovers(room, row);
      } catch (error) {
        // The intent is stored and listed as pending; the notice is a convenience.
        console.warn("[api intents] the approval notice failed", { roomId: room.id, intentId: row.id, error });
      }
    }
    return { intent: toIntent(row), created };
  }
  const { row, created } = await clientIdConflictAsApiError(insertApiIntent({
    roomId: room.id, kind, payload, actor, state: "running", clientIntentId: input.clientIntentId, now,
  }));
  if (!created) return { intent: toIntent(await refreshIntent(room.id, row, deps)), created: false };
  deps.invalidate(room.id);
  return { intent: toIntent(await runIntent(room, row, context, deps)), created: true };
}

/**
 * A room admin approves; the intent then runs with the proposer's rights,
 * checked again now. Approving again runs nothing twice: only the call that
 * moves the intent from `approved` to `running` runs it. An intent left
 * `approved` (the server stopped between the two steps) runs on the next
 * approve.
 */
export async function approveIntent(
  input: { room: Project; intentId: string; adminAccountId: string },
  deps: IntentServiceDeps = defaultIntentServiceDeps,
): Promise<Intent> {
  const { room } = input;
  let row = await requireIntent(room.id, input.intentId);
  if (row.state === "pending_approval") {
    const now = deps.now();
    const approved = await moveApiIntent(room.id, row.id, ["pending_approval"], {
      state: "approved", decided_by: input.adminAccountId, decided_at: now,
    }, now);
    if (approved) deps.invalidate(room.id);
    row = approved ?? await requireIntent(room.id, row.id);
  }
  if (row.state === "denied") throw new ApiError("conflict", "A room admin already denied this intent.");
  if (row.state !== "approved") return toIntent(await refreshIntent(room.id, row, deps));

  const running = await moveApiIntent(room.id, row.id, ["approved"], { state: "running" }, deps.now());
  if (!running) return toIntent(await refreshIntent(room.id, await requireIntent(room.id, row.id), deps));
  deps.invalidate(room.id);
  let context: RunContext;
  try {
    context = await runContextNow(room, running, deps);
  } catch (error) {
    if (isTransient(error)) {
      // GitHub or the tracker did not answer, or the room's tracker budget is
      // spent: nothing ran, so the intent stays approved and the next approve runs it.
      await moveApiIntent(room.id, running.id, ["running"], { state: "approved" }, deps.now());
      throw error;
    }
    return toIntent(await finish(room.id, running, { state: "failed", error: failureText(error) }, deps));
  }
  return toIntent(await runIntent(room, running, context, deps));
}

/**
 * A room admin refuses an intent that has not started (pending, or approved
 * but not yet running); nothing is written. Denying again returns it.
 */
export async function denyIntent(
  input: { room: Project; intentId: string; adminAccountId: string; reason?: string },
  deps: IntentServiceDeps = defaultIntentServiceDeps,
): Promise<Intent> {
  const { room } = input;
  const row = await requireIntent(room.id, input.intentId);
  if (row.state === "pending_approval" || row.state === "approved") {
    const now = deps.now();
    const reason = input.reason?.trim();
    const denied = await moveApiIntent(room.id, row.id, ["pending_approval", "approved"], {
      state: "denied",
      decided_by: input.adminAccountId,
      decided_at: now,
      error: reason ? `A room admin denied it: ${reason}` : "A room admin denied it.",
    }, now);
    if (denied) {
      deps.invalidate(room.id);
      return toIntent(denied);
    }
  }
  const current = await requireIntent(room.id, row.id);
  if (current.state === "denied") return toIntent(current);
  throw new ApiError("conflict", "This intent already started or finished.");
}

export async function getIntent(roomId: string, intentId: string, deps: IntentServiceDeps = defaultIntentServiceDeps): Promise<Intent> {
  return toIntent(await refreshIntent(roomId, await requireIntent(roomId, intentId), deps));
}

export async function listIntents(
  roomId: string,
  options: { state?: IntentState; limit: number },
  deps: IntentServiceDeps = defaultIntentServiceDeps,
): Promise<Intent[]> {
  const rows = await listApiIntents(roomId, options);
  const fresh = await Promise.all(rows.map((row) => refreshIntent(roomId, row, deps)));
  // A ticket write that settled since the last read may have left the asked state.
  return fresh.filter((row) => !options.state || row.state === options.state).map(toIntent);
}

async function requireIntent(roomId: string, intentId: string): Promise<ApiIntentRow> {
  const row = await getApiIntent(roomId, intentId);
  if (!row) throw new ApiError("not_found", "No intent with this id in this room.");
  return row;
}

async function refusalAsApiError<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof TaskIntentRefusal) throw new ApiError(error.code, error.message);
    throw error;
  }
}

async function runContextNow(room: Project, row: ApiIntentRow, deps: IntentServiceDeps): Promise<RunContext> {
  const kind = row.kind as IntentKind;
  if (kind === "task.create" || kind === "task.update") {
    // proposeIntent stores board kinds only from a person in person or through a page.
    if (row.principal_kind !== "person" || (row.via_kind !== null && row.via_kind !== "page")) {
      throw new ApiError("not_granted", "Board changes through the API need the person in the LetAgents app or a page they opened.");
    }
    const role = await deps.roomRole(room, { accountId: row.principal_id });
    if (role === "none") throw new ApiError("not_participant", "The person who proposed this can no longer open this room.");
    return { kind: "task", isAdmin: role === "admin" };
  }
  const tickets = await deps.tickets();
  if (!tickets) throw new ApiError("no_source", "Tracker connectors are not set up on this server.");
  const plan = await planTicketWrite(tickets, {
    roomId: room.id,
    key: String(row.payload.key ?? ""),
    accountId: row.principal_kind === "person" ? row.principal_id : null,
  });
  return { kind: "ticket", plan };
}

/** Runs an intent that is `running`, once, and stores how it ended. */
async function runIntent(room: Project, row: ApiIntentRow, context: RunContext, deps: IntentServiceDeps): Promise<ApiIntentRow> {
  const kind = row.kind as IntentKind;
  try {
    if (context.kind === "task") {
      const board = await deps.board();
      const result = kind === "task.create"
        ? await runTaskCreate(board, { roomId: room.id, intentId: row.id, payload: row.payload as TaskCreatePayload, isAdmin: context.isAdmin })
        : await runTaskUpdate(board, { roomId: room.id, payload: row.payload as TaskUpdatePayload, isAdmin: context.isAdmin });
      return await finish(room.id, row, { state: "done", result }, deps);
    }
    const tickets = (await deps.tickets())!;
    const reserved = await tickets.reserve(ticketEffectRequest({
      roomId: room.id,
      intentId: row.id,
      kind: kind as "ticket.transition" | "ticket.comment",
      payload: row.payload as { toStatus?: string; body?: string },
      plan: context.plan,
      actorLabel: actorLabel(row),
    }));
    // Linked before the write runs, so a stop in between leaves a row the journal sweep finishes.
    const linked = await moveApiIntent(room.id, row.id, ["running"], { effect_id: reserved.effect.id }, deps.now()) ?? row;
    const outcome = ticketEffectOutcome(await tickets.drive(reserved));
    return outcome.state === "running" ? linked : await finish(room.id, linked, outcome, deps);
  } catch (error) {
    return finish(room.id, row, { state: "failed", error: failureText(error) }, deps);
  }
}

async function finish(
  roomId: string,
  row: ApiIntentRow,
  end: { state: "done"; result: Record<string, unknown> } | { state: "failed"; error: string },
  deps: IntentServiceDeps,
): Promise<ApiIntentRow> {
  const moved = await moveApiIntent(roomId, row.id, ["running"], end.state === "done"
    ? { state: "done", result: end.result, error: null }
    : { state: "failed", error: end.error.slice(0, 2_000) }, deps.now());
  if (moved) deps.invalidate(roomId);
  return moved ?? await getApiIntent(roomId, row.id) ?? row;
}

/**
 * A running ticket write follows its journal row, found by its idempotency
 * key (`effect_id` is cleared when the journal prunes a settled row).
 */
async function refreshIntent(roomId: string, row: ApiIntentRow, deps: IntentServiceDeps): Promise<ApiIntentRow> {
  if (row.state !== "running" || !row.kind.startsWith("ticket.")) return row;
  const tickets = await deps.tickets();
  const effect = tickets ? await tickets.findEffect(roomId, intentEffectKey(row.id)) : null;
  if (!effect) return row;
  const outcome = ticketEffectOutcome(effect);
  return outcome.state === "running" ? row : finish(roomId, row, outcome, deps);
}

/**
 * The effect broker calls this after every write or lookup it runs. An
 * intent's ticket write finishes its intent here, whether a request or the
 * journal sweep ran it.
 */
export async function settleIntentFromEffect(effect: WorkflowEffect, deps: IntentServiceDeps = defaultIntentServiceDeps): Promise<void> {
  const intentId = intentIdFromEffectKey(effect.idempotency_key);
  if (!intentId) return;
  const row = await getRunningApiIntent(effect.room_id, intentId);
  if (!row) return;
  const outcome = ticketEffectOutcome(effect);
  if (outcome.state !== "running") await finish(effect.room_id, row, outcome, deps);
}

/** How long an intent may stay `running` before the sweep looks at it. */
export const STUCK_INTENT_AFTER_MS = 10 * 60_000;
/** A ticket write the tracker never confirmed (a comment stays ambiguous) fails after this. */
export const UNCONFIRMED_TICKET_WRITE_FAILS_AFTER_MS = 24 * 60 * 60_000;

/**
 * Intents a stopped server left `running`. A board change runs in one
 * request, so one still running after ten minutes was cut short:
 * - `task.create`: done when its card exists (the card's creation id is the
 *   intent's), else failed. Nothing is run again.
 * - `task.update`: failed; the person reads the task and proposes again.
 * - ticket kinds: finished from the journal row with the intent's key. No
 *   row: it never reached the journal, so failed. A row still unsettled:
 *   the journal sweep retries it; the intent goes to the back of the queue,
 *   and fails after a day without a confirmed write.
 */
export async function sweepStuckIntents(deps: IntentServiceDeps = defaultIntentServiceDeps, limit = 50): Promise<number> {
  const nowMs = Date.parse(deps.now());
  const stale = await listStaleRunningApiIntents(new Date(nowMs - STUCK_INTENT_AFTER_MS).toISOString(), limit);
  for (const row of stale) {
    try {
      await sweepOne(row, nowMs, deps);
    } catch (error) {
      console.error(`[api intents] the stuck intent sweep failed for ${row.id}`, error);
    }
  }
  return stale.length;
}

async function sweepOne(row: ApiIntentRow, nowMs: number, deps: IntentServiceDeps): Promise<void> {
  const stopped = "The server stopped while it made this change. Read the current state and propose it again if it is still needed.";
  if (row.kind === "task.create") {
    const card = await (await deps.board()).findTaskByClientId(row.room_id, intentClientTaskId(row.id));
    await finish(row.room_id, row, card ? { state: "done", result: { taskId: card.id } } : { state: "failed", error: stopped }, deps);
    return;
  }
  if (row.kind === "task.update") {
    await finish(row.room_id, row, { state: "failed", error: stopped }, deps);
    return;
  }
  const tickets = await deps.tickets();
  const effect = tickets ? await tickets.findEffect(row.room_id, intentEffectKey(row.id)) : null;
  if (!effect) {
    await finish(row.room_id, row, { state: "failed", error: "The tracker was not changed: the server stopped before the write started." }, deps);
    return;
  }
  const outcome = ticketEffectOutcome(effect);
  if (outcome.state !== "running") {
    await finish(row.room_id, row, outcome, deps);
  } else if (nowMs - Date.parse(row.created_at) > UNCONFIRMED_TICKET_WRITE_FAILS_AFTER_MS) {
    await finish(row.room_id, row, { state: "failed", error: "The tracker never confirmed this change. Check the ticket." }, deps);
  } else {
    await moveApiIntent(row.room_id, row.id, ["running"], {}, deps.now());
  }
}

/** A person in the LetAgents app, or a page they opened. Not an agent, a job, an owner token or another integration. */
function actsInPersonOrThroughPage(actor: ApiActor): boolean {
  return actor.principal.kind === "person" && (!actor.via || actor.via.kind === "page");
}

function clientIntent(row: ApiIntentRow, kind: IntentKind, payload: Record<string, unknown>): ApiIntentRow {
  try {
    return sameClientIntent(row, kind, payload);
  } catch (error) {
    if (error instanceof ApiIntentClientIdConflictError) throw new ApiError("conflict", error.message);
    throw error;
  }
}

async function clientIdConflictAsApiError<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiIntentClientIdConflictError) throw new ApiError("conflict", error.message);
    throw error;
  }
}

function isTransient(error: unknown): boolean {
  return (error instanceof ApiError && (error.code === "rate_limited" || error.code === "source_unavailable"))
    || error instanceof GitHubAccessUnavailableError;
}

function failureText(error: unknown): string {
  if (error instanceof ApiError || error instanceof TaskIntentRefusal) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  // Board refusals the person's own routes answer with 409 carry a message meant for people.
  if (typeof code === "string" && error instanceof Error
    && /^(?:task_|coordination_|lease_|imported_card|workflow_effect_connection)/.test(code)) {
    return error.message;
  }
  console.error("[api intents] the change failed", error);
  return "The change could not be made. Propose it again, or ask a room admin.";
}

/** How the journal and the room name who made the change. */
function actorLabel(row: ApiIntentRow): string {
  const who = row.principal_kind === "agent" ? `agent:${row.principal_id}` : row.principal_login ?? row.principal_id;
  return row.via_kind && row.via_id ? `${who} via ${row.via_kind}:${row.via_id}` : who;
}

/** What the change does, in a few words, with mentions neutralised. */
export function describeIntent(kind: IntentKind, payload: Record<string, unknown>, safe: (value: string, fallback: string) => string): string {
  const text = (value: unknown, fallback: string) => safe(typeof value === "string" ? value : "", fallback);
  switch (kind) {
    case "task.create":
      return `create the task "${text(payload.title, "Untitled task")}"`;
    case "task.update": {
      const task = text(payload.taskId, "a task");
      const changes = [
        typeof payload.status === "string" ? `move ${task} to ${text(payload.status, "a new status")}` : null,
        payload.assignee !== undefined ? (payload.assignee === null ? `unassign ${task}` : `assign ${task} to ${text(payload.assignee, "someone")}`) : null,
        payload.title !== undefined || payload.description !== undefined ? `edit ${task}` : null,
      ].filter(Boolean);
      return changes.length ? changes.join(" and ") : `change ${task}`;
    }
    case "ticket.transition":
      return `move ${text(payload.key, "a ticket")} to ${text(payload.toStatus, "a new status")}`;
    case "ticket.comment":
      return `comment on ${text(payload.key, "a ticket")}`;
  }
}

/** The room notice for a pending intent. It names nobody, so it wakes no agent. */
async function postApprovalNotice(room: Project, row: ApiIntentRow): Promise<void> {
  const { safeNotificationFragment } = await import("../routes/rooms/board.js");
  const who = row.principal_kind === "agent"
    ? safeNotificationFragment(`agent ${row.principal_id}`, "An agent")
    : safeNotificationFragment(row.principal_login, "A participant");
  const via = row.via_kind === "page" && row.via_id ? ` (through page ${safeNotificationFragment(row.via_id, "a page")})` : "";
  const action = describeIntent(row.kind as IntentKind, row.payload, safeNotificationFragment);
  await emitProjectMessage(room.id, "letagents",
    `[status] ${who}${via} proposes to ${action}. Intent ${row.id} waits for a room admin to approve or deny it.`,
    {
      source: "system",
      client_message_id: `api_intent:${row.id}:approval_notify`,
      display_text: `${who}${via} wants to ${action}. A room admin needs to approve or deny it.`,
    });
}

/** The proposer's role, decided as their own routes decide it. */
async function decideIntentRoomRole(room: Project, who: { accountId: string; account?: RoomAccessAccount | null }): Promise<IntentRoomRole> {
  const access = await import("../rooms/access-decision.js");
  const target = await access.classifyRoomAccess(room);
  let account = who.account ?? null;
  if (!account && target.kind === "repo") {
    // Like the tracker rules' owner check: the person's stored GitHub credential; none, no access.
    const { getSupervisorGrantOwnerAccount } = await import("../db/supervisor-grant-revocation.js");
    account = await getSupervisorGrantOwnerAccount(who.accountId);
    if (!account) return "none";
  }
  const decision = await access.decideRoomAdmin({
    project: room,
    target,
    principal: account ? { kind: "person", account } : { kind: "account", accountId: who.accountId },
    outage: "throw",
  });
  if (decision.kind !== "allow") return "none";
  return decision.role === "admin" ? "admin" : "participant";
}
