import { and, eq, lte, sql } from "drizzle-orm";

import type { TrackerAuthKind, TrackerConnectionStatus, TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { tracker_connections, tracker_oauth_states } from "../db/schema.js";

export type TrackerConnectionRow = typeof tracker_connections.$inferSelect;

export interface TrackerConnectionWrite {
  id: string;
  account_id: string;
  provider: TrackerProvider;
  display_name: string;
  site_key: string;
  site_url: string | null;
  auth_kind: TrackerAuthKind;
  credentials_ciphertext: string;
  credentials_iv: string;
  credentials_version: number;
  tracker_user_id: string;
  tracker_user_label: string;
  status_map: Record<string, string>;
}

/** Storage for connections. Rows carry ciphertext only; see connections.ts. */
export interface TrackerConnectionStore {
  list(accountId: string): Promise<TrackerConnectionRow[]>;
  get(id: string): Promise<TrackerConnectionRow | null>;
  findBySite(accountId: string, provider: TrackerProvider, siteKey: string): Promise<TrackerConnectionRow | null>;
  /** Insert, or replace the credentials of the same account's same site. */
  upsert(values: TrackerConnectionWrite): Promise<TrackerConnectionRow>;
  /**
   * Replace the credentials only if they are still the ones sealed with
   * `expectedIv` (compare-and-set), so an older OAuth refresh can never
   * overwrite a newer one. False when another writer won.
   */
  saveCredentials(id: string, values: { ciphertext: string; iv: string; version: number }, expectedIv: string): Promise<boolean>;
  update(id: string, accountId: string, patch: Partial<Pick<TrackerConnectionRow,
    "display_name" | "status_map" | "unmapped_statuses" | "jev_linking_enabled">>): Promise<TrackerConnectionRow | null>;
  setStatus(id: string, status: TrackerConnectionStatus, lastError: string | null, verified?: boolean): Promise<void>;
  addUnmapped(id: string, names: string[]): Promise<void>;
  delete(id: string, accountId: string): Promise<boolean>;
  createOAuthState(input: {
    state_hash: string;
    account_id: string;
    provider: TrackerProvider;
    loopback_port: number;
    code_verifier?: string | null;
    expires_at: string;
  }): Promise<void>;
  /** The unexpired state's loopback port, without using the state up. */
  peekOAuthState(stateHash: string, provider: TrackerProvider): Promise<{ loopback_port: number } | null>;
  /** Single use: the row is deleted on read, and only an unexpired one is returned. */
  consumeOAuthState(stateHash: string, provider: TrackerProvider): Promise<{ account_id: string; code_verifier: string | null } | null>;
}

const MAX_UNMAPPED = 50;

export const trackerConnectionStore: TrackerConnectionStore = {
  async list(accountId) {
    return db.select().from(tracker_connections)
      .where(eq(tracker_connections.account_id, accountId))
      .orderBy(tracker_connections.created_at);
  },

  async get(id) {
    const [row] = await db.select().from(tracker_connections).where(eq(tracker_connections.id, id)).limit(1);
    return row ?? null;
  },

  async findBySite(accountId, provider, siteKey) {
    const [row] = await db.select().from(tracker_connections).where(and(
      eq(tracker_connections.account_id, accountId),
      eq(tracker_connections.provider, provider),
      eq(tracker_connections.site_key, siteKey),
    )).limit(1);
    return row ?? null;
  },

  async upsert(values) {
    const now = new Date().toISOString();
    const [row] = await db.insert(tracker_connections)
      .values({ ...values, status: "active", last_error: null, last_verified_at: now, created_at: now, updated_at: now })
      .onConflictDoUpdate({
        target: [tracker_connections.account_id, tracker_connections.provider, tracker_connections.site_key],
        // Only the row whose id the ciphertext is bound to may be replaced.
        where: eq(tracker_connections.id, values.id),
        set: {
          display_name: values.display_name,
          site_url: values.site_url,
          auth_kind: values.auth_kind,
          credentials_ciphertext: values.credentials_ciphertext,
          credentials_iv: values.credentials_iv,
          credentials_version: values.credentials_version,
          tracker_user_id: values.tracker_user_id,
          tracker_user_label: values.tracker_user_label,
          status: "active",
          last_error: null,
          last_verified_at: now,
          updated_at: now,
        },
      })
      .returning();
    if (!row) throw new Error("The tracker connection changed while it was saved. Try again.");
    return row;
  },

  async saveCredentials(id, values, expectedIv) {
    // Every encryption has a fresh IV, so the IV identifies the sealed value.
    const rows = await db.update(tracker_connections).set({
      credentials_ciphertext: values.ciphertext,
      credentials_iv: values.iv,
      credentials_version: values.version,
      updated_at: new Date().toISOString(),
    }).where(and(eq(tracker_connections.id, id), eq(tracker_connections.credentials_iv, expectedIv)))
      .returning({ id: tracker_connections.id });
    return rows.length > 0;
  },

  async update(id, accountId, patch) {
    const [row] = await db.update(tracker_connections)
      .set({ ...patch, updated_at: new Date().toISOString() })
      .where(and(eq(tracker_connections.id, id), eq(tracker_connections.account_id, accountId)))
      .returning();
    return row ?? null;
  },

  async setStatus(id, status, lastError, verified = false) {
    const now = new Date().toISOString();
    await db.update(tracker_connections).set({
      status,
      last_error: lastError,
      updated_at: now,
      ...(verified ? { last_verified_at: now } : {}),
    }).where(eq(tracker_connections.id, id));
  },

  async addUnmapped(id, names) {
    if (!names.length) return;
    // Merge without duplicates, at most MAX_UNMAPPED names. Once the bound is
    // reached, names already stored are kept and new ones are dropped.
    await db.execute(sql`
      UPDATE ${tracker_connections}
         SET unmapped_statuses = (
               SELECT COALESCE(jsonb_agg(name ORDER BY first_seen), '[]'::jsonb) FROM (
                 SELECT name, min(position) AS first_seen
                   FROM jsonb_array_elements_text(
                     ${tracker_connections.unmapped_statuses} || ${JSON.stringify(names)}::jsonb
                   ) WITH ORDINALITY AS entry(name, position)
                  GROUP BY name
                  ORDER BY first_seen
                  LIMIT ${MAX_UNMAPPED}
               ) AS merged
             ),
             updated_at = now()
       WHERE ${tracker_connections.id} = ${id}
    `);
  },

  async delete(id, accountId) {
    const rows = await db.delete(tracker_connections)
      .where(and(eq(tracker_connections.id, id), eq(tracker_connections.account_id, accountId)))
      .returning({ id: tracker_connections.id });
    return rows.length > 0;
  },

  async createOAuthState(input) {
    await db.delete(tracker_oauth_states).where(lte(tracker_oauth_states.expires_at, new Date().toISOString()));
    await db.insert(tracker_oauth_states).values({ ...input, created_at: new Date().toISOString() });
  },

  async peekOAuthState(stateHash, provider) {
    const [row] = await db.select().from(tracker_oauth_states)
      .where(eq(tracker_oauth_states.state_hash, stateHash)).limit(1);
    if (!row || row.provider !== provider || Date.parse(row.expires_at) <= Date.now()) return null;
    return { loopback_port: row.loopback_port };
  },

  async consumeOAuthState(stateHash, provider) {
    const [row] = await db.delete(tracker_oauth_states)
      .where(eq(tracker_oauth_states.state_hash, stateHash))
      .returning();
    if (!row || row.provider !== provider || Date.parse(row.expires_at) <= Date.now()) return null;
    return { account_id: row.account_id, code_verifier: row.code_verifier };
  },
};
