export type TicketState = "todo" | "in_progress" | "in_review" | "done";
export type TrackerProvider = "jira" | "linear";
export type TrackerAuthKind = "oauth" | "api_token";
export type TrackerConnectionStatus = "active" | "needs_reauth" | "error";

export declare const TICKET_STATES: readonly TicketState[];
export declare const TRACKER_PROVIDERS: readonly TrackerProvider[];
export declare const UNMAPPED_TICKET_STATE: TicketState;
export declare const DEFAULT_STATUS_MAPS: Readonly<Record<TrackerProvider, Readonly<Record<string, TicketState>>>>;
export declare const JEV_LINKING_DISCLOSURE: string;
export declare const STATUS_MAP_MAX_ENTRIES: number;
export declare const STATUS_NAME_MAX_LENGTH: number;
export declare function isTicketState(value: unknown): value is TicketState;
export declare function isTrackerProvider(value: unknown): value is TrackerProvider;

/** A connection as the account routes return it. Never carries credentials. */
export interface TrackerConnectionView {
  id: string;
  provider: TrackerProvider;
  display_name: string;
  site_url: string | null;
  auth_kind: TrackerAuthKind;
  tracker_user_id: string | null;
  tracker_user_label: string | null;
  status_map: Record<string, TicketState>;
  /** Statuses seen with no map entry; they show as in_progress until mapped. */
  unmapped_statuses: string[];
  jev_linking_enabled: boolean;
  status: TrackerConnectionStatus;
  last_error: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackerProviderAvailability {
  oauth: boolean;
  api_token: boolean;
}

export interface TrackerConnectionList {
  connections: TrackerConnectionView[];
  providers: Record<TrackerProvider, TrackerProviderAvailability>;
  jev_linking_disclosure: string;
}

export interface TrackerItemSummary {
  key: string;
  title: string;
  raw_status: string;
  ticket_state: TicketState;
  unmapped: boolean;
  url: string | null;
}

export interface TrackerConnectionTestResult {
  ok: boolean;
  connection: TrackerConnectionView;
  items: TrackerItemSummary[];
  error: string | null;
}

export interface TrackerOAuthStart {
  authorize_url: string;
  expires_at: string;
}

export interface TrackerApiTokenInput {
  provider: TrackerProvider;
  /** Jira only: https://<site>.atlassian.net */
  site_url?: string;
  /** Jira only: the Atlassian account email that owns the token. */
  email?: string;
  api_token: string;
}

export interface TrackerConnectionPatch {
  display_name?: string;
  status_map?: Record<string, TicketState>;
  jev_linking_enabled?: boolean;
}

export declare const TRACKER_IMPORT_CREATOR_PREFIX: string;
export declare function trackerImportCreator(provider: TrackerProvider): string;
export declare function isTrackerImportCreator(createdBy: unknown): boolean;
export declare const TRACKER_SYNC_EVENT_TYPE: "tracker_ticket";
export declare const TRACKER_SYNC_EVENT_SOURCE: "tracker_sync";
export declare function isTrackerSyncEvent(event: unknown): boolean;
export declare const ROOM_TRACKER_FILTER_MAX_LENGTH: number;

/** One room's import filter for one connection. */
export interface RoomTrackerFilterView {
  id: string;
  room_id: string;
  connection_id: string;
  provider: TrackerProvider;
  connection_label: string;
  filter: string;
  enabled: boolean;
  /** Whether the signed-in person owns the connection and may change the filter. */
  can_manage: boolean;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface RoomTrackerFilterList {
  filters: RoomTrackerFilterView[];
  /** Whether the signed-in person may add or change filters in this room (room admin). */
  can_manage: boolean;
}

export interface RoomTrackerFilterTestResult {
  ok: boolean;
  /** Tickets the filter matches, counted up to `limit`. */
  count: number;
  limit: number;
  sample: TrackerItemSummary[];
  error: string | null;
}

/** The cached tracker record behind an imported or linked card. */
export interface TaskTicketDetails {
  external_ref: string;
  provider: TrackerProvider;
  key: string;
  title: string;
  ticket_state: TicketState;
  raw_status: string;
  assignee_label: string | null;
  url: string | null;
  tracker_updated_at: string | null;
  synced_at: string;
}

/** Where a tracker sends its webhooks for one connection. */
export interface TrackerWebhookSetup {
  url: string;
  secret: string;
}

export type TrackerRuleEvent = "pull_request" | "pull_request_review" | "check_run";
export declare const TRACKER_RULE_EVENTS: readonly TrackerRuleEvent[];
export declare const TRACKER_RULE_EVENT_ACTIONS: Readonly<Record<TrackerRuleEvent, readonly string[]>>;
export declare const TRACKER_RULE_REVIEW_STATES: readonly string[];
export declare const TRACKER_RULE_CHECK_CONCLUSIONS: readonly string[];
export type TrackerRuleTemplateVariable =
  | "pr_url" | "pr_number" | "pr_title" | "author" | "branch" | "base_branch" | "repo" | "reviewer";
export declare const TRACKER_RULE_TEMPLATE_VARIABLES: readonly TrackerRuleTemplateVariable[];
export declare const TRACKER_RULE_NAME_MAX_LENGTH: number;
export declare const TRACKER_RULE_MAX_ACTIONS: number;
export declare const TRACKER_RULE_TEMPLATE_MAX_LENGTH: number;
export declare const TRACKER_RULE_BRANCH_MAX_LENGTH: number;
export declare const TRACKER_RULE_MAX_APPROVALS: number;
export declare const TRACKER_RULES_PER_CONNECTION_MAX: number;

/** When a rule fires. Every field that is set must match; unset fields match anything. */
export interface TrackerRuleTrigger {
  event: TrackerRuleEvent;
  /** The webhook action, e.g. `opened`, `closed`, `submitted`, `completed`. */
  action: string;
  /** pull_request only. */
  merged?: boolean;
  /** pull_request only. */
  draft?: boolean;
  /** The pull request's base branch, exact match. Not for check_run. */
  baseBranch?: string;
  /** pull_request_review only. */
  reviewState?: string;
  /** pull_request_review only: reviewers whose latest review approves, counted with this event. */
  approvalsAtLeast?: number;
  /** check_run only. */
  conclusion?: string;
}

export type TrackerRuleAction =
  | { kind: "transition"; toStatus: string }
  | { kind: "comment"; template: string };

/** What the editor sends to create or change a rule. */
export interface TrackerRuleInput {
  name: string;
  /** Null: every room that imports tickets with this connection. */
  room_id: string | null;
  enabled?: boolean;
  trigger: TrackerRuleTrigger;
  actions: TrackerRuleAction[];
}

export interface TrackerRuleView {
  id: string;
  connection_id: string;
  room_id: string | null;
  name: string;
  enabled: boolean;
  trigger: TrackerRuleTrigger;
  actions: TrackerRuleAction[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TrackerRuleVersionView {
  version: number;
  name: string;
  room_id: string | null;
  trigger: TrackerRuleTrigger;
  actions: TrackerRuleAction[];
  created_at: string;
}

export interface TrackerRuleList {
  rules: TrackerRuleView[];
  /** Rooms that import tickets with this connection: the rooms a rule can be limited to. */
  rooms: string[];
}
