import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { parseRoomAgentWorkSummary } from '../../../../shared/room-agent-work.mjs';
import { REVIEW_LIMIT, REVIEW_PAGE_SIZE } from '../../../../shared/workspace-review.mjs';
import { releaseWorkspaceTree } from '../../../../shared/workspace-turn-capture.mjs';
import { getLocalStatePath, readLocalStateSnapshot, updateLocalState } from '../../local-state/storage.js';
import type { StoredAgentSessionState, StoredWorkspaceCapture } from '../../local-state/types.js';
import { assertWorkerConnection } from '../../worker-call-context.js';
import { encodeRoomIdPath } from '../../room-id.js';
import { agentSessionCredentials, resolveWorkerToolIdentity } from './agent-sessions.js';
import { ApiError, apiCall, getApiUrl } from './api.js';
import { getRuntimeWorkingDirectory } from './daemon-tool-context.js';
import { isLocalRoomStorageEnabled } from '../../local-state.js';
import { requireValidWorkerBearerRuntime } from './worker-bearer.js';

const execute = promisify(execFile);
const activeCalls = new Set<string>();
let captureWorkerActive = false;
const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const directory = (id: string) => join(`${getLocalStatePath()}.workspaces`, id);
const preparationDirectory = (capture: StoredWorkspaceCapture) => {
  if (!capture.preparation_id || !validId(capture.preparation_id)) throw new Error('Saved preparation is unavailable.');
  return join(directory(capture.capture_id), capture.preparation_id);
};
const sameWorker = (capture: StoredWorkspaceCapture, session: StoredAgentSessionState) => capture.api_url === getApiUrl()
  && capture.room_id === session.room_id && capture.agent_key === session.agent_key && capture.agent_instance_id === session.agent_instance_id;

async function identity(roomId: string, agentSessionId?: string) {
  if (requireValidWorkerBearerRuntime().mode !== 'owner') throw new Error('Desktop-supervised agents already have automatic capture. These tools require an independent MCP worker.');
  const { agentSession } = await resolveWorkerToolIdentity({ roomId, agentSessionId });
  if (!agentSession.agent_instance_id || !agentSession.session_token || agentSession.ended_at) throw new Error('Reconnect this worker with register_agent_session first.');
  if (await isLocalRoomStorageEnabled(agentSession.room_id)) throw new Error('Workspace sharing requires a hosted LetAgents room. Join the shared room before capturing.');
  assertWorkerConnection(agentSession);
  return agentSession;
}

function captures() {
  const snapshot = readLocalStateSnapshot();
  if (!snapshot.complete) throw new Error('Local capture state is unavailable. Restore it before continuing.');
  return snapshot.state.workspace_captures ?? {};
}
function readCapture(id: string, session: StoredAgentSessionState): StoredWorkspaceCapture {
  const capture = validId(id) ? captures()[id] : null;
  if (!capture || !sameWorker(capture, session)) throw new Error('This worker has no such capture. Call begin_workspace_capture before editing and retain its capture_id.');
  return capture;
}
function save(session: StoredAgentSessionState, update: (records: Record<string, StoredWorkspaceCapture>) => void) {
  updateLocalState(state => {
    const stored = state.agent_sessions?.[session.session_id];
    if (!stored || stored.ended_at || stored.session_token !== session.session_token) throw new Error('Worker connection changed. Reconnect explicitly before retrying.');
    state.workspace_captures ??= {};
    update(state.workspace_captures);
  });
}
async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (activeCalls.has(key)) throw new Error('This worker already has a capture operation in progress. Retry when it finishes.');
  activeCalls.add(key);
  try { return await operation(); } finally { activeCalls.delete(key); }
}
async function runCapture(operation: 'begin' | 'finish', capture: StoredWorkspaceCapture, text?: string): Promise<{ baseline?: string | null }> {
  if (captureWorkerActive) throw new Error('Another workspace is being captured. Retry shortly; the original baseline is preserved.');
  captureWorkerActive = true;
  let worker: Worker | undefined;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(new URL('../../../../shared/mcp-workspace-capture-worker.mjs', import.meta.url), {
        execArgv: [], workerData: { operation, capture, text, directory: operation === 'finish' ? preparationDirectory(capture) : null },
      });
      const timeout = setTimeout(() => { reject(new Error('Capture exceeded its time limit. Retry using the same capture_id.')); void worker?.terminate(); }, 120_000);
      worker.once('message', result => { clearTimeout(timeout); result.error ? reject(new Error(result.error)) : resolve(result); });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.once('exit', () => { clearTimeout(timeout); reject(new Error('Capture stopped before completion.')); });
    });
  } finally { await worker?.terminate(); captureWorkerActive = false; }
}

