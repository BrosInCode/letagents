import { sql } from "drizzle-orm";

import { db } from "../client.js";
import { RequestValidationError } from "../../validation-error.js";
import {
  activationIdentityAliases,
  type ActivationIdentity,
} from "../../../shared/activation-routing.js";
import {
  message_thread_participant_agents,
  message_thread_participant_aliases,
  room_agent_sessions,
} from "../schema.js";

type RoutingMembershipExecutor = Pick<typeof db, "execute">;

export interface GlobalThreadRoutingMember {
  agent_key: string;
  owner_account_id: string;
}

export const MAX_GLOBAL_THREAD_ROUTING_ROOTS = 1_000;
export const MAX_GLOBAL_THREAD_ROUTING_MEMBERS = 100_000;
export const MAX_GLOBAL_THREAD_ROUTING_ACTIVE_SESSIONS = 50_000;
export const MAX_GLOBAL_THREAD_ROUTING_PROJECTION_ROWS = 100_000;

export interface ThreadRoutingProjection {
  exactMembers: Map<number, GlobalThreadRoutingMember[]>;
  legacyAliases: Map<number, Map<number, { full: Set<string>; segment: Set<string> }>>;
}

/**
 * Load only the requested roots' fixed routing projection. The message-create
 * path can then resolve legacy aliases against the active sessions it already
 * needs for receipt targets, rather than making PostgreSQL enumerate and
 * normalize the room population a second time.
 */
