// Intents: proposed writes that room policy decides and an executor carries out.
// Methods are added here with defineMethod from ./core.mjs; see docs/api/README.md.
import { z } from "zod";

import { ActorPrincipal, ActorVia } from "./actor.mjs";
import { defineMethod, queryInt } from "./core.mjs";

/**
 * - `task.create`, `task.update`: a board change, run as the person who
 *   proposed it, with that person's own board rights.
 * - `ticket.transition`, `ticket.comment`: a write to a ticket inside the
 *   room's tracker filter, through the effect journal.
 */
export const INTENT_KINDS = /** @type {const} */ (["task.create", "task.update", "ticket.transition", "ticket.comment"]);

/**
 * - `pending_approval`: waits for a room admin.
 * - `approved`: a room admin approved it; it is about to run.
 * - `running`: started. A ticket write stays here while the tracker is retried.
 * - `done`, `failed`: ran; `result` or `error` says what happened.
 * - `denied`: a room admin refused it. Nothing was written.
 */
export const INTENT_STATES = /** @type {const} */ (["pending_approval", "approved", "running", "done", "failed", "denied"]);
export const FINISHED_INTENT_STATES = /** @type {const} */ (["done", "failed", "denied"]);

/** The board statuses a task can be moved to. Some need a room admin; see `intents.propose`. */
export const INTENT_TASK_STATUSES = /** @type {const} */ ([
  "proposed", "accepted", "assigned", "in_progress", "blocked", "in_review", "merged", "done", "cancelled",
]);

/** @typedef {typeof INTENT_KINDS[number]} IntentKind */
/** @typedef {typeof INTENT_STATES[number]} IntentState */

export const INTENT_LIMITS = Object.freeze({
  titleChars: 512,
  descriptionChars: 100_000,
  commentChars: 16_000,
  statusChars: 200,
  reasonChars: 500,
});

const taskTitle = z.string().trim().min(1).max(INTENT_LIMITS.titleChars);
const taskDescription = z.string().max(INTENT_LIMITS.descriptionChars);
const ticketKey = z.string().trim().min(1).max(64);

export const TaskCreatePayload = z.strictObject({
  title: taskTitle,
  description: taskDescription.optional(),
});

export const TaskUpdatePayload = z.strictObject({
  taskId: z.string().min(1).max(64),
  status: z.enum(INTENT_TASK_STATUSES).optional(),
  /** The assignee's name as the board shows it; null clears it. */
  assignee: z.string().trim().min(1).max(200).nullable().optional(),
  /** The agent key when the assignee is an agent; null clears it. */
  assigneeAgentKey: z.string().trim().min(1).max(200).nullable().optional(),
  /** Title and description changes need a room admin. */
  title: taskTitle.optional(),
  description: taskDescription.optional(),
});

export const TicketTransitionPayload = z.strictObject({
  /** The ticket key, e.g. `HT-1234`. It must be inside the room's tracker filter. */
  key: ticketKey,
  /** The status to move to, as the tracker names it, e.g. `In Progress`. */
  toStatus: z.string().trim().min(1).max(INTENT_LIMITS.statusChars),
});

export const TicketCommentPayload = z.strictObject({
  key: ticketKey,
  body: z.string().trim().min(1).max(INTENT_LIMITS.commentChars),
});

/** @typedef {z.infer<typeof TaskCreatePayload>} TaskCreatePayload */
/** @typedef {z.infer<typeof TaskUpdatePayload>} TaskUpdatePayload */
/** @typedef {z.infer<typeof TicketTransitionPayload>} TicketTransitionPayload */
/** @typedef {z.infer<typeof TicketCommentPayload>} TicketCommentPayload */

/** Each kind's payload schema. */
export const INTENT_PAYLOADS = Object.freeze({
  "task.create": TaskCreatePayload,
  "task.update": TaskUpdatePayload,
  "ticket.transition": TicketTransitionPayload,
  "ticket.comment": TicketCommentPayload,
});

/**
 * @typedef {{ kind: "task.create", payload: TaskCreatePayload }
 *   | { kind: "task.update", payload: TaskUpdatePayload }
 *   | { kind: "ticket.transition", payload: TicketTransitionPayload }
 *   | { kind: "ticket.comment", payload: TicketCommentPayload }} IntentProposal
 */

/**
 * The capability a kind uses: board kinds `tasks.propose`, ticket kinds `tickets.propose`.
 * @param {{ kind: IntentKind }} input
 * @returns {"tasks.propose" | "tickets.propose"}
 */
export function intentCapability(input) {
  return input.kind.startsWith("ticket.") ? "tickets.propose" : "tasks.propose";
}

/**
 * Checks a payload against its kind's schema.
 * @param {IntentKind} kind
 * @param {unknown} payload
 */
export function parseIntentPayload(kind, payload) {
  return INTENT_PAYLOADS[kind].safeParse(payload);
}