export async function beginWorkspaceCapture(input: { room_id: string; agent_session_id?: string; cwd?: string }) {
  const session = await identity(input.room_id, input.agent_session_id);
  return exclusive(`${getLocalStatePath()}:${session.agent_instance_id}:${session.room_id}`, async () => {
    const prior = Object.values(captures()).find(record => sameWorker(record, session) && !['published', 'blocked'].includes(record.phase));
    // Reject contention before recording a start that could never be captured.
    if (captureWorkerActive) throw new Error('Another workspace is being captured. Retry shortly before editing.');
    const cwd = await realpath(resolve(input.cwd || prior?.workspace || getRuntimeWorkingDirectory()));
    const git = async (args: string[]) => (await execute('git', ['--no-optional-locks', ...args], {
      cwd, timeout: 5_000, maxBuffer: 16 * 1024,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    })).stdout.trim();
    const workspace = await realpath(await git(['rev-parse', '--show-toplevel']));
    if (prior) {
      if (prior.workspace !== workspace) throw new Error('This worker has an unfinished capture in another repository. Publish it before beginning a different workspace.');
      return { capture_id: prior.capture_id, workspace: prior.workspace, baseline_available: Boolean(prior.baseline),
        instruction: 'Continue this capture. Keep its capture_id and call publish_workspace_capture when finished.',
        ...(prior.baseline ? {} : { warning: 'The starting snapshot is unavailable. Exact changes for this piece of work cannot be attributed.' }) };
    }
    const baseRevision = await git(['rev-parse', '--verify', 'HEAD']);
    const capture: StoredWorkspaceCapture = { capture_id: randomUUID(), api_url: getApiUrl(), room_id: session.room_id,
      agent_key: session.agent_key, agent_instance_id: session.agent_instance_id!, workspace, base_revision: baseRevision,
      baseline: null, phase: 'starting', next_page: 0 };
    const obsolete = Object.values(captures()).filter(record => sameWorker(record, session));
    save(session, records => {
      if (Object.values(records).some(record => sameWorker(record, session) && !['published', 'blocked'].includes(record.phase))) {
        throw new Error('This worker already began a capture. Retry begin to retrieve it.');
      }
      for (const [id, record] of Object.entries(records)) if (sameWorker(record, session)) delete records[id];
      records[capture.capture_id] = capture;
    });
    for (const record of obsolete) await rm(directory(record.capture_id), { recursive: true, force: true });
    try {
      const result = await runCapture('begin', capture);
      capture.baseline = result.baseline ?? null;
    } finally {
      // A failed/interrupted start is never silently recaptured after editing.
      capture.phase = 'ready';
      try { save(session, records => { records[capture.capture_id] = capture; }); }
      catch (error) { await releaseWorkspaceTree(capture.workspace, `mcp-workspace:${capture.capture_id}`); throw error; }
    }
    return { capture_id: capture.capture_id, workspace, baseline_available: Boolean(capture.baseline),
      ...(capture.baseline ? {} : { warning: 'A complete starting snapshot could not be captured. Exact changes for this piece of work will be unavailable.' }),
      instruction: 'Make your changes, then call publish_workspace_capture with this capture_id and a short summary. It posts the summary to the room; do not send a duplicate summary message.' };
  });
}

type PreparedCapture = { summary: NonNullable<ReturnType<typeof parseRoomAgentWorkSummary>>; text: string; warning: string | null;
  archive: { digest: string; length: number; total: number } | null };
async function preparedCapture(capture: StoredWorkspaceCapture): Promise<PreparedCapture | null> {
  if (!capture.preparation_id) return null;
  let raw: string;
  raw = await readFile(join(preparationDirectory(capture), 'prepared.json'), 'utf8');
  const value = JSON.parse(raw) as PreparedCapture;
  const summary = parseRoomAgentWorkSummary(value.summary);
  if (!summary || summary.version !== 3 || typeof value.text !== 'string' || value.text.length > 400
    || (value.archive && (!/^[a-f0-9]{64}$/.test(value.archive.digest) || !Number.isSafeInteger(value.archive.length)
      || value.archive.length < 1 || value.archive.length > REVIEW_LIMIT || value.archive.total !== Math.ceil(value.archive.length / REVIEW_PAGE_SIZE)))) {
    throw new Error('Saved capture is invalid. It cannot be published.');
  }
  return { ...value, summary };
}

