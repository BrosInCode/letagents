import type { TicketState, TrackerAuthKind, TrackerProvider } from "../../../../shared/ticket-connectors.mjs";

/** Decrypted Jira credentials. Lives only in memory, never in logs. */
export type JiraCredentials =
  | { kind: "api_token"; site_url: string; email: string; api_token: string }
  | {
      kind: "oauth";
      cloud_id: string;
      site_url: string;
      access_token: string;
      refresh_token: string | null;
      /** ISO time; null when the provider gave no expiry. */
      expires_at: string | null;
    };

/** Decrypted Linear credentials. Lives only in memory, never in logs. */
export type LinearCredentials =
  | { kind: "api_token"; api_key: string }
  | { kind: "oauth"; access_token: string; refresh_token: string | null; expires_at: string | null };

export type TrackerCredentials = JiraCredentials | LinearCredentials;

/**
 * What a provider call gets: the connection's identity and map, its decrypted
 * credentials, and a way to persist refreshed OAuth tokens.
 */
export interface ProviderConnection<C extends TrackerCredentials = TrackerCredentials> {
  id: string;
  provider: TrackerProvider;
  auth_kind: TrackerAuthKind;
  status_map: Record<string, string>;
  tracker_user_id: string | null;
  credentials: C;
  /**
   * Persist rotated OAuth tokens before they are used. False when another
   * writer saved newer credentials first; the caller then reloads.
   */
  saveCredentials(next: C): Promise<boolean>;
  /** The stored credentials as they are now (another process may have refreshed them). */
  reload?(): Promise<C>;
}

export interface ExternalItem {
  provider: TrackerProvider;
  key: string;
  title: string;
  ticket_state: TicketState;
  raw_status: string;
  /** True when no status map entry named `raw_status`. */
  unmapped: boolean;
  assignee_id: string | null;
  assignee_label: string | null;
  url: string | null;
  tracker_updated_at: string | null;
  /** A small, credential-free subset of the provider's record. */
  payload: Record<string, unknown>;
}

/**
 * One ticket a webhook names. `item` is null when the payload is not trusted
 * as the ticket's state: sync then reads the ticket, so a webhook and a poll
 * always map the same record the same way.
 */
export interface ExternalItemChange {
  key: string;
  item: ExternalItem | null;
  deleted: boolean;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  /** The connection's signing secret. */
  secret: string;
  now?: Date;
}

export interface WebhookVerification {
  ok: boolean;
  deliveryId: string;
}

export interface TrackerUser {
  id: string;
  label: string;
  /** The workspace the credentials reach, when the provider reports it. */
  site?: { key: string; url: string | null; name: string };
}

export interface ListItemsOptions {
  assigneeMe?: boolean;
  updatedSince?: string;
  /** Only tickets updated at or before this time (inclusive; Jira rounds out to the minute). */
  updatedBefore?: string;
  /** Upper bound on items returned. Default 50, at most 200. */
  limit?: number;
}

/**
 * The outcome of a failed tracker call:
 * - "definite": the tracker refused, nothing was written; a retry may run.
 * - "ambiguous": the write may have landed; only a lookup may follow.
 * - "auth": the credentials are invalid or revoked; the user must reconnect.
 */
export type TrackerErrorOutcome = "definite" | "ambiguous" | "auth";

export class TrackerProviderError extends Error {
  readonly code = "tracker_provider_error";
  constructor(readonly outcome: TrackerErrorOutcome, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "TrackerProviderError";
  }
}

export interface TrackerWriteResult {
  externalId: string;
  url?: string;
}

export interface WorkItemProvider {
  readonly name: TrackerProvider;
  whoAmI(conn: ProviderConnection): Promise<TrackerUser>;
  listItems(conn: ProviderConnection, filter: string | null, opts: ListItemsOptions): Promise<ExternalItem[]>;
  getItem(conn: ProviderConnection, key: string): Promise<ExternalItem | null>;
  listTransitions(conn: ProviderConnection, key: string): Promise<{ id: string; toStatus: string }[]>;
  /** Move the ticket to the status named `toStatus`, resolved at run time. */
  transition(conn: ProviderConnection, key: string, toStatus: string, correlationKey: string): Promise<TrackerWriteResult>;
  /** Add a comment that carries `correlationKey` as a hidden marker. */
  comment(conn: ProviderConnection, key: string, body: string, correlationKey: string): Promise<TrackerWriteResult & { url?: string }>;
  /**
   * Reconciliation for an ambiguous transition: evidence that the ticket
   * reached `toStatus` at or after `since`, or null.
   */
  findTransition(conn: ProviderConnection, key: string, toStatus: string, since: string): Promise<TrackerWriteResult | null>;
  /** Reconciliation for an ambiguous comment: the comment with the marker, or null. */
  findComment(conn: ProviderConnection, key: string, correlationKey: string): Promise<TrackerWriteResult | null>;
  verifyWebhook?(req: WebhookRequest): WebhookVerification;
  parseWebhook?(payload: unknown): ExternalItemChange[];
}
