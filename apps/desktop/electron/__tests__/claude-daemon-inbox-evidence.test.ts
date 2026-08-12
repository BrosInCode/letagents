import assert from "node:assert/strict";
import test from "node:test";

import {
  exactClaudeCommandLifecycleState,
  exactClaudeStreamTerminal,
  recoverExactClaudeTurnFromSession,
  type ClaudeEvidenceRecord,
} from "../main/agents/claude-room-turn-evidence.js";

const sessionId = "5cf962f0-f6b6-4eca-b0d7-348ae59bfeb8";
const turnId = "e7757cc3-966d-4535-86eb-d07f33aa647a";

test("Claude stream evidence correlates lifecycle and terminal result to the caller-supplied turn UUID", () => {
  assert.equal(exactClaudeCommandLifecycleState({
    type: "command_lifecycle",
    command_uuid: turnId,
    state: "completed",
    session_id: sessionId,
  }, turnId, sessionId), "completed");
  assert.equal(exactClaudeCommandLifecycleState({
    type: "command_lifecycle",
    command_uuid: "other-turn",
    state: "completed",
    session_id: sessionId,
  }, turnId, sessionId), null);

  assert.deepEqual(exactClaudeStreamTerminal({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "one exact reply",
    user_message_uuid: turnId,
    session_id: sessionId,
  }, turnId, sessionId), {
    turnId,
    outcome: "reply",
    text: "one exact reply",
    evidence: "stream",
  });
  assert.equal(exactClaudeStreamTerminal({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "wrong turn",
    user_message_uuid: "other-turn",
    session_id: sessionId,
  }, turnId, sessionId), null);
});

test("Claude session recovery requires the exact user UUID and a terminal assistant boundary", () => {
  const rows: ClaudeEvidenceRecord[] = [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "bounded" }] } },
    { type: "assistant", uuid: "thinking", parentUuid: turnId, sessionId, message: { id: "message-1", role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }] } },
    { type: "assistant", uuid: "answer", parentUuid: "thinking", sessionId, message: { id: "message-1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "recovered reply" }] } },
    { type: "user", uuid: "later-turn", sessionId, message: { role: "user", content: [{ type: "text", text: "later" }] } },
    { type: "assistant", uuid: "later-answer", parentUuid: "later-turn", sessionId, message: { id: "message-2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "must not leak" }] } },
  ];
  assert.deepEqual(recoverExactClaudeTurnFromSession(rows, turnId, sessionId), {
    turnId,
    outcome: "reply",
    text: "recovered reply",
    evidence: "transcript",
  });
  assert.deepEqual(recoverExactClaudeTurnFromSession(rows.slice(0, 2), turnId, sessionId), {
    turnId,
    outcome: "unreadable",
    text: null,
    evidence: "none",
  });
  assert.equal(recoverExactClaudeTurnFromSession([
    rows[0],
    { ...rows[1], message: { id: "message-1", role: "assistant", stop_reason: null, content: [{ type: "thinking", thinking: "private" }] } },
  ], turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFromSession(rows, "missing-turn", sessionId), null);
});

test("Claude session recovery keeps tool-result rows inside the turn and returns only final text", () => {
  const rows: ClaudeEvidenceRecord[] = [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "inspect the room" }] } },
    {
      type: "assistant",
      uuid: "tool-call",
      parentUuid: turnId,
      sessionId,
      message: {
        id: "message-tool",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tool-1", name: "read_messages", input: {} },
        ],
      },
    },
    {
      type: "user",
      uuid: "tool-result",
      parentUuid: "tool-call",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "room result" }],
      },
    },
    {
      type: "assistant",
      uuid: "final-answer",
      parentUuid: "tool-result",
      sessionId,
      message: {
        id: "message-final",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Final room answer." }],
      },
    },
    { type: "user", uuid: "later-turn", sessionId, message: { role: "user", content: [{ type: "text", text: "later" }] } },
  ];

  assert.deepEqual(recoverExactClaudeTurnFromSession(rows, turnId, sessionId), {
    turnId,
    outcome: "reply",
    text: "Final room answer.",
    evidence: "transcript",
  });
  assert.equal(recoverExactClaudeTurnFromSession(rows.slice(0, 3), turnId, sessionId), null);
});

test("Claude recovery treats only the exact no-reply sentinel as no reply", () => {
  const rows = (text: string): ClaudeEvidenceRecord[] => [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "bounded" }] } },
    { type: "assistant", uuid: "answer", parentUuid: turnId, sessionId, message: { id: "message-1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
  ];
  assert.deepEqual(recoverExactClaudeTurnFromSession(
    rows("LETAGENTS_NO_ROOM_REPLY"),
    turnId,
    sessionId,
  ), {
    turnId,
    outcome: "no_reply",
    text: null,
    evidence: "transcript",
  });
  assert.deepEqual(recoverExactClaudeTurnFromSession(
    rows("LETAGENTS_NO_ROOM_REPLY\nextra"),
    turnId,
    sessionId,
  ), {
    turnId,
    outcome: "reply",
    text: "LETAGENTS_NO_ROOM_REPLY\nextra",
    evidence: "transcript",
  });
});
