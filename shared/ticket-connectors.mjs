/**
 * Ticket connectors: shared constants for the API and the desktop app.
 * See docs/ticket-connectors.md.
 */

/** The generic ticket states every tracker status maps to. */
export const TICKET_STATES = ["todo", "in_progress", "in_review", "done"];

export const TRACKER_PROVIDERS = ["jira", "linear"];

/** What a status that no map entry names becomes, flagged for the user. */
export const UNMAPPED_TICKET_STATE = "in_progress";

/**
 * Default status maps. Keys are tracker status names (case-insensitive) or,
 * for Linear, `type:<state type>`; a name entry wins over a type entry.
 */
export const DEFAULT_STATUS_MAPS = {
  jira: {
    "To Do": "todo",
    "In Progress": "in_progress",
    "In Review": "in_review",
    "Code Review": "in_review",
    "Done": "done",
    "Closed": "done",
  },
  linear: {
    "In Review": "in_review",
    "type:triage": "todo",
    "type:backlog": "todo",
    "type:unstarted": "todo",
    "type:started": "in_progress",
    "type:completed": "done",
    "type:canceled": "done",
  },
};

/** Shown next to the Jev linking switch; the switch defaults to off. */
export const JEV_LINKING_DISCLOSURE = "When this is on, LetAgents asks Jev to link pull requests that name no ticket. "
  + "For each such pull request, its title, a shortened description, commit subjects, and the titles and keys of "
  + "up to 20 open tickets from this connection are sent to Jev's model provider. Jev only suggests links; it never "
  + "changes a ticket by itself. Turn this off to stop sending.";

export const STATUS_MAP_MAX_ENTRIES = 100;
export const STATUS_NAME_MAX_LENGTH = 200;

export function isTicketState(value) {
  return typeof value === "string" && TICKET_STATES.includes(value);
}

export function isTrackerProvider(value) {
  return typeof value === "string" && TRACKER_PROVIDERS.includes(value);
}

/** `created_by` of a card that sync imported from a tracker: `tracker:jira`, `tracker:linear`. */
export const TRACKER_IMPORT_CREATOR_PREFIX = "tracker:";

export function trackerImportCreator(provider) {
  return `${TRACKER_IMPORT_CREATOR_PREFIX}${provider}`;
}

/** Whether sync created the card (an imported card), not a person or an agent. */
export function isTrackerImportCreator(createdBy) {
  return typeof createdBy === "string"
    && TRACKER_PROVIDERS.some((provider) => createdBy === trackerImportCreator(provider));
}

/**
 * Room events written by tracker sync. They are quiet (Events tab only, never a
 * chat message) and carry `metadata.source = "tracker_sync"`, so rules that act
 * on repo events must skip them (ticket connectors invariant 4).
 */
export const TRACKER_SYNC_EVENT_TYPE = "tracker_ticket";
export const TRACKER_SYNC_EVENT_SOURCE = "tracker_sync";

export function isTrackerSyncEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.event_type === TRACKER_SYNC_EVENT_TYPE) return true;
  const metadata = event.metadata;
  return Boolean(metadata && typeof metadata === "object" && metadata.source === TRACKER_SYNC_EVENT_SOURCE);
}

export const ROOM_TRACKER_FILTER_MAX_LENGTH = 2_000;
