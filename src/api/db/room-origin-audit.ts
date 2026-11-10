import type { Pool } from "pg";

import { originFromIdShape } from "../rooms/room-nature.js";

/**
 * Read-only checks run after the migrations on every deploy. They log what
 * they find and fix nothing: a later step decides which store wins.
 *
 * - Parity: rooms whose stored origin differs from the id-shape rule
 *   (rooms/room-nature.ts originFromIdShape), and rooms still without one.
 * - Repository identity: a repository is named in five places (the room id,
 *   github_repositories, github_app_repositories, room_git_bindings,
 *   room_aliases). Each query lists rows where two of them disagree.
 */
/** True for an id the SQL rule can classify (ASCII only; see migration 0147). */
export const ASCII_ROOM_ID_SQL = `r.id ~ E'^[\\\\x01-\\\\x7f]*$'`;

export const ROOM_ORIGIN_SHAPE_SQL = `CASE
     WHEN r.kind = 'focus' THEN 'focus'
     WHEN upper(r.id) ~ '^[A-Z0-9]{4}(-[A-Z0-9]{4}){1,2}$' THEN 'join_code'
     WHEN r.id ~ '^[A-Za-z0-9.-]+/[^/]+/[^/]+$' THEN 'repo'
     WHEN lower(split_part(r.id, '/', 1)) = 'gitlab.com'
       AND array_length(string_to_array(r.id, '/'), 1) >= 3 THEN 'repo'
     ELSE 'named'
   END`;

export const ROOM_ORIGIN_AUDIT_QUERIES: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "origin_missing",
    sql: `SELECT r.id AS room_id, NULL::text AS detail FROM rooms AS r WHERE r.origin IS NULL`,
  },
  {
    name: "origin_differs_from_id_shape",
    sql: `SELECT r.id AS room_id, r.origin || ' vs ' || (${ROOM_ORIGIN_SHAPE_SQL}) AS detail
            FROM rooms AS r
           WHERE r.origin IS NOT NULL AND ${ASCII_ROOM_ID_SQL} AND r.origin <> (${ROOM_ORIGIN_SHAPE_SQL})`,
  },
  {
    name: "github_repository_room_id_differs_from_full_name",
    sql: `SELECT g.room_id, g.full_name AS detail
            FROM github_repositories AS g
           WHERE g.room_id <> 'github.com/' || lower(g.full_name)`,
  },
  {
    name: "default_binding_differs_from_room_id",
    sql: `SELECT b.room_id, b.host || '/' || b.repository_full_name AS detail
            FROM room_git_bindings AS b
            JOIN rooms AS r ON r.id = b.room_id
           WHERE r.kind = 'main'
             AND b.ref_type = 'default_branch'
             AND b.room_id <> lower(b.host || '/' || b.repository_full_name)`,
  },
  {
    name: "bound_main_room_without_repo_origin",
    sql: `SELECT r.id AS room_id, coalesce(r.origin, 'NULL') || ' bound to ' || b.repository_full_name AS detail
            FROM rooms AS r
            JOIN room_git_bindings AS b ON b.room_id = r.id
           WHERE r.kind = 'main' AND r.origin IS DISTINCT FROM 'repo'`,
  },
  {
    name: "app_repository_room_missing",
    sql: `SELECT a.room_id, a.full_name AS detail
            FROM github_app_repositories AS a
           WHERE a.removed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM rooms AS r WHERE r.id = a.room_id)`,
  },
  {
    name: "app_repository_room_differs_from_github_repository",
    sql: `SELECT a.room_id, 'github_repositories says ' || g.room_id AS detail
            FROM github_app_repositories AS a
            JOIN github_repositories AS g ON g.github_repo_id = a.github_repo_id
           WHERE a.room_id <> g.room_id`,
  },
  {
    name: "alias_is_also_a_room_id",
    sql: `SELECT a.room_id, a.alias AS detail
            FROM room_aliases AS a
            JOIN rooms AS r ON r.id = a.alias`,
  },
];

export interface RoomOriginAuditFinding {
  name: string;
  count: number;
  examples: Array<{ room_id: string; detail: string | null }>;
}

const EXAMPLE_LIMIT = 5;

/** Run every audit query. Read-only; each query is one statement on its own. */
export async function auditRoomOrigin(
  pool: Pick<Pool, "query">,
): Promise<RoomOriginAuditFinding[]> {
  const findings: RoomOriginAuditFinding[] = [];
  for (const query of ROOM_ORIGIN_AUDIT_QUERIES) {
    const result = await pool.query<{ room_id: string; detail: string | null; total: string }>(
      `SELECT found.room_id, found.detail, count(*) OVER ()::text AS total
         FROM (${query.sql}) AS found
        ORDER BY found.room_id
        LIMIT ${EXAMPLE_LIMIT}`,
    );
    findings.push({
      name: query.name,
      count: Number(result.rows[0]?.total ?? 0),
      examples: result.rows.map(({ room_id, detail }) => ({ room_id, detail })),
    });
  }

  // Ids outside ASCII: compare with the JavaScript rule itself.
  const nonAscii = await pool.query<{ id: string; kind: string; origin: string }>(
    `SELECT r.id, r.kind, r.origin FROM rooms AS r WHERE r.origin IS NOT NULL AND NOT (${ASCII_ROOM_ID_SQL}) ORDER BY r.id`,
  );
  const differing = nonAscii.rows.filter((row) => row.origin !== originFromIdShape(row));
  const parity = findings.find((finding) => finding.name === "origin_differs_from_id_shape")!;
  parity.count += differing.length;
  parity.examples.push(
    ...differing.slice(0, EXAMPLE_LIMIT).map((row) => ({ room_id: row.id, detail: `${row.origin} vs ${originFromIdShape(row)}` })),
  );
  return findings;
}

/** Log the audit in a few lines. Never throws: an audit must not fail a deploy. */
export async function logRoomOriginAudit(
  pool: Pick<Pool, "query">,
  log: (line: string) => void = (line) => console.log(line),
): Promise<RoomOriginAuditFinding[] | null> {
  try {
    const findings = await auditRoomOrigin(pool);
    const found = findings.filter((finding) => finding.count > 0);
    if (!found.length) {
      log("[room origin audit] no mismatches");
    }
    for (const finding of found) {
      log(`[room origin audit] ${finding.name}: ${finding.count} (e.g. ${JSON.stringify(finding.examples)})`);
    }
    return findings;
  } catch (error) {
    log(`[room origin audit] could not run: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
