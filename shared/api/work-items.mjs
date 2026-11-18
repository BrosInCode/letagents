// Work items: tickets from the room's tracker sources, always inside the room filter.
// Methods are added here with defineMethod from ./core.mjs; see docs/api/README.md.
import { z } from "zod";

import { defineMethod, queryInt } from "./core.mjs";

/** The tracker kinds a room can import from (same list as shared/ticket-connectors.mjs). */
export const WORK_ITEM_PROVIDERS = /** @type {const} */ (["jira", "linear", "github"]);
/** The room's own ticket states, from the connection's status map (same list as shared/ticket-connectors.mjs). */
export const WORK_ITEM_STATES = /** @type {const} */ (["todo", "in_progress", "in_review", "done"]);
export const WORK_ITEM_STATUS_CATEGORIES = /** @type {const} */ (["todo", "in_progress", "done"]);

export const WORK_ITEM_QUERY_MAX_LENGTH = 2_000;
export const WORK_ITEM_SEARCH_MAX_LIMIT = 200;
export const WORK_ITEM_SEARCH_DEFAULT_LIMIT = 50;
export const WORK_ITEM_MAX_FIELDS = 20;

/** A Jira custom field id, for example `customfield_10016`. */
export const WorkItemFieldId = z.string().regex(/^customfield_\d{1,12}$/, "A field id looks like customfield_10016.");

/**
 * Custom fields to return raw in `fields`: one id, or a list of up to 20. In
 * a query string, repeat the key: `fields=customfield_1&fields=customfield_2`.
 */
export const WorkItemFieldsInput = z.union([WorkItemFieldId, z.array(WorkItemFieldId).max(WORK_ITEM_MAX_FIELDS)]);

export const WorkItemSprint = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["future", "active", "closed"]),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});

export const WorkItemFixVersion = z.object({
  id: z.string(),
  name: z.string(),
  /** Null when the tracker did not say. */
  released: z.boolean().nullable(),
  releaseDate: z.string().nullable(),
});

export const WorkItem = z.object({
  provider: z.enum(WORK_ITEM_PROVIDERS),
  key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  /** The tracker's own status name, for example "Code Review". */
  status: z.string(),
  /** The tracker's status category. */
  statusCategory: z.enum(WORK_ITEM_STATUS_CATEGORIES),
  /** The room's ticket state for this status, from the connection's status map. */
  state: z.enum(WORK_ITEM_STATES),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Null when the ticket has no estimate or the site has no single story points field. */
  storyPoints: z.number().nullable(),
  sprints: z.array(WorkItemSprint),
  /** The parent's key only: the parent may be outside the room filter. Read it with work_items.get. */
  parent: z.object({ key: z.string() }).nullable(),
  fixVersions: z.array(WorkItemFixVersion),
  labels: z.array(z.string()),
  /** When the ticket last moved to another status category. */
  statusChangedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The board task in this room linked to this ticket. */
  linkedTask: z.object({ taskId: z.string() }).nullable(),
  /**
   * Values of the custom fields the call named: plain values as they are;
   * objects and lists of objects keep only id, key, name, value and
   * displayName. A field the ticket does not have is absent.
   */
  fields: z.record(z.string(), z.unknown()),
});

export const WorkItemSearchResult = z.object({
  provider: z.enum(WORK_ITEM_PROVIDERS),
  items: z.array(WorkItem),
  /** When the tracker was read; a repeated search within 60 s may answer from that read. */
  fetchedAt: z.string(),
});

export const WorkItemStatusChange = z.object({
  /** Null for the first status a change history names without a previous one. */
  from: z.string().nullable(),
  to: z.string(),
  at: z.string(),
});

export const WorkItemHistory = z.object({
  provider: z.enum(WORK_ITEM_PROVIDERS),
  key: z.string(),
  /** Status changes, oldest first. */
  transitions: z.array(WorkItemStatusChange),
  /** False when the ticket has more history than one call reads (1,000 changelog entries). */
  complete: z.boolean(),
});

