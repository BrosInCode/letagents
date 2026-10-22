import { randomUUID } from "node:crypto";

import {
  isTicketState,
  type TicketState,
  type TrackerAuthKind,
  type TrackerConnectionView,
  type TrackerProvider,
} from "../../../shared/ticket-connectors.mjs";
import { CONNECTOR_CREDENTIALS_VERSION, ConnectorDecryptError, type ConnectorCipher, redactConnectorSecrets } from "./crypto.js";
import type { WorkItemProviders } from "./providers/index.js";
import {
  type ProviderConnection,
  type TrackerCredentials,
  type TrackerUser,
  TrackerProviderError,
} from "./providers/types.js";
import { defaultStatusMap } from "./status-map.js";
import type { TrackerConnectionRow, TrackerConnectionStore } from "./store.js";

export class TrackerConnectionNotFoundError extends Error {
  readonly code = "tracker_connection_not_found";
  constructor() {
    super("Tracker connection not found.");
    this.name = "TrackerConnectionNotFoundError";
  }
}

export function newTrackerConnectionId(): string {
  return `tcon_${randomUUID()}`;
}

export function toConnectionView(row: TrackerConnectionRow): TrackerConnectionView {
  const statusMap: Record<string, TicketState> = {};
  for (const [name, state] of Object.entries(row.status_map ?? {})) {
    if (isTicketState(state)) statusMap[name] = state;
  }
  return {
    id: row.id,
    provider: row.provider as TrackerProvider,
    display_name: row.display_name,
    site_url: row.site_url,
    auth_kind: row.auth_kind as TrackerConnectionView["auth_kind"],
    tracker_user_id: row.tracker_user_id,
    tracker_user_label: row.tracker_user_label,
    status_map: statusMap,
    unmapped_statuses: Array.isArray(row.unmapped_statuses) ? row.unmapped_statuses.map(String) : [],
    jev_linking_enabled: row.jev_linking_enabled,
    status: row.status as TrackerConnectionView["status"],
    last_error: row.last_error,
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Error text safe to store and show: no credential values, bounded. */
export function connectorErrorText(error: unknown, secrets: ReadonlyArray<string | null | undefined> = []): string {
  const message = error instanceof Error ? error.message : "Tracker request failed.";
  return redactConnectorSecrets(message, secrets).slice(0, 500);
}

function credentialSecrets(credentials: TrackerCredentials): string[] {
  // A GitHub App connection stores no secret; its tokens are minted per request.
  if (credentials.kind === "github_app") return [];
  if (credentials.kind === "api_token") {
    return "api_token" in credentials ? [credentials.api_token] : [credentials.api_key];
  }
  return [credentials.access_token, credentials.refresh_token ?? ""];
}

export interface ConnectionService {
  /** A provider-ready connection with decrypted credentials. */
  open(row: TrackerConnectionRow): ProviderConnection;
  /**
   * Verify credentials with the tracker, then store them for the account. The
   * same account's same site is updated in place (reconnect).
   */
  connect(input: {
    account_id: string;
    provider: TrackerProvider;
    auth_kind: TrackerAuthKind;
    credentials: TrackerCredentials;
    site: { key: string; url: string | null; name: string } | null;
    /** The tracker user id the caller already proved (GitHub Issues: the signed-in GitHub id). */
    tracker_user_id?: string | null;
  }): Promise<TrackerConnectionRow>;
  /** Record what a provider error means for the connection. */
  recordFailure(row: TrackerConnectionRow, error: unknown): Promise<string>;
}

export function createConnectionService(deps: {
  store: TrackerConnectionStore;
  cipher: ConnectorCipher;
  providers: WorkItemProviders;
}): ConnectionService {
  const { store, cipher, providers } = deps;

  function open(row: TrackerConnectionRow): ProviderConnection {
    const binding = { connection_id: row.id, account_id: row.account_id };
    // The IV of the sealed value this connection holds: the version a save compares.
    let sealedIv = row.credentials_iv;
    const decrypt = (source: TrackerConnectionRow) => cipher.decrypt({
      ciphertext: source.credentials_ciphertext,
      iv: source.credentials_iv,
      version: source.credentials_version,
    }, binding) as unknown as TrackerCredentials;
    const connection: ProviderConnection = {
      id: row.id,
      provider: row.provider as TrackerProvider,
      auth_kind: row.auth_kind as TrackerAuthKind,
      status_map: row.status_map ?? {},
      tracker_user_id: row.tracker_user_id,
      credentials: decrypt(row),
      async saveCredentials(next) {
        const sealed = cipher.encrypt(next as unknown as Record<string, unknown>, binding);
        const saved = await store.saveCredentials(row.id, sealed, sealedIv);
        if (saved) sealedIv = sealed.iv;
        return saved;
      },
      async reload() {
        const current = await store.get(row.id);
        if (!current || current.account_id !== row.account_id) throw new TrackerConnectionNotFoundError();
        sealedIv = current.credentials_iv;
        connection.credentials = decrypt(current);
        return connection.credentials;
      },
    };
    return connection;
  }

  return {
    open,

    async connect(input) {
      const provider = providers[input.provider];
      // Verify before anything is stored; this connection exists only in memory.
      const probe: ProviderConnection = {
        id: `probe_${randomUUID()}`,
        provider: input.provider,
        auth_kind: input.auth_kind,
        status_map: defaultStatusMap(input.provider),
        tracker_user_id: input.tracker_user_id ?? null,
        credentials: input.credentials,
        async saveCredentials(next) { probe.credentials = next; return true; },
      };
      const user: TrackerUser = await provider.whoAmI(probe);
      const site = input.site ?? user.site ?? null;
      if (!site) throw new TrackerProviderError("definite", "The tracker did not say which workspace these credentials reach.");
      const existing = await store.findBySite(input.account_id, input.provider, site.key);
      const id = existing?.id ?? newTrackerConnectionId();
      const sealed = cipher.encrypt(probe.credentials as unknown as Record<string, unknown>, {
        connection_id: id,
        account_id: input.account_id,
      });
      return store.upsert({
        id,
        account_id: input.account_id,
        provider: input.provider,
        display_name: existing?.display_name ?? site.name.slice(0, 120),
        site_key: site.key,
        site_url: site.url,
        auth_kind: input.auth_kind,
        credentials_ciphertext: sealed.ciphertext,
        credentials_iv: sealed.iv,
        credentials_version: CONNECTOR_CREDENTIALS_VERSION,
        tracker_user_id: user.id,
        tracker_user_label: user.label.slice(0, 200),
        status_map: existing?.status_map ?? defaultStatusMap(input.provider),
      });
    },

    async recordFailure(row, error) {
      let secrets: string[] = [];
      try {
        secrets = credentialSecrets(open(row).credentials);
      } catch {
        // Undecryptable credentials: nothing to scrub beyond the patterns.
      }
      const text = connectorErrorText(error, secrets);
      if (error instanceof ConnectorDecryptError || (error instanceof TrackerProviderError && error.outcome === "auth")) {
        await store.setStatus(row.id, "needs_reauth", text);
      } else if (!(error instanceof TrackerProviderError)) {
        await store.setStatus(row.id, "error", text);
      }
      return text;
    },
  };
}
