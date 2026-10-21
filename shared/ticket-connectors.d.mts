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
