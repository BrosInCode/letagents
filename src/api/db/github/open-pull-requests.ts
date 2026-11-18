import { sql } from "drizzle-orm";

import { PARTICIPANT_PULL_REQUEST_ACTION_LIST } from "../../github/room-events/pull-request.js";
import { db } from "../client.js";
import type { GitHubRoomEventMetadata } from "../schema.js";
import { repositoryRoomIds } from "./repository-rooms.js";

export interface StoredOpenPullRequest {
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  head_ref: string | null;
  base_ref: string | null;
  head_sha: string | null;
  updated_at: string;
  check_runs: Array<{ name: string; status: string | null; conclusion: string | null; url: string | null }>;
  reviews: Array<{ login: string; state: string }>;
  requested_reviewers: string[];
  task_ids: string[];
}

const DECISIVE_REVIEW_STATES = new Set(["approved", "changes_requested", "dismissed"]);
const participantActions = sql.join(PARTICIPANT_PULL_REQUEST_ACTION_LIST.map((action) => sql`${action}`), sql`, `);

/**
 * The repository's open pull requests as the stored GitHub events tell them:
 * the newest pull_request event of each decides its state. Events of one
 * repository land in its repo room, branch rooms or focus rooms, so all of
 * them are read. Nothing here asks GitHub.
 */
export async function listOpenPullRequestsFromEvents(
  roomId: string,
  options: { limit: number },
): Promise<{ pullRequests: StoredOpenPullRequest[]; truncated: boolean }> {
  const family = repositoryRoomIds(roomId);
  const latest = await db.execute<{
    github_object_id: string; github_object_url: string | null; title: string | null; state: string | null;
    event_order_at: string; head_ref: string | null; base_ref: string | null; head_sha: string | null;
    metadata: GitHubRoomEventMetadata | null;
  }>(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (github_object_id) github_object_id, github_object_url, title, state, event_order_at,
        head_ref, base_ref, head_sha, metadata
        FROM github_room_events
       WHERE event_type = 'pull_request' AND github_object_id IS NOT NULL
         AND action NOT IN (${participantActions})
         AND room_id IN ${family}
       ORDER BY github_object_id, event_order_at DESC, created_at DESC, id DESC
    ) AS latest
     WHERE state = 'open'
     ORDER BY event_order_at DESC
     LIMIT ${options.limit + 1}
  `);
  const truncated = latest.rows.length > options.limit;
  const rows = latest.rows.slice(0, options.limit).filter((row) => /^\d+$/.test(row.github_object_id) && row.github_object_url);
  if (!rows.length) return { pullRequests: [], truncated };

  const numbers = sql.join(rows.map((row) => sql`${row.github_object_id}`), sql`, `);
  const heads = rows.map((row) => row.head_sha).filter((sha): sha is string => Boolean(sha));
  const urls = rows.map((row) => row.github_object_url!.toLowerCase());
  const [reviewRows, requestRows, checkRows, taskRows] = await Promise.all([
    db.execute<{ github_object_id: string; actor_login: string | null; state: string | null; action: string; event_order_at: string }>(sql`
      SELECT github_object_id, actor_login, state, action, event_order_at FROM github_room_events
       WHERE event_type = 'pull_request_review' AND github_object_id IN (${numbers}) AND room_id IN ${family}
       ORDER BY event_order_at DESC, created_at DESC, id DESC
       LIMIT 2000
    `),
    db.execute<{ github_object_id: string; action: string; metadata: GitHubRoomEventMetadata | null; event_order_at: string }>(sql`
      SELECT github_object_id, action, metadata, event_order_at FROM github_room_events
       WHERE event_type = 'pull_request' AND action IN ('review_requested', 'review_request_removed')
         AND github_object_id IN (${numbers}) AND room_id IN ${family}
       ORDER BY event_order_at DESC, created_at DESC, id DESC
       LIMIT 2000
    `),
    heads.length
      ? db.execute<{ head_sha: string; title: string | null; github_object_id: string | null; github_object_url: string | null; metadata: GitHubRoomEventMetadata | null; state: string | null }>(sql`
          SELECT head_sha, title, github_object_id, github_object_url, metadata, state FROM github_room_events
           WHERE event_type = 'check_run' AND head_sha IN (${sql.join(heads.map((sha) => sql`${sha}`), sql`, `)})
             AND room_id IN ${family}
           ORDER BY event_order_at DESC, created_at DESC, id DESC
           LIMIT 2000
        `)
      : Promise.resolve({ rows: [] }),
    db.execute<{ number: number; pr_url: string | null; urls: string[] | null }>(sql`
      SELECT task.number, task.pr_url,
        ARRAY(SELECT lower(artifact->>'url') FROM jsonb_array_elements(task.workflow_artifacts) AS artifact
               WHERE artifact->>'kind' = 'pull_request' AND artifact->>'url' IS NOT NULL
                 AND COALESCE(artifact->>'linked_by', '') <> 'jev_suggested') AS urls
        FROM tasks AS task
       WHERE task.room_id = ${roomId}
         AND (lower(task.pr_url) IN (${sql.join(urls.map((url) => sql`${url}`), sql`, `)})
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(task.workflow_artifacts) AS artifact
                       WHERE lower(artifact->>'url') IN (${sql.join(urls.map((url) => sql`${url}`), sql`, `)})))
       ORDER BY task.number
    `),
  ]);

  return {
    truncated,
    pullRequests: rows.map((row) => {
      const metadata = record(row.metadata);
      const url = row.github_object_url!;
      const reviews = foldReviews(reviewRows.rows.filter((review) => review.github_object_id === row.github_object_id));
      return {
        number: Number(row.github_object_id),
        title: row.title ?? `#${row.github_object_id}`,
        url,
        author: text(metadata.author_login),
        draft: metadata.draft === true,
        head_ref: row.head_ref,
        base_ref: row.base_ref,
        head_sha: row.head_sha,
        updated_at: new Date(row.event_order_at).toISOString(),
        check_runs: row.head_sha ? foldChecks(checkRows.rows.filter((check) => check.head_sha === row.head_sha)) : [],
        reviews: reviews.map(({ login, state }) => ({ login, state })),
        requested_reviewers: foldRequests(requestRows.rows.filter((request) => request.github_object_id === row.github_object_id), reviews),
        task_ids: taskRows.rows
          .filter((task) => task.pr_url?.toLowerCase() === url.toLowerCase() || task.urls?.includes(url.toLowerCase()))
          .map((task) => `task_${task.number}`),
      };
    }),
  };
}