export async function getMessageThreadRoutingProjection(
  executor: RoutingMembershipExecutor,
  roomId: string,
  rootNumbersInput: readonly number[],
  options: {
    activeIdentities: readonly (ActivationIdentity & { owner_account_id: string })[];
  },
): Promise<ThreadRoutingProjection> {
  const rootNumbers = [...new Set(rootNumbersInput.filter(
    (value) => Number.isInteger(value) && value > 0,
  ))];
  const empty = {
    exactMembers: new Map<number, GlobalThreadRoutingMember[]>(),
    legacyAliases: new Map<number, Map<number, { full: Set<string>; segment: Set<string> }>>(),
  };
  if (rootNumbers.length === 0) return empty;
  if (rootNumbers.length > MAX_GLOBAL_THREAD_ROUTING_ROOTS) {
    throw new RequestValidationError("Thread routing membership exceeds its bounded root contract.");
  }
  const inputRootValues = sql.join(
    rootNumbers.map((rootNumber) => sql`(${rootNumber}::integer)`),
    sql`, `,
  );
  const activeIdentities = options.activeIdentities.map((identity) => ({
    actor_label: identity.actor_label,
    display_name: identity.display_name,
    agent_key: identity.agent_key,
    owner_account_id: identity.owner_account_id,
  }));

  const rows = await executor.execute<{
    kind: "exact" | "legacy";
    thread_root_number: number;
    participant_number: number;
    agent_key: string | null;
    owner_account_id: string | null;
    alias_text: string | null;
    is_full: boolean | null;
  }>(sql`
    WITH input_root AS MATERIALIZED (
      SELECT value.thread_root_number
        FROM (VALUES ${inputRootValues}) AS value(thread_root_number)
    ), input_identity AS MATERIALIZED (
      SELECT value.actor_label,
             value.display_name,
             value.agent_key,
             value.owner_account_id,
             REGEXP_REPLACE(value.agent_key, '^.*/', '') AS short_agent_key
        FROM jsonb_to_recordset(${JSON.stringify(activeIdentities)}::jsonb)
          AS value(actor_label text, display_name text, agent_key text, owner_account_id text)
    ), active_alias AS MATERIALIZED (
      SELECT DISTINCT normalize_message_thread_routing_alias(raw.alias_input, mode.is_handle) AS alias_text
        FROM input_identity
        CROSS JOIN LATERAL (VALUES
          (input_identity.actor_label),
          (input_identity.display_name),
          (input_identity.agent_key),
          (input_identity.short_agent_key)
        ) AS raw(alias_input)
        CROSS JOIN (VALUES (false), (true)) AS mode(is_handle)
    ), projected AS (
      SELECT DISTINCT 'exact'::text AS kind,
             participant.thread_root_number,
             participant.participant_number,
             participant.agent_key,
             participant.owner_account_id,
             NULL::text AS alias_text,
             NULL::boolean AS is_full
        FROM input_root
        CROSS JOIN input_identity
        CROSS JOIN LATERAL (
          SELECT candidate.thread_root_number,
                 candidate.participant_number,
                 candidate.agent_key,
                 candidate.owner_account_id
           FROM ${message_thread_participant_agents} AS candidate
           WHERE candidate.room_id = ${roomId}
             AND candidate.thread_root_number = input_root.thread_root_number
             AND candidate.agent_key_hash = MD5(input_identity.agent_key)
             AND candidate.agent_key = input_identity.agent_key
             AND candidate.owner_account_id = input_identity.owner_account_id
           OFFSET 0
        ) AS participant
      UNION ALL
      SELECT DISTINCT 'legacy'::text AS kind,
             projected_alias.thread_root_number,
             projected_alias.participant_number,
             NULL::text AS agent_key,
             NULL::text AS owner_account_id,
             projected_alias.alias_text,
             projected_alias.is_full
        FROM input_root
        CROSS JOIN active_alias
        CROSS JOIN LATERAL (
          SELECT candidate.thread_root_number,
                 candidate.participant_number,
                 candidate.alias_text,
                 candidate.is_full
           FROM ${message_thread_participant_aliases} AS candidate
           WHERE candidate.room_id = ${roomId}
             AND candidate.thread_root_number = input_root.thread_root_number
             AND candidate.alias_hash = MD5(active_alias.alias_text)
             AND candidate.alias_text = active_alias.alias_text
             AND NOT EXISTS (
               SELECT 1
                 FROM ${message_thread_participant_agents} AS durable
                WHERE durable.room_id = candidate.room_id
                  AND durable.thread_root_number = candidate.thread_root_number
                  AND durable.participant_number = candidate.participant_number
             )
           OFFSET 0
        ) AS projected_alias
    )
    SELECT kind, thread_root_number, participant_number,
           agent_key, owner_account_id, alias_text, is_full
      FROM projected
     LIMIT ${MAX_GLOBAL_THREAD_ROUTING_PROJECTION_ROWS + 1}
  `);
  if (rows.rows.length > MAX_GLOBAL_THREAD_ROUTING_PROJECTION_ROWS) {
    throw new RequestValidationError("Thread routing membership exceeds its bounded projection contract.");
  }

  for (const row of rows.rows) {
    const rootNumber = Number(row.thread_root_number);
    if (row.kind === "exact") {
      if (!row.agent_key || !row.owner_account_id) {
        throw new RequestValidationError("Thread routing projection returned an invalid durable member.");
      }
      const members = empty.exactMembers.get(rootNumber) ?? [];
      members.push({ agent_key: row.agent_key, owner_account_id: row.owner_account_id });
      empty.exactMembers.set(rootNumber, members);
      continue;
    }
    if (!row.alias_text || typeof row.is_full !== "boolean") {
      throw new RequestValidationError("Thread routing projection returned an invalid legacy alias.");
    }
    const participants = empty.legacyAliases.get(rootNumber) ?? new Map();
    const aliases = participants.get(row.participant_number) ?? {
      full: new Set<string>(),
      segment: new Set<string>(),
    };
    (row.is_full ? aliases.full : aliases.segment).add(row.alias_text);
    participants.set(row.participant_number, aliases);
    empty.legacyAliases.set(rootNumber, participants);
  }
  return empty;
}

