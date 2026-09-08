import { parseRoomAgentWorkSummary } from '../../../../shared/room-agent-work.mjs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeWorkspaceReview, parseWorkspaceReviewPage, type WorkspaceReview } from '../../../../shared/workspace-review.mjs';
import { apiFetch } from './auth.js';
import { apiUrl } from './paths.js';

export type WorkspaceReviewRequest = { roomId: string; agentKey: string; sourceMessageId: string; attemptId: string };
export type WorkspaceReviewResult = { status: 'ready'; review: WorkspaceReview } | { status: 'unavailable' | 'pending'; review: null };
export async function readWorkspaceReview(input: WorkspaceReviewRequest, options: { fetch?: typeof apiFetch; databasePath?: string } = {}): Promise<WorkspaceReviewResult> {
  if (!input || typeof input.roomId !== 'string' || !input.roomId || input.roomId.length > 512
    || typeof input.agentKey !== 'string' || !input.agentKey || input.agentKey.length > 512
    || !/^msg_[1-9]\d{0,9}$/.test(input.sourceMessageId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.attemptId)) throw new Error('Invalid workspace review.');
  const fetch = options.fetch ?? apiFetch;
  const url = `/rooms/${encodeURIComponent(input.roomId)}/agent-work/${encodeURIComponent(input.attemptId)}`;
  // Cached bytes are evidence for this exact current room receipt, never an
  // alternative path around membership, source visibility, or clear history.
  const work = await fetch<{ attempt_id: string; room_id: string; agent_key: string; source_message_id: string; summary: unknown }>(`${url}?include_workspace=1&include_contribution=1`);
  const summary = parseRoomAgentWorkSummary(work.summary);
  if (work.attempt_id !== input.attemptId || work.room_id !== input.roomId || work.agent_key !== input.agentKey
    || work.source_message_id !== input.sourceMessageId || !summary?.workspace || !summary.contribution) throw new Error('This review is no longer available.');
  const verify = (review: WorkspaceReview): WorkspaceReview => {
    for (const [full, preview] of [[review.workspace, summary.workspace!], [review.contribution, summary.contribution!.changes]]) {
      if (full.captured_at !== preview.captured_at || full.base_revision !== preview.base_revision
        || full.additions !== preview.additions || full.deletions !== preview.deletions
        || full.files.length + full.hidden_files !== preview.files.length + preview.hidden_files) throw new Error('Different capture returned.');
    }
    return review;
  };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(options.databasePath ?? join(homedir(), '.letagents', 'daemon-state.sqlite'), { readOnly: true });
    const row = database.prepare(`SELECT r.data,r.digest FROM room_workspace_reviews r JOIN room_work_publications p
      USING(agent_id,room_id,source_message_id) WHERE p.room_id=? AND p.agent_key=? AND p.source_message_id=? AND p.api_origin=? AND p.state='open'`)
      .get(input.roomId, input.agentKey, input.sourceMessageId, apiUrl);
    if (row) return { status: 'ready', review: verify(decodeWorkspaceReview(String(row.data), String(row.digest))) };
  } catch { /* Old captures and remote workspaces use the shared review below. */ }
  finally { database?.close(); }
  const result = await loadWorkspaceReviewPages(index => fetch(`${url}?review_page=${index}`));
  if (result.status === 'ready') verify(result.review);
  return result;
}

export async function loadWorkspaceReviewPages(fetchPage: (index: number) => Promise<unknown>): Promise<WorkspaceReviewResult> {
  const pages: string[] = [];
  let total = 1, digest = '';
  for (let index = 0; index < total; index++) {
    const result = await fetchPage(index) as { status?: string; page?: unknown };
    if (result?.status === 'pending' || result?.status === 'unavailable') return { status: result.status, review: null };
    const page = parseWorkspaceReviewPage(result?.page);
    if (result?.status !== 'ready' || !page || page.index !== index
      || (index > 0 && (page.digest !== digest || page.total !== total))) throw new Error('Incomplete workspace review.');
    total = page.total; digest = page.digest; pages.push(page.data);
  }
  return { status: 'ready', review: decodeWorkspaceReview(pages.join(''), digest) };
}
