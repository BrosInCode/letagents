import { eq } from 'drizzle-orm';
import { boardTaskColumn, type BoardPlanningDocument, type BoardReleases, type BoardTaskFact } from '../../../shared/board-planning.mjs';
import { db } from '../db/client.js';
import { external_items, tasks, tracker_connections } from '../db/schema.js';
import { getTasksGitHubArtifactStatus } from '../db/github/artifact-status.js';
import { pullRequestsFor, pullRequestUrl } from './my-work.js';
import { readReleaseFields } from './providers/release-fields.js';

/** Only tickets already bound to this room. No account-wide discovery or local checkout dependency. */
export async function readBoardReleases(roomId: string, document: BoardPlanningDocument, facts: BoardTaskFact[]): Promise<BoardReleases> {
  const rows = await db.select({ number: tasks.number, pr_url: tasks.pr_url, workflow_artifacts: tasks.workflow_artifacts,
    connectionId: external_items.connection_id, provider: external_items.provider, payload: external_items.payload,
    rawStatus: external_items.raw_status, owner: external_items.assignee_label, syncedAt: external_items.synced_at,
    connectionName: tracker_connections.display_name, connectionStatus: tracker_connections.status,
  }).from(tasks).leftJoin(external_items, eq(tasks.external_item_id, external_items.id))
    .leftJoin(tracker_connections, eq(external_items.connection_id, tracker_connections.id)).where(eq(tasks.room_id, roomId));
  const sources = new Map<string, BoardReleases['sources'][number]>();
  for (const row of rows) {
    if (!row.connectionId) continue;
    let source = sources.get(row.connectionId);
    if (!source) { source = { id: row.connectionId, name: row.connectionName ?? row.provider ?? 'Tracker', provider: row.provider ?? '', fields: [] }; sources.set(row.connectionId, source); }
    const rawStatus = typeof row.payload?.releaseRawStatus === 'string' ? row.payload.releaseRawStatus : row.rawStatus;
    const fields = [{ id: 'status', name: 'Status', values: rawStatus ? [rawStatus] : null }, ...readReleaseFields(row.payload?.releaseFields)];
    for (const field of fields) {
      const existing = source.fields.find(item => item.id === field.id);
      if (!existing) source.fields.push({ ...field, values: field.values ?? [] });
      else existing.values = [...new Set([...existing.values, ...field.values ?? []])].sort();
    }
  }
  const rule = document.releaseRule;
  const result: BoardReleases = { sources: [...sources.values()], items: [], unavailable: 0 };
  if (!rule) return result;
  const byId = new Map(rows.map(row => [`task_${row.number}`, row]));
  const selected = facts.filter(task => {
    if (task.status === 'cancelled') return false;
    if (rule.kind === 'column') return boardTaskColumn(document, task) === rule.columnId;
    const row = byId.get(task.id);
    if (!row || row.connectionId !== rule.connectionId) return false;
    const rawStatus = typeof row.payload?.releaseRawStatus === 'string' ? row.payload.releaseRawStatus : row.rawStatus;
    const values = rule.fieldId === 'status' ? rawStatus ? [rawStatus] : null
      : readReleaseFields(row.payload?.releaseFields).find(field => field.id === rule.fieldId)?.values;
    if (!values || row.connectionStatus !== 'active') { result.unavailable += 1; return false; }
    if (row.payload?.releaseRefreshFailed) result.unavailable += 1;
    return values.includes(rule.value);
  });
  // The configured source disappeared: show an unavailable state in Board, never "all released".
  if (rule.kind === 'tracker' && !sources.has(rule.connectionId)) result.unavailable += 1;
  const statuses = await getTasksGitHubArtifactStatus(roomId, selected.map(task => Number(task.id.slice(5))));
  result.items = selected.map(task => {
    const row = byId.get(task.id)!;
    return { taskId: task.id, title: task.title, ticketKey: task.externalRef?.split(':').slice(1).join(':') ?? null,
      ticketUrl: task.ticketUrl, owner: row?.owner || task.assignee?.split('|')[0].trim() || null,
      checkedAt: typeof row?.payload?.releaseMetadataCheckedAt === 'string' ? row.payload.releaseMetadataCheckedAt : row?.syncedAt ?? null,
      pullRequests: explicitPullRequests(row, statuses.get(task.id)) };
  });
  return result;
}

/** Suggestions are not release evidence until a person confirms the relationship. */
function explicitPullRequests(row: Parameters<typeof pullRequestsFor>[0], status: Parameters<typeof pullRequestsFor>[1]) {
  const artifacts = (row.workflow_artifacts ?? []).filter(artifact => artifact.linked_by !== 'jev_suggested');
  const urls = new Set([row.pr_url, ...artifacts.filter(artifact => artifact.provider === 'github' && artifact.kind === 'pull_request').map(artifact => artifact.url ?? null)].map(pullRequestUrl).filter(Boolean));
  return pullRequestsFor({ pr_url: row.pr_url, workflow_artifacts: artifacts }, status?.pr_url && urls.has(pullRequestUrl(status.pr_url)) ? status : undefined)
    .filter(pr => pullRequestUrl(pr.url));
}