export function resolveMessageThreadRoutingProjection(
  projection: ThreadRoutingProjection,
  identities: readonly (ActivationIdentity & { owner_account_id: string })[],
): Map<number, GlobalThreadRoutingMember[]> {
  const ownersByKey = new Map<string, Set<string>>();
  const keysByAlias = new Map<string, Set<string>>();
  for (const identity of identities) {
    const owners = ownersByKey.get(identity.agent_key) ?? new Set<string>();
    owners.add(identity.owner_account_id);
    ownersByKey.set(identity.agent_key, owners);
    for (const alias of activationIdentityAliases(identity)) {
      const keys = keysByAlias.get(alias) ?? new Set<string>();
      keys.add(identity.agent_key);
      keysByAlias.set(alias, keys);
    }
  }

  const resultByRoot = new Map<number, Map<string, GlobalThreadRoutingMember>>();
  const add = (rootNumber: number, agentKey: string, expectedOwner?: string): void => {
    const owners = ownersByKey.get(agentKey);
    if (owners?.size !== 1) return;
    const owner = owners.values().next().value!;
    if (expectedOwner && owner !== expectedOwner) return;
    const members = resultByRoot.get(rootNumber) ?? new Map();
    members.set(agentKey, { agent_key: agentKey, owner_account_id: owner });
    resultByRoot.set(rootNumber, members);
  };
  for (const [rootNumber, members] of projection.exactMembers) {
    for (const member of members) add(rootNumber, member.agent_key, member.owner_account_id);
  }
  for (const [rootNumber, participants] of projection.legacyAliases) {
    for (const aliases of participants.values()) {
      const matches = (values: ReadonlySet<string>): Set<string> => {
        const keys = new Set<string>();
        for (const alias of values) {
          for (const key of keysByAlias.get(alias) ?? []) keys.add(key);
        }
        return keys;
      };
      const fullMatches = matches(aliases.full);
      const candidates = fullMatches.size > 0 ? fullMatches : matches(aliases.segment);
      if (candidates.size === 1) add(rootNumber, candidates.values().next().value!);
    }
  }

  const result = new Map<number, GlobalThreadRoutingMember[]>();
  for (const [rootNumber, members] of resultByRoot) {
    result.set(rootNumber, [...members.values()].sort((left, right) =>
      left.agent_key.localeCompare(right.agent_key)));
  }
  return result;
}

/**
 * Resolve projected participants against the complete active worker
 * population. Ambiguous aliases and durable keys owned by multiple accounts
 * are omitted before a caller filters for one account or worker.
 */
