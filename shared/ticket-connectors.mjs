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
