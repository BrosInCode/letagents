import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({
  prefix: "letagents-room-agent-work-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"],
});

const { createLocalRoom } = await import("../main/rooms/local-store.js");
const {
  mapDesktopRoomAgentWorkPollPayload,
  pollDesktopRoomAgentWork,
} = await import("../main/rooms/agent-work.js");

const ROOM = "room_agent_work";
const CURSOR = `rw1.${"a".repeat(64)}.${"b".repeat(64)}`;
const ATTEMPT = "123e4567-e89b-42d3-a456-426614174000";
const POSTGRES_TIMESTAMP = "2026-08-31 21:12:41.717+01";

function summary() {
  return {
    version: 1,
    recorded_state: "completed",
    evidence_incomplete: false,
    elapsed_ms: 1_250,
    operation_counts: {
      unresolved: 0,
      succeeded: 2,
      failed: 0,
      denied_before_start: 0,
      cancelled_before_start: 0,
      interrupted_after_start: 0,
      lost_after_start: 0,
    },
  };
}

function changedPayload(roomId = ROOM): unknown {
  return {
    room_id: roomId,
    cursor: CURSOR,
    changed: true,
    snapshot: {
      work: [{
        attempt_id: ATTEMPT,
        room_id: roomId,
        source_message_id: "msg_7",
        agent_key: "emmy/garden-point",
        revision: 3,
        summary: summary(),
        updated_at: POSTGRES_TIMESTAMP,
      }],
      truncated: false,
    },
  };
}

test("strict mapper accepts changed and unchanged replacement envelopes", () => {
  const changed = mapDesktopRoomAgentWorkPollPayload(changedPayload(), ROOM);
  assert.ok(changed?.changed);
  assert.equal(changed.snapshot.work[0]?.attemptId, ATTEMPT);
  assert.equal(changed.snapshot.work[0]?.summary.version, 1);
  assert.equal(changed.snapshot.work[0]?.updatedAt, "2026-08-31T20:12:41.717Z");

  assert.deepEqual(
    mapDesktopRoomAgentWorkPollPayload({
      room_id: ROOM,
      cursor: CURSOR,
      changed: false,
      snapshot: null,
    }, ROOM),
    { roomId: ROOM, cursor: CURSOR, changed: false, snapshot: null },
  );
});

test("strict mapper rejects partial salvage, room drift, duplicate identity, and noncanonical values", () => {
  const malformed = changedPayload() as {
    snapshot: { work: Array<Record<string, unknown>> };
  };
  malformed.snapshot.work.push({ ...malformed.snapshot.work[0], attempt_id: "223e4567-e89b-42d3-a456-426614174000" });
  assert.equal(mapDesktopRoomAgentWorkPollPayload(malformed, ROOM), null);
  assert.equal(mapDesktopRoomAgentWorkPollPayload(changedPayload("room_other"), ROOM), null);
  assert.equal(mapDesktopRoomAgentWorkPollPayload({
    room_id: ROOM,
    cursor: CURSOR,
    changed: false,
    snapshot: { work: [], truncated: false },
  }, ROOM), null);

  const privateShape = changedPayload() as {
    snapshot: { work: Array<Record<string, unknown>> };
  };
  privateShape.snapshot.work[0].summary = { ...summary(), command: "npm test" };
  assert.equal(mapDesktopRoomAgentWorkPollPayload(privateShape, ROOM), null);
});

