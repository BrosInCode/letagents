import { Worker } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseRoomAgentWorkSummary } from '../../../../shared/room-agent-work.mjs';
import { parseWorkspaceReviewPage, type WorkspaceReview, type WorkspaceReviewPage } from '../../../../shared/workspace-review.mjs';
import type { WorkspaceDiffPage, WorkspaceDiffPageOptions } from '../../../../shared/workspace-diff.mjs';
import { apiFetch, DesktopApiError } from './auth.js';
import { apiUrl } from './paths.js';

export type WorkspaceReviewRequest = { roomId: string; agentKey: string; sourceMessageId: string; attemptId: string; requestId: string };
export type WorkspaceReviewPageRequest = WorkspaceDiffPageOptions & { requestId: string; view: 'workspace' | 'contribution'; path: string };
// Ready contains metadata only; captured patches stay in the review worker.
export type WorkspaceReviewResult = { status: 'ready'; review: WorkspaceReview } | { status: 'unavailable' | 'pending'; review: null };
const validId = (id: unknown) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

class InvalidatedReviewError extends Error {}

export class WorkspaceReviewSession {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private abort = new AbortController();
  private closing?: Promise<unknown>;
  private pageAbort?: AbortController;
  private review?: WorkspaceReview;
  constructor(readonly input: WorkspaceReviewRequest, private options: { fetch?: typeof apiFetch; databasePath?: string } = {}) {
    if (!input || typeof input.roomId !== 'string' || !input.roomId || input.roomId.length > 512
      || typeof input.agentKey !== 'string' || !input.agentKey || input.agentKey.length > 512
      || !/^msg_[1-9]\d{0,9}$/.test(input.sourceMessageId) || !validId(input.attemptId) || !validId(input.requestId)) throw new Error('Invalid workspace review.');
  }
  private fetch<T>(suffix: string, signal = this.abort.signal): Promise<T> {
    signal.throwIfAborted();
    return (this.options.fetch ?? apiFetch)<T>(`/rooms/${encodeURIComponent(this.input.roomId)}/agent-work/${encodeURIComponent(this.input.attemptId)}${suffix}`,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  }
  private async authorize(signal = this.abort.signal) {
    const work = await this.fetch<{ attempt_id: string; room_id: string; agent_key: string; source_message_id: string; summary: unknown }>('?include_workspace=1&include_contribution=1', signal);
    signal.throwIfAborted();
    const summary = parseRoomAgentWorkSummary(work.summary);
    if (work.attempt_id !== this.input.attemptId || work.room_id !== this.input.roomId || work.agent_key !== this.input.agentKey
      || work.source_message_id !== this.input.sourceMessageId || !summary?.workspace || !summary.contribution) throw new InvalidatedReviewError('This review is no longer available.');
    return summary;
  }
  private verify(review: WorkspaceReview, summary: Awaited<ReturnType<WorkspaceReviewSession['authorize']>>) {
    for (const [full, preview] of [[review.workspace, summary.workspace!], [review.contribution, summary.contribution!.changes]]) {
      if (full.captured_at !== preview.captured_at || full.base_revision !== preview.base_revision
        || full.additions !== preview.additions || full.deletions !== preview.deletions
        || full.files.length + full.hidden_files !== preview.files.length + preview.hidden_files) throw new InvalidatedReviewError('Different capture returned.');
    }
  }
  private rpc<T>(method: string, input?: unknown): Promise<T> {
    this.abort.signal.throwIfAborted();
    if (!this.worker) {
      this.worker = new Worker(new URL('../../../../shared/workspace-review-worker.mjs', import.meta.url), { execArgv: [] });
      this.worker.on('message', ({ id, result, error }) => {
        const request = this.pending.get(id); this.pending.delete(id);
        if (error) request?.reject(new Error(error)); else request?.resolve(result);
      });
      this.worker.on('error', error => { this.fail(error); void this.close(); });
      this.worker.on('exit', () => { this.abort.abort(); this.fail(new Error('Review was closed.')); });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ id, method, input }); });
  }
  private fail(error: Error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  async open(): Promise<WorkspaceReviewResult> {
    try {
      const summary = await this.authorize();
      let review = await this.rpc<WorkspaceReview | null>('local', { ...this.input, apiOrigin: apiUrl, databasePath: this.options.databasePath ?? join(homedir(), '.letagents', 'daemon-state.sqlite') });
      if (review) { try { this.verify(review, summary); } catch { review = null; } }
      if (!review) {
        const status = await loadWorkspaceReviewPages(index => this.fetch(`?review_page=${index}`), pages => this.rpc('append', pages), this.abort.signal);
        if (status !== 'ready') { await this.close(); return { status, review: null }; }
        review = await this.rpc<WorkspaceReview>('finish');
        this.verify(review, summary);
      }
      this.abort.signal.throwIfAborted(); this.review = review;
      return { status: 'ready', review };
    } catch (error) { await this.close(); throw error; }
  }
  async page(input: WorkspaceReviewPageRequest): Promise<WorkspaceDiffPage> {
    if (input.requestId !== this.input.requestId || !this.review) throw new Error('Review is not open.');
    this.pageAbort?.abort(); this.pageAbort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, this.pageAbort.signal]);
    try {
      this.verify(this.review, await this.authorize(signal));
      signal.throwIfAborted();
      return await this.rpc('page', input);
    } catch (error) {
      if (error instanceof InvalidatedReviewError || (error instanceof DesktopApiError && [401, 403, 404, 410].includes(error.status))) await this.close();
      throw error; // A transient network failure can retry the same open page.
    }
  }
  close(): Promise<unknown> {
    if (this.closing) return this.closing;
    this.abort.abort(); this.review = undefined; this.fail(new Error('Review was closed.'));
    this.closing = this.worker?.terminate() ?? Promise.resolve();
    return this.closing;
  }
}

