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

/** Why a My work card needs the account (PR4). Only signals that already exist. */
export type MyWorkNeedsMeReason = "review_requested" | "human_request" | "ticket_done_pr_open";

/** One pull request on a My work card. Summaries come from the card's GitHub events. */
export interface MyWorkPullRequest {
  url: string;
  number: string | null;
  title: string | null;
  state: string | null;
  draft: boolean | null;
  merged: boolean | null;
  review_summary: { total: number; approved: number; changes_requested: number } | null;
  check_summary: { total: number; success: number; failure: number; pending: number } | null;
}

/** One card on `GET /account/my-work`. */
export interface MyWorkCard {
  task_id: string;
  room_id: string;
  room_name: string;
  title: string;
  /** `provider:KEY`, or null for a card that names no ticket. */
  external_ref: string | null;
  key: string | null;
  provider: TrackerProvider | null;
  /** Owned by the tracker; null when no room filter synced the ticket. */
  ticket_state: TicketState | null;
  ticket_status: string | null;
  ticket_url: string | null;
  ticket_assignee_label: string | null;
  /** The card's LetAgents work state. */
  work_state: string;
  /** `tracker`: the ticket is assigned to you. `native`: the card is assigned to you or your agent. */
  assigned_via: "tracker" | "native";
  agent: {
    label: string;
    agent_key: string | null;
    display_name: string | null;
    status: string | null;
    status_text: string | null;
    last_heartbeat_at: string | null;
  } | null;
  threads: { count: number; last_activity_at: string | null };
  pull_requests: MyWorkPullRequest[];
  needs_me: boolean;
  needs_me_reasons: MyWorkNeedsMeReason[];
  updated_at: string;
}

export interface MyWorkPage {
  cards: MyWorkCard[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
  /** False in zero-connector mode: the page lists native cards and hides ticket state. */
  has_connections: boolean;
  /** The trackers the account has connected. */
  providers: TrackerProvider[];
}
