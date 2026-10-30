/**
 * Connectors: shared constants for the API and the desktop app. A tracker is
 * one kind of connector (Jira, Linear, GitHub Issues). See docs/ticket-connectors.md.
 */

/** The generic ticket states every tracker status maps to. */
export const TICKET_STATES = ["todo", "in_progress", "in_review", "done"];

export const TRACKER_PROVIDERS = ["jira", "linear", "github"];

/** What the app shows for each tracker. */
export const TRACKER_PROVIDER_LABELS = {
  jira: "Jira",
  linear: "Linear",
  github: "GitHub Issues",
};

export function trackerProviderLabel(provider) {
  return TRACKER_PROVIDER_LABELS[provider] ?? String(provider);
}

/**
 * The text a server without LETAGENTS_CONNECTOR_SECRET_KEY answers with (503,
 * code `connectors_not_configured`), and what the app shows in its place.
 */
export const CONNECTORS_NOT_CONFIGURED_CODE = "connectors_not_configured";
export const CONNECTORS_NOT_CONFIGURED_MESSAGE = "Connectors are not enabled on this server. "
  + "Ask your server admin to set LETAGENTS_CONNECTOR_SECRET_KEY.";

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
    // A status not named above maps by its Jira status category.
    "type:new": "todo",
    "type:indeterminate": "in_progress",
    "type:done": "done",
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
  // GitHub Issues has two states. An open issue with an assignee is being
  // worked on; labels are not states.
  github: {
    "Open": "todo",
    "Open (assigned)": "in_progress",
    "Closed": "done",
  },
};

/**
 * Shown next to the Jev switch; the switch defaults to off (invariant 7). It
 * names everything that leaves the server for each kind of Jev question.
 */
export const JEV_LINKING_DISCLOSURE = "When this is on, LetAgents sends text to Jev's model provider for the rooms that "
  + "import with this connection. To link a pull request that names no ticket: its title, the start of its description "
  + "(up to 2,000 characters), up to 20 commit subjects, and the keys and titles of up to 20 open tickets assigned to "
  + "its author. When a linked pull request closes without a merge: its title, the start of its description, and the "
  + "ticket's key and title. When you ask who a My work card waits on: the card's title and key and up to 6 recent "
  + "room messages about it. When you draft a rule from a sentence: the sentence and this connection's status names. "
  + "Text that looks like a secret is removed first. Jev only suggests: a person approves every ticket change. "
  + "Turn this off to stop sending.";

/**
 * Jev questions (PR6). Each is one bounded Choice question; a timeout or an
 * invalid answer means "do nothing" (invariant 5).
 */
export const JEV_LINK_MAX_CANDIDATES = 20;
export const JEV_PR_BODY_MAX_CHARS = 2_000;
export const JEV_COMMIT_SUBJECTS_MAX = 20;
export const JEV_NEEDS_ME_MESSAGES_MAX = 6;
export const JEV_QUESTION_TIMEOUT_MS = 10_000;
/** At or above: the link is attached as a suggestion and each rule that would fire becomes a board intent. */
export const JEV_LINK_HIGH_CONFIDENCE = 0.8;
/** At or above (and below high): the link is attached as a suggestion only. Below: nothing. */
export const JEV_LINK_LOW_CONFIDENCE = 0.4;
export const JEV_QUESTION_KINDS = ["link", "exception", "needs_me", "rule_draft"];
export const JEV_NEEDS_ME_STATES = ["waiting_on_human", "waiting_on_agent", "nothing"];
export const JEV_EXCEPTION_KINDS = ["abandoned", "superseded", "moved"];
export const JEV_RULE_DRAFT_MAX_CHARS = 500;

export const STATUS_MAP_MAX_ENTRIES = 100;
export const STATUS_NAME_MAX_LENGTH = 200;

export function isTicketState(value) {
  return typeof value === "string" && TICKET_STATES.includes(value);
}

export function isTrackerProvider(value) {
  return typeof value === "string" && TRACKER_PROVIDERS.includes(value);
}

/** `created_by` of a card that sync imported from a tracker: `tracker:jira`, `tracker:linear`, `tracker:github`. */
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

/**
 * Rules (PR5): a repo event that matches a rule's trigger reserves one tracker
 * write per action through the workflow effect journal. Tracker sync events
 * never reach the matcher (invariant 4).
 */
export const TRACKER_RULE_EVENTS = ["pull_request", "pull_request_review", "check_run"];

/** The webhook actions a trigger may name for each event: the ones the server records. */
export const TRACKER_RULE_EVENT_ACTIONS = {
  pull_request: ["opened", "reopened", "ready_for_review", "converted_to_draft", "synchronize", "closed"],
  pull_request_review: ["submitted", "dismissed"],
  check_run: ["completed"],
};

export const TRACKER_RULE_REVIEW_STATES = ["approved", "changes_requested", "commented", "dismissed"];

export const TRACKER_RULE_CHECK_CONCLUSIONS = [
  "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale",
];

/** `{{name}}` placeholders a comment template may use. Values are inserted as plain text. */
export const TRACKER_RULE_TEMPLATE_VARIABLES = [
  "pr_url", "pr_number", "pr_title", "author", "branch", "base_branch", "repo", "reviewer",
];

export const TRACKER_RULE_NAME_MAX_LENGTH = 120;
export const TRACKER_RULE_MAX_ACTIONS = 5;
export const TRACKER_RULE_TEMPLATE_MAX_LENGTH = 4_000;
export const TRACKER_RULE_BRANCH_MAX_LENGTH = 255;
export const TRACKER_RULE_MAX_APPROVALS = 20;
export const TRACKER_RULES_PER_CONNECTION_MAX = 50;
