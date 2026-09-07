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