/**
 * One review per reviewer: the newest decisive one (approved, changes
 * requested, dismissed), else the newest. A later comment does not undo an
 * approval; GitHub counts it the same way. Rows come newest first.
 */
function foldReviews(rows: ReadonlyArray<{ actor_login: string | null; state: string | null; action: string; event_order_at: string }>) {
  const byLogin = new Map<string, { login: string; state: string; at: number }>();
  for (const row of rows) {
    if (!row.actor_login) continue;
    const state = (row.state ?? row.action).toLowerCase();
    const existing = byLogin.get(row.actor_login);
    if (!existing) byLogin.set(row.actor_login, { login: row.actor_login, state, at: new Date(row.event_order_at).getTime() });
    else if (!DECISIVE_REVIEW_STATES.has(existing.state) && DECISIVE_REVIEW_STATES.has(state)) existing.state = state;
  }
  return [...byLogin.values()];
}

/**
 * Reviewers still asked for: the newest request or removal of each decides,
 * and a review submitted after the request answers it (GitHub sends no
 * removal then).
 */
function foldRequests(
  rows: ReadonlyArray<{ action: string; metadata: GitHubRoomEventMetadata | null; event_order_at: string }>,
  reviews: ReadonlyArray<{ login: string; at: number }>,
): string[] {
  const latest = new Map<string, { requested: boolean; at: number }>();
  for (const row of rows) {
    const participant = record(record(row.metadata).participant);
    if (participant.role !== undefined && participant.role !== "reviewer") continue;
    const subject = text(participant.login) ?? (text(participant.team_slug) ? `team:${text(participant.team_slug)}` : null);
    if (!subject || latest.has(subject)) continue;
    latest.set(subject, { requested: row.action === "review_requested", at: new Date(row.event_order_at).getTime() });
  }
  return [...latest.entries()]
    .filter(([subject, entry]) => entry.requested && !reviews.some((review) => review.login === subject && review.at >= entry.at))
    .map(([subject]) => subject);
}

/** The newest run of each check name on the head commit, by name. Rows come newest first. */
function foldChecks(rows: ReadonlyArray<{ title: string | null; github_object_id: string | null; github_object_url: string | null; metadata: GitHubRoomEventMetadata | null; state: string | null }>) {
  const byName = new Map<string, { name: string; status: string | null; conclusion: string | null; url: string | null }>();
  for (const row of rows) {
    const name = row.title ?? row.github_object_id ?? "unknown";
    if (byName.has(name)) continue;
    const metadata = record(row.metadata);
    byName.set(name, {
      name,
      status: text(metadata.status),
      conclusion: text(metadata.conclusion) ?? (text(metadata.status) === "completed" ? row.state : null),
      url: row.github_object_url,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
