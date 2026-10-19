import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-codex-start-prompt-", paths: [] });

const {
  DEFAULT_CODEX_STOP_PHRASE,
  buildCodexStartPrompt,
  buildCustodialPollingPrompt,
  looksLikeInviteCode,
  makeCodexStopToken,
} = await import("../main/agents/codex-start-prompt.js");

test("Codex start prompts give a polling worker its join, codename and registration steps", () => {
  const pollingPrompt = buildCodexStartPrompt({
    roomIdentifier: "github.com/example/repo",
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: null,
    maxMinutes: 0,
  });

  assert.match(pollingPrompt, /Keep polling with wait_for_messages/);
  assert.match(pollingPrompt, /set_agent_name/);
  assert.match(pollingPrompt, /post_reasoning/);
  assert.match(pollingPrompt, /readable progress for the desktop UI/);
  assert.match(pollingPrompt, /Suggested codename: MapleRidge/);
  assert.match(pollingPrompt, /runtime="codex:LOCAL_CODEX_ROOM_test"/);
  assert.match(pollingPrompt, /cwd="\/tmp\/repo"/, "fresh supervised registration carries the exact worktree into the MCP bind path");
  assert.match(pollingPrompt, /MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor/);
  assert.match(pollingPrompt, /Treat this as your room identity/);
  assert.match(pollingPrompt, /Call set_agent_name with that chosen codename before posting status or registering/);
  assert.match(pollingPrompt, /Never call yourself Codex, Codex 1, Codex 2, or any numbered provider label/);
  assert.match(pollingPrompt, /Do not continue into the room loop until register_agent_session succeeds/);
  assert.match(pollingPrompt, /Call read_messages once, then call get_board once/);
  assert.doesNotMatch(pollingPrompt, /claim it with claim_task/, "a fresh polling worker is never told to pick up unassigned work");
  assert.doesNotMatch(pollingPrompt, /accepted unassigned work/);
  assert.match(pollingPrompt, /get_onboarding_status/);
  assert.match(pollingPrompt, /advance the cursor for every observed message/);
  assert.match(pollingPrompt, /direct @mention of your exact ID\/name/);
  assert.match(pollingPrompt, /literal @everyone broadcast/);
  assert.match(pollingPrompt, /unassigned task updates/);
  assert.match(pollingPrompt, /Never react to your own output/);
  assert.match(pollingPrompt, /Stop immediately if a browser\/user room message text exactly equals: \/stop-codex-room/);
  assert.match(pollingPrompt, /reply in this thread with exactly: LOCAL_CODEX_ROOM_test_DONE/);
  assert.match(pollingPrompt, /There is no hard deadline/);
});

test("a non-Codex polling start prompt never asks a fresh worker to claim unassigned work", () => {
  const prompt = buildCodexStartPrompt({
    roomIdentifier: "github.com/example/repo",
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: null,
    maxMinutes: 0,
    providerLabel: "Cursor",
    runtimeKey: "cursor",
  });

  assert.match(prompt, /do not claim unassigned tasks on your own/);
  assert.doesNotMatch(prompt, /claim it with claim_task/);
  assert.doesNotMatch(prompt, /accepted unassigned work/);
});

test("Codex start prompts join a room by invite code when the room was opened with one", () => {
  const prompt = buildCodexStartPrompt({
    roomIdentifier: "ABCX-7291",
    joinedVia: "join_code",
    cwd: "/tmp/repo",
    stopPhrase: DEFAULT_CODEX_STOP_PHRASE,
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: "2026-06-14T13:00:00.000Z",
    maxMinutes: 60,
  });

  assert.match(prompt, /join_code with \{"code":"ABCX-7291","session_mode":"current"\}/);
  assert.doesNotMatch(prompt, /join_room with/);
  assert.match(prompt, /Hard stop deadline: 2026-06-14T13:00:00\.000Z/);
});

test("Codex start prompts JSON-escape unusual room names", () => {
  const prompt = buildCodexStartPrompt({
    roomIdentifier: 'github.com/example/repo "staging"',
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: null,
    maxMinutes: 0,
  });

  assert.match(
    prompt,
    /join_room with \{"name":"github\.com\/example\/repo \\"staging\\"","session_mode":"current"\}/,
  );
});

test("supervised resume prompt reuses the exact worker and cursor without replaying registration", () => {
  const prompt = buildCodexStartPrompt({
    roomIdentifier: "focus_37",
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: null,
    maxMinutes: 0,
    resumeWorker: { agentSessionId: "agent_session_exact", roomCursor: "msg_2819" },
  });

  assert.match(prompt, /agent_session_exact/);
  assert.match(prompt, /msg_2819/);
  assert.match(prompt, /exact supervised room is "focus_37"/);
  assert.match(prompt, /Do not call resume_room_session/);
  assert.match(prompt, /Do not call register_agent_session/);
  assert.doesNotMatch(prompt, /Suggested codename|Call set_agent_name|Call read_messages once/);
  assert.doesNotMatch(prompt, /join_room with|join_code with/);
});

test("custodial polling prompt pins the exact room, session and acknowledged cursor", () => {
  const prompt = buildCustodialPollingPrompt({
    roomId: "focus_37",
    cwd: "/tmp/repo",
    agentDisplayName: "MapleRidge",
    workerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_2819" },
  });

  assert.match(prompt, /Exact room_id: "focus_37"/);
  assert.match(prompt, /Exact agent_session_id: "agent_session_exact"/);
  assert.match(prompt, /First wait_for_messages after_message_id: "msg_2819"/);
  assert.match(prompt, /Existing display name: "MapleRidge"/);
  assert.match(prompt, /Do not join rooms, register or replace a session/);
  assert.match(prompt, /Do not use resume_room_session/);
  assert.match(prompt, /The supervisor owns explicit Stop controls/);
});

test("Codex stop tokens are unique per start and carry the room marker prefix", () => {
  const first = makeCodexStopToken();
  const second = makeCodexStopToken();

  assert.match(first, /^LOCAL_CODEX_ROOM_[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test("invite codes are recognized only in their grouped form", () => {
  assert.equal(looksLikeInviteCode("ABCX-7291"), true);
  assert.equal(looksLikeInviteCode("  abcx-7291  "), true);
  assert.equal(looksLikeInviteCode("ABCX-7291-QRST"), true);
  assert.equal(looksLikeInviteCode("github.com/example/repo"), false);
  assert.equal(looksLikeInviteCode("focus_37"), false);
  assert.equal(looksLikeInviteCode("ABCX"), false);
});