test("cloud poll uses the opaque cursor and maps access or payload invalidation explicitly", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  let response = new Response(JSON.stringify(changedPayload()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return response;
  }) as typeof fetch;
  try {
    const ready = await pollDesktopRoomAgentWork(ROOM, CURSOR);
    assert.equal(ready.status, "ready");
    assert.match(calls[0] || "", new RegExp(`/rooms/${ROOM}/agent-work/poll\\?after=${CURSOR}&timeout=0&include_workspace=1&include_contribution=1$`));

    response = new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    assert.deepEqual(await pollDesktopRoomAgentWork(ROOM), { status: "access_revoked", response: null });

    response = new Response(JSON.stringify({
      ...(changedPayload() as Record<string, unknown>),
      extra: true,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    assert.deepEqual(await pollDesktopRoomAgentWork(ROOM), { status: "invalid", response: null });
  } finally {
    globalThis.fetch = previous;
  }
});

test("local rooms and invalid cursors do not call the cloud", async () => {
  const room = await createLocalRoom({ displayName: "Local work" });
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("unexpected cloud call");
  }) as typeof fetch;
  try {
    assert.deepEqual(await pollDesktopRoomAgentWork(room.roomIdentifier), { status: "local", response: null });
    assert.deepEqual(await pollDesktopRoomAgentWork(ROOM, "wrong"), { status: "invalid", response: null });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test('file opening stays inside the recorded workspace and rejects executable or missing paths', async () => {
  const { mkdtemp, writeFile, symlink, rm, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { localWorkspaceFile, safeWorkspaceFilePath } = await import('../main/workspace-file-links.js');
  const root = await mkdtemp(join(tmpdir(), 'receipt-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'receipt-outside-'));
  try {
    await writeFile(join(root, 'hello.ts'), 'export const hello = true;');
    await writeFile(join(outside, 'private.ts'), 'private');
    await symlink(join(outside, 'private.ts'), join(root, 'escape.ts'));
    assert.ok(await localWorkspaceFile(root, 'hello.ts'));
    for (const path of ['../private.ts', '/etc/passwd', 'escape.ts', 'missing.ts', 'file.command']) assert.equal(await localWorkspaceFile(root, path), null);
    await chmod(join(root, 'hello.ts'), 0o755);
    assert.equal(await localWorkspaceFile(root, 'hello.ts'), null);
    for (const path of ['../file.ts', 'a/../file.ts', 'a\\file.ts', 'file.ts\u0000', '/file.ts']) assert.equal(safeWorkspaceFilePath(path), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('workspace links require an exact receipt and a verified published file; handlers must be editors', async () => {
  const { trustedEditor, editorSignatureRequirement, resolveWorkspaceFileLinks, githubFile } = await import('../main/workspace-file-links.js');
  assert.equal(trustedEditor({ id: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app' }), true);
  assert.match(editorSignatureRequirement('com.microsoft.VSCode')!, /certificate leaf\[subject.OU\] = "UBF8T346G9"/);
  assert.equal(editorSignatureRequirement('com.apple.Terminal'), null);
  assert.equal(trustedEditor({ id: 'com.apple.Terminal', path: '/Applications/Terminal.app' }), false);
  assert.equal(trustedEditor({ id: 'org.python.PythonLauncher', path: '/Applications/Python Launcher.app' }), false);
  assert.equal(trustedEditor({ id: 'com.microsoft.VSCode', path: '../Code.app' }), false);
  assert.equal(await githubFile('github.com/a/b', 'main', '../private.ts'), null);
  assert.equal(await githubFile('not-a-git-room', 'main', 'file.ts'), null);
  await assert.rejects(resolveWorkspaceFileLinks({ roomId: ROOM, agentKey: 'other/agent', sourceMessageId: 'invalid', paths: ['file.ts'] }), /Invalid/);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(changedPayload()), { status: 200 });
  try {
    assert.deepEqual(await resolveWorkspaceFileLinks({ roomId: ROOM, agentKey: 'other/agent', sourceMessageId: 'msg_123', paths: ['file.ts'] }), []);
  } finally { globalThis.fetch = priorFetch; }
});


test('on-demand full review reads every page and rejects mixed or damaged captures', async () => {
  const { loadWorkspaceReviewPages } = await import('../main/workspace-review.js');
  const { encodeWorkspaceReview, decodeWorkspaceReview, REVIEW_PAGE_SIZE } = await import('../../../../shared/workspace-review.mjs');
  const { randomBytes } = await import('node:crypto');
  const snapshot = { captured_at: '2026-09-08T00:00:00.000Z', branch: 'feature', base_revision: 'a'.repeat(40), state: 'ready' as const,
    files: [{ path: 'app.ts', previous_path: null, status: 'added' as const, additions: 1, deletions: 0, binary: false }],
    additions: 1, deletions: 0, hidden_files: 0, patch: randomBytes(180_000).toString('hex') + 'LAST LINE', patch_truncated: false };
  const expected = { version: 1 as const, workspace: snapshot, contribution: snapshot };
  const encoded = encodeWorkspaceReview(expected);
  const total = Math.ceil(encoded.data.length / REVIEW_PAGE_SIZE);
  const page = (index: number) => ({ status: 'ready', page: { index, total, digest: encoded.digest,
    data: encoded.data.slice(index * REVIEW_PAGE_SIZE, (index + 1) * REVIEW_PAGE_SIZE) } });
  assert.ok(total > 1);
  const load = async (fetchPage: (index: number) => Promise<unknown>) => {
    const pages: import('../../../../shared/workspace-review.mjs').WorkspaceReviewPage[] = [];
    const status = await loadWorkspaceReviewPages(fetchPage, async batch => { pages.push(...batch); }, new AbortController().signal);
    return status === 'ready' ? { status, review: decodeWorkspaceReview(pages.map(page => page.data).join(''), pages[0].digest) } : { status, review: null };
  };
  assert.deepEqual(await load(async index => page(index)), { status: 'ready', review: expected });
  assert.deepEqual(await load(async () => ({ status: 'pending', page: null })), { status: 'pending', review: null });
  assert.deepEqual(await load(async () => ({ status: 'unavailable', page: null })), { status: 'unavailable', review: null });
  await assert.rejects(load(async index => { const result = page(index); if (index === 1) result.page.digest = 'b'.repeat(64); return result; }), /Incomplete/);
  await assert.rejects(load(async index => { const result = page(index); if (index === total - 1) result.page.data = 'AAAA'; return result; }), /Incomplete/);
});


test('local review cache requires current access and the exact uncleared public receipt', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { encodeWorkspaceReview } = await import('../../../../shared/workspace-review.mjs');
  const { WorkspaceReviewSession } = await import('../main/workspace-review.js');
  const { apiUrl } = await import('../main/paths.js');
  const directory = mkdtempSync(join(tmpdir(), 'review-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'state.sqlite');
  const db = new DatabaseSync(databasePath);
  const snapshot = { captured_at: '2026-09-08T00:00:00.000Z', branch: 'feature', base_revision: 'a'.repeat(40), state: 'ready' as const,
    files: [], additions: 0, deletions: 0, hidden_files: 0, patch: 'LOCAL_CAPTURE', patch_truncated: false };
  const review = { version: 1 as const, workspace: snapshot, contribution: snapshot };
  const encoded = encodeWorkspaceReview(review);
  db.exec(`CREATE TABLE room_workspace_reviews(agent_id,room_id,source_message_id,data,digest);
    CREATE TABLE room_work_publications(agent_id,room_id,source_message_id,agent_key,api_origin,state);`);
  db.prepare('INSERT INTO room_workspace_reviews VALUES(?,?,?,?,?)').run('agent', ROOM, 'msg_1', encoded.data, encoded.digest);
  db.prepare('INSERT INTO room_work_publications VALUES(?,?,?,?,?,?)').run('agent', ROOM, 'msg_1', 'owner/agent', apiUrl, 'open'); db.close();
  const input = { roomId: ROOM, agentKey: 'owner/agent', sourceMessageId: 'msg_1', attemptId: ATTEMPT, requestId: ATTEMPT };
  const current = { attempt_id: ATTEMPT, room_id: ROOM, agent_key: 'owner/agent', source_message_id: 'msg_1',
    summary: { ...summary(), version: 3, workspace: snapshot, contribution: { changes: snapshot, summary: null } } };
  const fetch = async <T>() => current as T;
  const session = new WorkspaceReviewSession(input, { databasePath, fetch });
  t.after(() => session.close());
  assert.deepEqual(await session.open(), { status: 'ready', review: { ...review, workspace: { ...snapshot, patch: '' }, contribution: { ...snapshot, patch: '' } } });
  await assert.rejects(new WorkspaceReviewSession(input, { databasePath, fetch: async () => { throw new Error('Access revoked'); } }).open(), /Access revoked/);
  await assert.rejects(new WorkspaceReviewSession({ ...input, attemptId: '223e4567-e89b-42d3-a456-426614174000' }, { databasePath, fetch }).open(), /no longer available/);
  await assert.rejects(new WorkspaceReviewSession(input, { databasePath, fetch: async <T>() => ({ ...current, summary: { version: 1, availability: 'cleared' } }) as T }).open(), /no longer available/);
});


test('review downloads have bounded concurrency and stop after cancellation', async () => {
  const { loadWorkspaceReviewPages } = await import('../main/workspace-review.js');
  const controller = new AbortController();
  let active = 0, maxActive = 0, requests = 0, appended = 0;
  await assert.rejects(loadWorkspaceReviewPages(async index => {
    requests++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { status: 'ready', page: { digest: 'a'.repeat(64), index, total: 100, data: 'a'.repeat(65536) } };
  }, async pages => { appended += pages.length; if (appended >= 5) controller.abort(); }, controller.signal), /abort/i);
  assert.equal(maxActive, 4); assert.equal(requests, 5); assert.equal(appended, 5);
});

test('background review returns bounded pages, rechecks access, and cancels pending work', async t => {
  const { WorkspaceReviewSession } = await import('../main/workspace-review.js');
  const { encodeWorkspaceReview, REVIEW_PAGE_SIZE } = await import('../../../../shared/workspace-review.mjs');
  const patch = 'diff --git a/app.ts b/app.ts\n--- /dev/null\n+++ b/app.ts\n@@ -0,0 +1,700 @@\n' + '+line\n'.repeat(699) + '+' + 'x'.repeat(8 * 1024 * 1024) + 'FINAL\n';
  const snapshot = { captured_at: '2026-09-08T00:00:00.000Z', branch: 'feature', base_revision: 'a'.repeat(40), state: 'ready' as const,
    files: [{ path: 'app.ts', previous_path: null, status: 'added' as const, additions: 700, deletions: 0, binary: false }],
    additions: 700, deletions: 0, hidden_files: 0, patch, patch_truncated: false };
  const encoded = encodeWorkspaceReview({ version: 1, workspace: snapshot, contribution: snapshot });
  const preview = { ...snapshot, patch: patch.slice(0, 48000), patch_truncated: true };
  const current = { attempt_id: ATTEMPT, room_id: ROOM, agent_key: 'owner/agent', source_message_id: 'msg_1',
    summary: { ...summary(), version: 3, workspace: preview, contribution: { changes: preview, summary: null } } };
  const input = { roomId: ROOM, agentKey: 'owner/agent', sourceMessageId: 'msg_1', attemptId: ATTEMPT, requestId: ATTEMPT };
  const { DesktopApiError } = await import('../main/auth.js');
  let revoked = false, transientFailure = false;
  const fetch = async <T>(path: string): Promise<T> => {
    if (revoked) throw new DesktopApiError(403, { message: 'Access revoked' });
    if (transientFailure) throw new DesktopApiError(503, { message: 'Temporarily unavailable' });
    const match = /review_page=(\d+)/.exec(path);
    if (!match) return current as T;
    const index = Number(match[1]);
    return { status: 'ready', page: { index, total: Math.ceil(encoded.data.length / REVIEW_PAGE_SIZE), digest: encoded.digest, data: encoded.data.slice(index * REVIEW_PAGE_SIZE, (index + 1) * REVIEW_PAGE_SIZE) } } as T;
  };
  const session = new WorkspaceReviewSession(input, { fetch, databasePath: '/nonexistent-review-test.sqlite' });
  t.after(() => session.close());
  const opened = await session.open(); assert.equal(opened.status, 'ready');
  assert.ok(JSON.stringify(opened).length < 2048, 'opening a review must not transfer captured patch text');
  const page = await session.page({ requestId: ATTEMPT, view: 'contribution', path: 'app.ts' });
  assert.equal(page.lines.length, 500); assert.equal(page.nextOffset, 500);
  const longLine = await session.page({ requestId: ATTEMPT, view: 'contribution', path: 'app.ts', offset: 700, singleLine: true });
  assert.equal(longLine.lines[0].text.length, 4096); assert.equal(longLine.lines[0].textLength, 8 * 1024 * 1024 + 5);
  const lastPart = await session.page({ requestId: ATTEMPT, view: 'contribution', path: 'app.ts', offset: 700, singleLine: true, textOffset: 8 * 1024 * 1024 });
  assert.equal(lastPart.lines[0].text, 'FINAL'); assert.equal(lastPart.lines[0].nextTextOffset, null);
  transientFailure = true;
  await assert.rejects(session.page({ requestId: ATTEMPT, view: 'workspace', path: 'app.ts' }), /Temporarily unavailable/);
  transientFailure = false;
  assert.equal((await session.page({ requestId: ATTEMPT, view: 'workspace', path: 'app.ts' })).lines.length, 500);
  revoked = true;
  await assert.rejects(session.page({ requestId: ATTEMPT, view: 'workspace', path: 'app.ts' }), /Access revoked/);
  await assert.rejects(session.page({ requestId: ATTEMPT, view: 'workspace', path: 'app.ts' }), /not open/);

  let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  const interrupted = new WorkspaceReviewSession(input, { fetch: async <T>(_: string, init?: RequestInit) => {
    started(); return new Promise<T>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const pending = interrupted.open(); const rejected = assert.rejects(pending, /aborted/);
  await waiting; await interrupted.close(); await rejected;
});


test('explicit close then immediate reopen waits for the previous review worker to retire', async t => {
  const { WorkspaceReviewSession, readWorkspaceReview, closeWorkspaceReview } = await import('../main/workspace-review.js');
  const owner = -901;
  const input = { roomId: ROOM, agentKey: 'owner/agent', sourceMessageId: 'msg_1', attemptId: ATTEMPT, requestId: ATTEMPT };
  const second = { ...input, requestId: '223e4567-e89b-42d3-a456-426614174000' };
  let release!: () => void;
  const retired = new Promise<void>(resolve => { release = resolve; });
  const opened: string[] = [];
  t.mock.method(WorkspaceReviewSession.prototype, 'open', async function(this: InstanceType<typeof WorkspaceReviewSession>) {
    opened.push(this.input.requestId); return { status: 'unavailable', review: null };
  });
  t.mock.method(WorkspaceReviewSession.prototype, 'close', function(this: InstanceType<typeof WorkspaceReviewSession>) {
    return this.input.requestId === input.requestId ? retired : Promise.resolve();
  });
  await readWorkspaceReview(owner, input);
  const closing = closeWorkspaceReview(owner, input.requestId);
  const reopening = readWorkspaceReview(owner, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [input.requestId]);
  release(); await Promise.all([closing, reopening]);
  assert.deepEqual(opened, [input.requestId, second.requestId]);
  await closeWorkspaceReview(owner, second.requestId);
});
