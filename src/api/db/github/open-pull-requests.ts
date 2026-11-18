import { sql } from "drizzle-orm";

import { PARTICIPANT_PULL_REQUEST_ACTION_LIST } from "../../github/room-events/pull-request.js";
import { db } from "../client.js";
import type { GitHubRoomEventMetadata } from "../schema.js";

export interface StoredOpenPullRequest {
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  head_ref: string | null;
  base_ref: string | null;
  updated_at: string;
  check_runs: Array<{ name: string; conclusion: string | null; url: string | null }>;
  reviews: Array<{ login: string; state: string }>;
  requested_reviewers: string[];
  task_ids: string[];
}

/** The repository a room follows, as its binding (or its repo-shaped id) names it. */
export interface OpenPullRequestRepository {
  /** `github.com/owner/repo`: the repository room, which may have no binding. */
  repoRoomId: string;
  host: string;
  fullName: string;
  /** GitHub's id of the repository, when the binding recorded it. */
  repositoryId: string | null;
}

const participantActions = sql.join(PARTICIPANT_PULL_REQUEST_ACTION_LIST.map((action) => sql`${action}`), sql`, `);
const list = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * Rooms whose GitHub events concern the repository: the room and its parent,
 * the repository room, every room bound to the same repository, and their
 * focus rooms. Bindings that both carry GitHub's repository id are matched by
 * it, so a renamed or recreated repository is told apart; others by host and
 * name, ignoring case, as task-git-room.ts compares them.
 */
function repositoryFamily(roomId: string, repo: OpenPullRequestRepository) {
  return sql`
    anchor AS (
      SELECT ${roomId}::text AS room_id
      UNION SELECT parent_room_id FROM rooms WHERE id = ${roomId} AND parent_room_id IS NOT NULL
      UNION SELECT ${repo.repoRoomId}::text
      UNION SELECT binding.room_id FROM room_git_bindings AS binding
       WHERE binding.provider = 'github'
         AND CASE WHEN ${repo.repositoryId}::text IS NOT NULL AND binding.repository_id IS NOT NULL
               THEN binding.repository_id = ${repo.repositoryId}::text
               ELSE lower(binding.host) = lower(${repo.host}) AND lower(binding.repository_full_name) = lower(${repo.fullName})
             END
    ), family AS (
      SELECT room_id FROM anchor
      UNION SELECT id FROM rooms WHERE parent_room_id IN (SELECT room_id FROM anchor)
    )`;
}

/**
 * The repository's open pull requests as the stored GitHub events tell them:
 * the newest pull_request event of each decides its state. Nothing here asks
 * GitHub. The newest-event pass reads narrow columns only; the payload
 * excerpt is read for the pull requests kept.
 */