// One object at the top, so MCP tools can take it as their input; the payload
// is checked against its kind below.
export const ProposeIntentInput = z.strictObject({
  kind: z.enum(INTENT_KINDS),
  payload: z.union([TaskCreatePayload, TaskUpdatePayload, TicketTransitionPayload, TicketCommentPayload]),
}).superRefine((value, ctx) => {
  const parsed = parseIntentPayload(value.kind, value.payload);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: "custom", path: ["payload", ...issue.path], message: issue.message });
  }
  if (value.kind === "task.update" && Object.keys(value.payload).every((key) => key === "taskId")) {
    ctx.addIssue({ code: "custom", path: ["payload"], message: "Name at least one field to change." });
  }
});

export const IntentProposer = z.object({
  principal: ActorPrincipal,
  via: ActorVia.optional(),
});

export const Intent = z.object({
  id: z.string(),
  kind: z.enum(INTENT_KINDS),
  /** The payload as proposed; its shape follows `kind`. */
  payload: z.record(z.string(), z.unknown()),
  state: z.enum(INTENT_STATES),
  proposedBy: IntentProposer,
  /** The room admin (account id) who approved or denied it; null while undecided or when policy allowed it. */
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** What running it did: `{ taskId }` for board kinds, `{ key, url? }` for ticket kinds. */
  result: z.record(z.string(), z.unknown()).nullable(),
  /** Why it failed or was denied. */
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** @typedef {z.infer<typeof Intent>} Intent */

export const IntentList = z.object({ intents: z.array(Intent) });

/** @typedef {z.infer<typeof IntentList>} IntentList */

const intentId = z.string().min(1).max(64);

export const proposeIntent = defineMethod({
  name: "intents.propose",
  area: "intents",
  kind: "intent",
  capability: "tasks.propose",
  capabilityFromInput: intentCapability,
  description:
    "Proposes a write and returns the intent with its state. Kinds: task.create { title, description? }; "
    + "task.update { taskId, status?, assignee?, assigneeAgentKey?, title?, description? } (title, description and the statuses "
    + "accepted, cancelled, merged and done need a room admin's own rights); ticket.transition { key, toStatus }; "
    + "ticket.comment { key, body }. Board kinds need tasks.propose, ticket kinds tickets.propose. The room policy decides: "
    + "the intent runs at once (state running, then done or failed), or waits for a room admin (pending_approval). "
    + "A ticket must be inside the room's tracker filter. A ticket write runs at once only through the viewer's own "
    + "tracker connection on the room's tracker site; otherwise a room admin approves it. Proposing the same pending "
    + "change again returns the pending intent.",
  path: "/rooms/:room/intents",
  input: ProposeIntentInput,
  output: Intent,
  errors: ["not_found", "no_source", "conflict"],
  rateClass: "intent",
});

export const getIntent = defineMethod({
  name: "intents.get",
  area: "intents",
  kind: "read",
  capability: "intents.read",
  description: "One intent in this room by id, with its state, result or error. Read it again after an intents event.",
  path: "/rooms/:room/intents/:intentId",
  input: z.strictObject({ intentId }),
  output: Intent,
  errors: ["not_found"],
  rateClass: "read",
});

export const listIntents = defineMethod({
  name: "intents.list",
  area: "intents",
  kind: "read",
  capability: "intents.read",
  description: "This room's intents, newest first, optionally in one state (pending_approval lists what waits for a room admin).",
  path: "/rooms/:room/intents",
  input: z.strictObject({
    state: z.enum(INTENT_STATES).optional(),
    limit: queryInt({ min: 1, max: 100, default: 50 }),
  }),
  output: IntentList,
  rateClass: "read",
});

export const approveIntent = defineMethod({
  name: "intents.approve",
  area: "intents",
  kind: "write",
  capability: "intents.read",
  description:
    "Approves a pending intent, which then runs at once with the proposer's rights. Approving again returns the intent "
    + "and runs nothing twice. A denied intent gives conflict. Room admins only, signed in to the LetAgents app; pages, "
    + "agents and owner tokens get not_granted.",
  path: "/rooms/:room/intents/:intentId/approve",
  input: z.strictObject({ intentId }),
  output: Intent,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const denyIntent = defineMethod({
  name: "intents.deny",
  area: "intents",
  kind: "write",
  capability: "intents.read",
  description:
    "Denies a pending intent; nothing is written. Denying again returns the intent. An intent that was approved gives "
    + "conflict. Room admins only, signed in to the LetAgents app; pages, agents and owner tokens get not_granted.",
  path: "/rooms/:room/intents/:intentId/deny",
  input: z.strictObject({ intentId, reason: z.string().trim().max(INTENT_LIMITS.reasonChars).optional() }),
  output: Intent,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const methods = /** @type {const} */ ([proposeIntent, getIntent, listIntents, approveIntent, denyIntent]);