/** @typedef {z.infer<typeof WorkItemSprint>} WorkItemSprint */
/** @typedef {z.infer<typeof WorkItemFixVersion>} WorkItemFixVersion */
/** @typedef {z.infer<typeof WorkItem>} WorkItem */
/** @typedef {z.infer<typeof WorkItemSearchResult>} WorkItemSearchResult */
/** @typedef {z.infer<typeof WorkItemStatusChange>} WorkItemStatusChange */
/** @typedef {z.infer<typeof WorkItemHistory>} WorkItemHistory */

const providerInput = z
  .enum(WORK_ITEM_PROVIDERS)
  .optional()
  .describe("The tracker to read. Without it: Jira when the room imports from Jira.");
const keyInput = z.string().min(1).max(64).describe("The ticket key, for example HT-1234.");

const SCOPE_NOTE =
  "Only tickets inside the room's tracker filter are visible: the tracker runs (<room filter>) AND (<query>), " +
  "with the credentials of the room admin who set the filter. Jira only in this version; a room without an " +
  "enabled Jira filter gets no_source. A room has one source per tracker; should it have more, this version reads " +
  "the oldest Jira source only.";

export const searchWorkItems = defineMethod({
  name: "work_items.search",
  area: "work_items",
  kind: "read",
  capability: "work_items.read",
  description:
    `Search the room's tickets with a Jira JQL query, for example status = "In Progress" AND fixVersion = "2.4". ${SCOPE_NOTE} ` +
    "currentUser() in a query means the filter owner, not the person or page calling. A backslash outside a quoted " +
    "string is refused. ORDER BY is ignored; results " +
    "come newest update first. Each ticket has normalised fields (status, statusCategory, assignee, storyPoints, " +
    "sprints, parent, fixVersions, labels, linkedTask) and, in `fields`, the raw values of the custom fields named " +
    "in `fields` (custom fields a page may read are the ones its manifest names). Results may come from a read up to 60 s old, but never from before a ticket change LetAgents has seen.",
  path: "/rooms/:room/work-items",
  input: z.strictObject({
    query: z.string().max(WORK_ITEM_QUERY_MAX_LENGTH).default("").describe("JQL ANDed with the room filter; empty for every ticket in the filter."),
    provider: providerInput,
    limit: queryInt({ min: 1, max: WORK_ITEM_SEARCH_MAX_LIMIT, default: WORK_ITEM_SEARCH_DEFAULT_LIMIT }),
    fields: WorkItemFieldsInput.optional(),
  }),
  output: WorkItemSearchResult,
  errors: ["no_source"],
  rateClass: "search",
});

export const getWorkItem = defineMethod({
  name: "work_items.get",
  area: "work_items",
  kind: "read",
  capability: "work_items.read",
  description: `One ticket by key, with the same fields as work_items.search. ${SCOPE_NOTE} A ticket outside the filter is not_found.`,
  path: "/rooms/:room/work-items/:key",
  input: z.strictObject({ key: keyInput, provider: providerInput, fields: WorkItemFieldsInput.optional() }),
  output: WorkItem,
  errors: ["not_found", "no_source"],
  rateClass: "read",
});

export const getWorkItemHistory = defineMethod({
  name: "work_items.history",
  area: "work_items",
  kind: "read",
  capability: "work_items.read",
  description:
    `A ticket's status changes with exact times, oldest first, from the tracker's changelog: use it for time in status. ${SCOPE_NOTE} ` +
    "A ticket outside the filter is not_found.",
  path: "/rooms/:room/work-items/:key/history",
  input: z.strictObject({ key: keyInput, provider: providerInput }),
  output: WorkItemHistory,
  errors: ["not_found", "no_source"],
  rateClass: "read",
});

export const methods = /** @type {const} */ ([searchWorkItems, getWorkItem, getWorkItemHistory]);