export async function listOpenPullRequestsFromEvents(
  roomId: string,
  repo: OpenPullRequestRepository,
  options: { limit: number },
): Promise<{ pullRequests: StoredOpenPullRequest[]; truncated: boolean }> {
  const family = repositoryFamily(roomId, repo);
  const inFamily = sql`room_id IN (SELECT room_id FROM family)`;
  const latest = await db.execute<{
    github_object_id: string; github_object_url: string | null; title: string | null; event_order_at: string;
    head_ref: string | null; base_ref: string | null; head_sha: string | null; metadata: GitHubRoomEventMetadata | null;
  }>(sql`
    WITH ${family}, newest AS (
      SELECT DISTINCT ON (github_object_id) id, state, event_order_at
        FROM github_room_events
       WHERE event_type = 'pull_request' AND github_object_id IS NOT NULL
         AND action NOT IN (${participantActions}) AND ${inFamily}
       ORDER BY github_object_id, event_order_at DESC, created_at DESC, id DESC
    ), kept AS (
      SELECT id, event_order_at FROM newest WHERE state = 'open' ORDER BY event_order_at DESC, id DESC LIMIT ${options.limit + 1}
    )
    SELECT event.github_object_id, event.github_object_url, event.title, event.event_order_at,
      event.head_ref, event.base_ref, event.head_sha, event.metadata
      FROM kept JOIN github_room_events AS event ON event.id = kept.id
     ORDER BY kept.event_order_at DESC, kept.id DESC
  `);
  const truncated = latest.rows.length > options.limit;
  const rows = latest.rows.slice(0, options.limit).filter((row) => /^\d+$/.test(row.github_object_id) && row.github_object_url);
  if (!rows.length) return { pullRequests: [], truncated };

  const numbers = list(rows.map((row) => row.github_object_id));
  const heads = [...new Set(rows.map((row) => row.head_sha).filter((sha): sha is string => Boolean(sha)))];
  const urls = list(rows.map((row) => row.github_object_url!.toLowerCase()));
  const [reviewRows, requestRows, checkRows, taskRows] = await Promise.all([
    // Each reviewer's newest decisive review (approved, changes requested,
    // dismissed), else their newest; a later comment does not undo an
    // approval, as the board's PR status counts it.
    db.execute<{ github_object_id: string; actor_login: string; state: string; reviewed_at: string }>(sql`
      WITH ${family}
      SELECT DISTINCT ON (github_object_id, actor_login) github_object_id, actor_login,
        lower(COALESCE(state, action)) AS state,
        max(event_order_at) OVER (PARTITION BY github_object_id, actor_login) AS reviewed_at
        FROM github_room_events
       WHERE event_type = 'pull_request_review' AND actor_login IS NOT NULL
         AND github_object_id IN (${numbers}) AND ${inFamily}
       ORDER BY github_object_id, actor_login,
         lower(COALESCE(state, action)) IN ('approved', 'changes_requested', 'dismissed') DESC,
         event_order_at DESC, created_at DESC, id DESC
    `),
    // The newest request or removal of each reviewer decides.
    db.execute<{ github_object_id: string; subject: string; action: string; event_order_at: string }>(sql`
      WITH ${family}, requests AS (
        SELECT github_object_id, action, event_order_at, created_at, id,
          COALESCE(metadata->'participant'->>'login', 'team:' || (metadata->'participant'->>'team_slug')) AS subject
          FROM github_room_events
         WHERE event_type = 'pull_request' AND action IN ('review_requested', 'review_request_removed')
           AND COALESCE(metadata->'participant'->>'role', 'reviewer') = 'reviewer'
           AND github_object_id IN (${numbers}) AND ${inFamily}
      )
      SELECT DISTINCT ON (github_object_id, subject) github_object_id, subject, action, event_order_at
        FROM requests WHERE subject IS NOT NULL
       ORDER BY github_object_id, subject, event_order_at DESC, created_at DESC, id DESC
    `),
    // The newest run of each check on each head commit.
    heads.length
      ? db.execute<{ head_sha: string; name: string; conclusion: string | null; url: string | null }>(sql`
          WITH ${family}
          SELECT DISTINCT ON (head_sha, COALESCE(title, github_object_id)) head_sha,
            COALESCE(title, github_object_id, 'unknown') AS name,
            COALESCE(metadata->>'conclusion', state) AS conclusion, github_object_url AS url
            FROM github_room_events
           WHERE event_type = 'check_run' AND head_sha IN (${list(heads)}) AND ${inFamily}
           ORDER BY head_sha, COALESCE(title, github_object_id), event_order_at DESC, created_at DESC, id DESC
        `)
      : Promise.resolve({ rows: [] as Array<{ head_sha: string; name: string; conclusion: string | null; url: string | null }> }),
    // Board tasks in this room that link a kept pull request; a link Jev only
    // suggested does not count until a person confirms it.
    db.execute<{ number: number; pr_url: string | null; urls: string[] | null }>(sql`
      SELECT task.number, lower(task.pr_url) AS pr_url,
        ARRAY(SELECT lower(artifact->>'url') FROM jsonb_array_elements(task.workflow_artifacts) AS artifact
               WHERE artifact->>'kind' = 'pull_request' AND artifact->>'url' IS NOT NULL
                 AND COALESCE(artifact->>'linked_by', '') <> 'jev_suggested') AS urls
        FROM tasks AS task
       WHERE task.room_id = ${roomId}
         AND (lower(task.pr_url) IN (${urls})
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(task.workflow_artifacts) AS artifact
                       WHERE lower(artifact->>'url') IN (${urls})))
       ORDER BY task.number
    `),
  ]);

  return {
    truncated,
    pullRequests: rows.map((row) => {
      const metadata = record(row.metadata);
      const url = row.github_object_url!;
      const reviews = reviewRows.rows.filter((review) => review.github_object_id === row.github_object_id);
      return {
        number: Number(row.github_object_id),
        title: row.title ?? `#${row.github_object_id}`,
        url,
        author: text(metadata.author_login),
        draft: metadata.draft === true,
        head_ref: row.head_ref,
        base_ref: row.base_ref,
        updated_at: new Date(row.event_order_at).toISOString(),
        check_runs: checkRows.rows
          .filter((check) => row.head_sha && check.head_sha === row.head_sha)
          .map(({ name, conclusion, url: checkUrl }) => ({ name, conclusion, url: checkUrl }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        reviews: reviews.map(({ actor_login, state }) => ({ login: actor_login, state })),
        // A review after the request answers it: GitHub sends no removal then.
        requested_reviewers: requestRows.rows
          .filter((request) => request.github_object_id === row.github_object_id && request.action === "review_requested")
          .filter((request) => !reviews.some((review) => review.actor_login === request.subject
            && new Date(review.reviewed_at).getTime() >= new Date(request.event_order_at).getTime()))
          .map((request) => request.subject),
        task_ids: taskRows.rows
          .filter((task) => task.pr_url === url.toLowerCase() || task.urls?.includes(url.toLowerCase()))
          .map((task) => `task_${task.number}`),
      };
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