/** Four bounded pages in flight; never accumulate the archive on the main thread. */
export async function loadWorkspaceReviewPages(fetchPage: (index: number) => Promise<unknown>, append: (pages: WorkspaceReviewPage[]) => Promise<unknown>, signal: AbortSignal): Promise<'ready' | 'pending' | 'unavailable'> {
  let total = 1, digest = '';
  for (let start = 0; start < total;) {
    signal.throwIfAborted();
    const results = await Promise.all(Array.from({ length: Math.min(start ? 4 : 1, total - start) }, (_, offset) => fetchPage(start + offset)));
    signal.throwIfAborted();
    const pages: WorkspaceReviewPage[] = [];
    for (let offset = 0; offset < results.length; offset++) {
      const result = results[offset] as { status?: string; page?: unknown };
      if (result?.status === 'pending' || result?.status === 'unavailable') return result.status;
      const page = parseWorkspaceReviewPage(result?.page);
      if (result?.status !== 'ready' || !page || page.index !== start + offset
        || (start + offset > 0 && (page.digest !== digest || page.total !== total))) throw new Error('Incomplete workspace review.');
      total = page.total; digest = page.digest; pages.push(page);
    }
    await append(pages); start += pages.length;
  }
  return 'ready';
}

const sessions = new Map<number, WorkspaceReviewSession>();
const retirements = new Map<number, Promise<unknown>>();
async function retire(owner: number, session?: WorkspaceReviewSession): Promise<void> {
  const retired = Promise.all([retirements.get(owner), session?.close()]);
  retirements.set(owner, retired);
  await retired;
  if (retirements.get(owner) === retired) retirements.delete(owner);
}
export async function readWorkspaceReview(owner: number, input: WorkspaceReviewRequest): Promise<WorkspaceReviewResult> {
  const session = new WorkspaceReviewSession(input);
  const prior = sessions.get(owner); sessions.set(owner, session);
  // A rapid third open must also wait for the first worker to finish retiring.
  await retire(owner, prior);
  try { return await session.open(); }
  catch (error) { if (sessions.get(owner) === session) sessions.delete(owner); throw error; }
}
export async function readWorkspaceReviewPage(owner: number, input: WorkspaceReviewPageRequest): Promise<WorkspaceDiffPage> {
  const session = sessions.get(owner);
  if (!session || !input || session.input.requestId !== input.requestId) throw new Error('Review is not open.');
  return session.page(input);
}
export async function closeWorkspaceReview(owner: number, requestId?: string): Promise<void> {
  const session = sessions.get(owner);
  if (session && (!requestId || session.input.requestId === requestId)) { sessions.delete(owner); await retire(owner, session); }
}