export async function getGlobalMessageThreadRoutingMembers(
  executor: RoutingMembershipExecutor,
  roomId: string,
  rootNumbersInput: readonly number[],
  options: {
    ownerAccountIds?: readonly string[];
    activeIdentities?: readonly (ActivationIdentity & { owner_account_id: string })[];
  } = {},
): Promise<Map<number, GlobalThreadRoutingMember[]>> {
  const rootNumbers = [...new Set(rootNumbersInput.filter(
    (value) => Number.isInteger(value) && value > 0,
  ))];
  if (rootNumbers.length === 0) return new Map();
  if (rootNumbers.length > MAX_GLOBAL_THREAD_ROUTING_ROOTS) {
    throw new RequestValidationError("Thread routing membership exceeds its bounded root contract.");
  }
  const inputRootValues = sql.join(
    rootNumbers.map((rootNumber) => sql`(${rootNumber}::integer)`),
    sql`, `,
  );
  const requestedOwnerAccountIds = options.ownerAccountIds === undefined
    ? null
    : [...new Set(options.ownerAccountIds.map((value) => value.trim()).filter(Boolean))];
  if (requestedOwnerAccountIds?.length === 0) return new Map();
  const activeIdentities = options.activeIdentities?.map((identity) => ({
    actor_label: identity.actor_label,
    display_name: identity.display_name,
    agent_key: identity.agent_key,
    owner_account_id: identity.owner_account_id,
  })) ?? null;
  if ((activeIdentities?.length ?? 0) > MAX_GLOBAL_THREAD_ROUTING_ACTIVE_SESSIONS) {
    throw new RequestValidationError("Thread routing membership exceeds its bounded active-worker contract.");
  }
  const activeSessionSource = activeIdentities === null
    ? sql`
        SELECT session.agent_key,
               session.owner_account_id,
               session.actor_label,
               session.display_name,
               REGEXP_REPLACE(session.agent_key, '^.*/', '') AS short_agent_key
          FROM ${room_agent_sessions} AS session
         WHERE session.room_id = ${roomId}
           AND session.session_kind = 'worker'
           AND session.ended_at IS NULL
         ORDER BY session.created_at, session.session_id
         LIMIT ${MAX_GLOBAL_THREAD_ROUTING_ACTIVE_SESSIONS + 1}
      `
    : sql`
        SELECT value.agent_key,
               value.owner_account_id,
               value.actor_label,
               value.display_name,
               REGEXP_REPLACE(value.agent_key, '^.*/', '') AS short_agent_key
          FROM jsonb_to_recordset(${JSON.stringify(activeIdentities)}::jsonb)
            AS value(actor_label text, display_name text, agent_key text, owner_account_id text)
      `;
  const exactOwnerFilter = requestedOwnerAccountIds === null
    ? sql`TRUE`
    : sql`EXISTS (
        SELECT 1 FROM requested_owner
         WHERE requested_owner.owner_account_id = active_owner.owner_account_id
      )`;

  type RoutedRow = {
    thread_root_number: number | null;
    agent_key: string | null;
    owner_account_id: string | null;
    active_session_overflow: boolean;
  };
  const rows = await executor.execute<RoutedRow>(sql`
    WITH input_root AS MATERIALIZED (
      SELECT value.thread_root_number
        FROM (VALUES ${inputRootValues}) AS value(thread_root_number)
    ), requested_owner AS MATERIALIZED (
      SELECT value.owner_account_id
        FROM jsonb_to_recordset(${JSON.stringify(
          (requestedOwnerAccountIds ?? []).map((owner_account_id) => ({ owner_account_id })),
        )}::jsonb) AS value(owner_account_id text)
    ), active_session AS MATERIALIZED (
      ${activeSessionSource}
    ), active_owner AS MATERIALIZED (
      SELECT active_session.agent_key,
             MIN(active_session.owner_account_id) AS owner_account_id
        FROM active_session
       GROUP BY active_session.agent_key
      HAVING COUNT(DISTINCT active_session.owner_account_id) = 1
    ), exact_member AS (
      SELECT DISTINCT participant_agent.thread_root_number,
             participant_agent.participant_number,
             active_owner.agent_key,
             active_owner.owner_account_id
        FROM input_root
        JOIN ${message_thread_participant_agents} AS participant_agent
          ON participant_agent.room_id = ${roomId}
         AND participant_agent.thread_root_number = input_root.thread_root_number
        JOIN active_owner
          ON active_owner.agent_key = participant_agent.agent_key
         AND active_owner.owner_account_id = participant_agent.owner_account_id
         AND participant_agent.agent_key_hash = MD5(active_owner.agent_key)
       WHERE ${exactOwnerFilter}
    ), active_alias AS (
      SELECT DISTINCT active_session.agent_key,
             normalize_message_thread_routing_alias(raw.alias_input, mode.is_handle) AS alias_text
        FROM active_session
        CROSS JOIN LATERAL (VALUES
          (active_session.actor_label),
          (active_session.display_name),
          (active_session.agent_key),
          (active_session.short_agent_key)
        ) AS raw(alias_input)
        CROSS JOIN (VALUES (false), (true)) AS mode(is_handle)
    ), legacy_projected_alias AS MATERIALIZED (
      SELECT candidate.thread_root_number,
             candidate.participant_number,
             candidate.alias_hash,
             candidate.alias_text,
             candidate.is_full
        FROM input_root
        CROSS JOIN LATERAL (
          SELECT projected.thread_root_number,
                 projected.participant_number,
                 projected.alias_hash,
                 projected.alias_text,
                 projected.is_full
            FROM ${message_thread_participant_aliases} AS projected
           WHERE projected.room_id = ${roomId}
             AND projected.thread_root_number = input_root.thread_root_number
           OFFSET 0
        ) AS candidate
       WHERE NOT EXISTS (
         SELECT 1
           FROM ${message_thread_participant_agents} AS durable_participant
          WHERE durable_participant.room_id = ${roomId}
            AND durable_participant.thread_root_number = candidate.thread_root_number
            AND durable_participant.participant_number = candidate.participant_number
       )
    ), matched_alias AS (
      SELECT DISTINCT active_alias.agent_key,
             projected_alias.thread_root_number,
             projected_alias.participant_number,
             projected_alias.is_full
        FROM legacy_projected_alias AS projected_alias
        JOIN active_alias
          ON active_alias.alias_text <> ''
         AND MD5(active_alias.alias_text) = projected_alias.alias_hash
         AND active_alias.alias_text = projected_alias.alias_text
    ), resolved_participant AS (
      SELECT matched_alias.thread_root_number,
             matched_alias.participant_number,
             CASE
               WHEN COUNT(DISTINCT matched_alias.agent_key)
                      FILTER (WHERE matched_alias.is_full) = 1
                 THEN MIN(matched_alias.agent_key) FILTER (WHERE matched_alias.is_full)
               WHEN COUNT(DISTINCT matched_alias.agent_key)
                      FILTER (WHERE matched_alias.is_full) = 0
                AND COUNT(DISTINCT matched_alias.agent_key)
                      FILTER (WHERE NOT matched_alias.is_full) = 1
                 THEN MIN(matched_alias.agent_key) FILTER (WHERE NOT matched_alias.is_full)
               ELSE NULL
             END AS agent_key
        FROM matched_alias
       GROUP BY matched_alias.thread_root_number, matched_alias.participant_number
    ), legacy_member AS (
      SELECT DISTINCT resolved_participant.thread_root_number,
             resolved_participant.agent_key,
             active_owner.owner_account_id
        FROM resolved_participant
        JOIN active_owner ON active_owner.agent_key = resolved_participant.agent_key
       WHERE resolved_participant.agent_key IS NOT NULL
         AND ${exactOwnerFilter}
    ), routed_member AS (
      SELECT exact_member.thread_root_number,
             exact_member.agent_key,
             exact_member.owner_account_id
        FROM exact_member
      UNION
      SELECT legacy_member.thread_root_number,
             legacy_member.agent_key,
             legacy_member.owner_account_id
        FROM legacy_member
    ), bounded_member AS (
      SELECT routed_member.thread_root_number,
             routed_member.agent_key,
             routed_member.owner_account_id
        FROM routed_member
       LIMIT ${MAX_GLOBAL_THREAD_ROUTING_MEMBERS + 1}
    )
    SELECT bounded_member.thread_root_number,
           bounded_member.agent_key,
           bounded_member.owner_account_id,
           false AS active_session_overflow
      FROM bounded_member
    UNION ALL
    SELECT NULL::integer,
           NULL::text,
           NULL::text,
           true AS active_session_overflow
     WHERE (SELECT COUNT(*) FROM active_session) > ${MAX_GLOBAL_THREAD_ROUTING_ACTIVE_SESSIONS}
     LIMIT ${MAX_GLOBAL_THREAD_ROUTING_MEMBERS + 2}
  `);

  if (rows.rows.some((row) => row.active_session_overflow)) {
    throw new RequestValidationError("Thread routing membership exceeds its bounded active-worker contract.");
  }
  if (rows.rows.length > MAX_GLOBAL_THREAD_ROUTING_MEMBERS) {
    throw new RequestValidationError("Thread routing membership exceeds its bounded result contract.");
  }

  const result = new Map<number, GlobalThreadRoutingMember[]>();
  for (const row of rows.rows) {
    if (row.thread_root_number === null || row.agent_key === null || row.owner_account_id === null) {
      throw new RequestValidationError("Thread routing membership returned an invalid bounded result.");
    }
    const rootNumber = Number(row.thread_root_number);
    const members = result.get(rootNumber) ?? [];
    members.push({ agent_key: row.agent_key, owner_account_id: row.owner_account_id });
    result.set(rootNumber, members);
  }
  for (const members of result.values()) {
    members.sort((left, right) => left.agent_key.localeCompare(right.agent_key));
  }
  return result;
}