export async function publishWorkspaceCapture(input: { room_id: string; agent_session_id?: string; capture_id: string; summary: string }) {
  const session = await identity(input.room_id, input.agent_session_id);
  return exclusive(`${getLocalStatePath()}:${session.agent_instance_id}:${session.room_id}`, async () => {
    let capture = readCapture(input.capture_id, session);
    if (capture.phase === 'blocked') throw new Error('This capture was deleted or cleared. It will not be republished. Begin a new capture for new work.');
    if (capture.phase === 'published') return { status: 'published', capture_id: capture.capture_id, source_message_id: capture.source_message_id, attempt_id: capture.attempt_id };
    let prepared = await preparedCapture(capture);
    if (!prepared) {
      const text = input.summary.trim();
      if (!text || text.length > 400) throw new Error('Supply a short summary of at most 400 characters.');
      const candidate = { ...capture, preparation_id: randomUUID() };
      try {
        await runCapture('finish', candidate, text);
        await preparedCapture(candidate);
        // Commit one immutable preparation under the same lock that fences
        // reconnects. Stale processes only write their own disposable directory.
        save(session, records => {
          const current = records[capture.capture_id];
          if (!current || !sameWorker(current, session) || ['published', 'blocked'].includes(current.phase)) throw new Error('Capture is no longer pending.');
          capture = current.preparation_id ? current : { ...current, preparation_id: candidate.preparation_id };
          records[capture.capture_id] = capture;
        });
      } finally {
        if (capture.preparation_id !== candidate.preparation_id) await rm(preparationDirectory(candidate), { recursive: true, force: true });
      }
      prepared = await preparedCapture(capture);
      if (!prepared) throw new Error('Capture did not finish. Retry with the same capture_id.');
    }
    await releaseWorkspaceTree(capture.workspace, `mcp-workspace:${capture.capture_id}`);
    const payload = prepared;
    const credentials = agentSessionCredentials(session);
    const request = <T>(path: string, body: unknown) => {
      assertWorkerConnection(session);
      return apiCall<T>(`/rooms/${encodeRoomIdPath(session.room_id)}/${path}`, {
        method: 'POST', signal: AbortSignal.timeout(30_000), body: JSON.stringify({ ...body as object, ...credentials }),
      });
    };
    const persist = () => save(session, records => { records[capture.capture_id] = capture; });
    try {
      if (!capture.source_message_id) {
        const message = await request<{ id: string }>('messages', { sender: session.actor_label, text: payload.text,
          client_message_id: `mcp-workspace:${capture.capture_id}` });
        if (!/^msg_[1-9]\d{0,9}$/.test(message?.id)) throw new Error('The server did not confirm the summary message. Retry this capture.');
        capture = { ...capture, source_message_id: message.id, phase: 'publishing' }; persist();
      }
      const total = payload.archive?.total ?? 1;
      const review = payload.archive ? await open(join(preparationDirectory(capture), 'review'), 'r') : null;
      try {
        // At most 1 MiB per tool call; large uploads resume from the saved page.
        // Each request carries the same immutable summary and 64 KiB archive page.
        const end = Math.min(total, capture.next_page + 16);
        for (let index = capture.next_page; index < end; index++) {
          let page;
          if (review && payload.archive) {
            const length = Math.min(REVIEW_PAGE_SIZE, payload.archive.length - index * REVIEW_PAGE_SIZE);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await review.read(buffer, 0, length, index * REVIEW_PAGE_SIZE);
            if (bytesRead !== length) throw new Error('Saved review is incomplete. It cannot be published.');
            page = { digest: payload.archive.digest, index, total, data: buffer.toString('ascii') };
          }
          const result = await request<{ work: { attempt_id: string; agent_key: string; room_id: string; source_message_id: string } }>('agent-work', {
            source_message_id: capture.source_message_id, summary: payload.summary, ...(page ? { review_page: page } : {}),
          });
          if (!validId(result.work?.attempt_id) || result.work.agent_key !== session.agent_key || result.work.room_id !== session.room_id
            || result.work.source_message_id !== capture.source_message_id) throw new Error('The server returned a different capture.');
          capture = { ...capture, attempt_id: result.work.attempt_id, next_page: index + 1 }; persist();
        }
      } finally { await review?.close(); }
      if (capture.next_page === total) {
        capture = { ...capture, phase: 'published' }; persist();
        await rm(directory(capture.capture_id), { recursive: true, force: true });
      }
      return { status: capture.phase === 'published' ? 'published' : 'uploading', capture_id: capture.capture_id,
        source_message_id: capture.source_message_id, attempt_id: capture.attempt_id,
        baseline_available: Boolean(capture.baseline), ...(payload.warning ? { warning: payload.warning } : {}),
        ...(capture.phase === 'published' ? { instruction: 'The summary and captured review are shared in the room. Do not send a duplicate summary.' }
          : { instruction: 'Call publish_workspace_capture again with the same capture_id to finish sharing the captured review. Saved bytes and summary will be reused.' }) };
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        capture = { ...capture, phase: 'blocked' }; persist();
        await rm(directory(capture.capture_id), { recursive: true, force: true });
      }
      throw error;
    }
  });
}
