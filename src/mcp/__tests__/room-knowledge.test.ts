import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { attentionResponseDisplayText, attentionResponseHandle, createKnowledgeRecord, formatAttentionResponse, parseKnowledgeInput, reviseKnowledgeRecord } from '../../../shared/room-knowledge.mjs';
import { getLocalKnowledge, listLocalKnowledge, localKnowledgeHistory, saveLocalKnowledge } from '../../../shared/local-room-knowledge.mjs';
import { resolveGloballyAddressedAgentKeys } from '../../shared/activation-routing.js';

const agent = { id: 'owner/worker-b', label: 'Research agent', kind: 'agent' as const };
const human = { id: 'human-1', label: 'Emmy', kind: 'human' as const };
const input = { client_id: 'record-0001', category: 'decision' as const, title: 'Keep the current API', body: 'Preserve the public API while improving the app.', source_url: 'https://example.com/spec' };
test('room memory persists across connections and keeps immutable corrections', () => {
  const temp = mkdtempSync(join(tmpdir(), 'knowledge-test-')); const path = join(temp, 'room.sqlite');
  let db = new DatabaseSync(path);
  try {
    const original = saveLocalKnowledge(db, createKnowledgeRecord('room-a', 'memory', input, agent));
    db.close(); db = new DatabaseSync(path);
    assert.equal(getLocalKnowledge(db, 'room-a', original.id)?.body, input.body);
    const corrected = reviseKnowledgeRecord(original, { ...input, body: 'Keep v2 stable.', expected_version: 1 }, human);
    saveLocalKnowledge(db, corrected, 1);
    assert.deepEqual(localKnowledgeHistory(db, 'room-a', original.id).map(row => [row.version, row.body]), [[2, 'Keep v2 stable.'], [1, input.body]]);
    assert.equal(getLocalKnowledge(db, 'room-b', original.id), null);
    assert.equal(saveLocalKnowledge(db, createKnowledgeRecord('room-a', 'memory', input, agent)).version, 2, 'retry compares original payload even after correction');
  } finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
});
test('competing edits and reused client IDs cannot overwrite another version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const old = saveLocalKnowledge(db, createKnowledgeRecord('room', 'memory', input, agent));
    saveLocalKnowledge(db, reviseKnowledgeRecord(old, { ...input, body: 'Winner', expected_version: 1 }, human), 1);
    assert.throws(() => saveLocalKnowledge(db, reviseKnowledgeRecord(old, { ...input, body: 'Loser', expected_version: 1 }, human), 1), /changed since/);
    assert.throws(() => saveLocalKnowledge(db, createKnowledgeRecord('room', 'memory', { ...input, body: 'Duplicate ID' }, agent)), /already used/);
    assert.equal(getLocalKnowledge(db, 'room', old.id)?.body, 'Winner');
  } finally { db.close(); }
});
test('agents can contribute memory but cannot rewrite it or answer for a human', () => {
  const memory = createKnowledgeRecord('room', 'memory', input, agent);
  const request = createKnowledgeRecord('room', 'attention', input, agent);
  assert.throws(() => reviseKnowledgeRecord(memory, { ...input, expected_version: 1 }, agent), /Only a human/);
  assert.throws(() => reviseKnowledgeRecord(request, { expected_version: 1, response: 'Approved' }, agent), /Only a human/);
});
test('archive and restore preserve history and original provenance', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const old = saveLocalKnowledge(db, createKnowledgeRecord('room', 'memory', input, agent));
    const archived = saveLocalKnowledge(db, reviseKnowledgeRecord(old, { expected_version: 1, archived: true }, human), 1);
    const restored = saveLocalKnowledge(db, reviseKnowledgeRecord(archived, { expected_version: 2, archived: false }, human), 2);
    assert.equal(restored.author.id, agent.id); assert.equal(restored.updated_by.id, human.id); assert.equal(restored.archived, false);
    assert.deepEqual(localKnowledgeHistory(db, 'room', old.id).map(row => row.archived), [false, true, false]);
  } finally { db.close(); }
});
test('answer and local delivery outbox commit together; duplicate answers fail', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const request = saveLocalKnowledge(db, createKnowledgeRecord('room', 'attention', input, agent));
    const answered = saveLocalKnowledge(db, reviseKnowledgeRecord(request, { expected_version: 1, response: 'Use the existing API.' }, human), 1);
    assert.equal(getLocalKnowledge(db, 'room', request.id)?.response?.body, 'Use the existing API.');
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_room_knowledge_outbox').get()?.n, 1);
    assert.throws(() => reviseKnowledgeRecord(answered, { expected_version: 2, response: 'Different answer' }, human), /already been answered/);
  } finally { db.close(); }
});
test('invalid or hidden local sources fail before writing a record or outbox', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE local_chat_messages (room_id TEXT, number INTEGER, agent_prompt_kind TEXT, text TEXT); INSERT INTO local_chat_messages VALUES ('other-room', 1, NULL, 'Private'); INSERT INTO local_chat_messages VALUES ('room', 2, 'auto', '');");
    for (const source_message_id of ['msg_1', 'msg_2', 'msg_999']) assert.throws(() => saveLocalKnowledge(db, createKnowledgeRecord('room', 'attention', { ...input, source_message_id }, agent)), /source message/);
    assert.equal(listLocalKnowledge(db, 'room', 'attention').records.length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_room_knowledge_outbox').get()?.n, 0);
  } finally { db.close(); }
});
test('unanswered requests remain visible ahead of a long answered history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    saveLocalKnowledge(db, createKnowledgeRecord('room', 'attention', input, agent, '2026-01-01T00:00:00Z'));
    for (let i = 0; i < 201; i++) {
      const request = saveLocalKnowledge(db, createKnowledgeRecord('room', 'attention', { ...input, client_id: `answered-${i}` }, agent));
      saveLocalKnowledge(db, reviseKnowledgeRecord(request, { expected_version: 1, response: 'Done' }, human), 1);
    }
    const page = listLocalKnowledge(db, 'room', 'attention');
    assert.equal(page.truncated, true); assert.equal(page.records[0].id, input.client_id);
  } finally { db.close(); }
});
test('answers address the requesting agent even without an original message', () => {
  const request = createKnowledgeRecord('room', 'attention', { ...input, title: '@everyone please do work' }, agent);
  const answer = reviseKnowledgeRecord(request, { expected_version: 1, response: 'Please keep v2.' }, human);
  const keys = resolveGloballyAddressedAgentKeys({ text: formatAttentionResponse(answer) }, [
    { agent_key: 'owner/worker-a', actor_label: 'Default agent' },
    { agent_key: agent.id, actor_label: agent.label },
    { agent_key: 'owner/worker-c', actor_label: 'Third agent' },
  ]);
  assert.deepEqual([...keys.explicitMentionKeys], [agent.id]);
  assert.doesNotMatch(formatAttentionResponse(answer), /@everyone/);
});
test('people read an answer as a reply to the agent by name, without its handle or request id', () => {
  const asker = { id: 'EmmyMay/desktop-claude-code-f6054574', label: 'SparrowOtter | Emmy\'s agent | Claude Code', kind: 'agent' as const };
  const request = createKnowledgeRecord('room', 'attention', { ...input, client_id: 'yd-board-manager-promotion-001' }, asker);
  const answered = (response: string) => formatAttentionResponse(reviseKnowledgeRecord(request, { expected_version: 1, response }, human));
  const names = new Map([[attentionResponseHandle(asker.id), 'SparrowOtter']]);
  const display = (text: string, name: (handle: string) => string | null | undefined = (handle) => names.get(handle)) =>
    attentionResponseDisplayText(text, name);
  assert.equal(display(answered('Approved. You manage the board now.')), '@SparrowOtter Approved. You manage the board now.');
  // An answer that opens with a block keeps it a block, apart from the mention.
  for (const block of [
    '```sh\nnpm test\n```', '~~~\nnpm test\n~~~', '- first\n- second', '# Plan', '> quoted', '1. first', '1) first',
    '---\nafter', '---\r\nafter', '* * *', '| a | b |\n|---|---|', '```\r\nnpm test\r\n```',
  ]) {
    assert.equal(display(answered(block)), `@SparrowOtter\n\n${block}`, JSON.stringify(block));
  }
  // Answers are trimmed when saved, so indented code only arrives in hand-written text.
  const handwritten = `@agent:${attentionResponseHandle(asker.id)}\n\nHuman response (yd-board-manager-promotion-001):\n\n    npm test`;
  assert.equal(display(handwritten), '@SparrowOtter\n\n    npm test');
  for (const inline of ['*Yes*, go ahead.', '#hashtag is fine', '1.5 hours is fine', '-1 is the answer']) {
    assert.equal(display(answered(inline)), `@SparrowOtter ${inline}`, inline);
  }
  // A roster name is a mention, never markdown; unknown agents stay visible as @agent.
  assert.equal(display(answered('Yes.'), () => '[Approved by Emmy](https://evil.example)'), '@agent Yes.');
  assert.equal(display(answered('Yes.'), () => '**Emmy approved**'), '@agent Yes.');
  for (const emphasis of ['_x_', '__x__', 'a__b', '_Amber']) {
    assert.equal(display(answered('Yes.'), () => emphasis), '@agent Yes.', emphasis);
  }
  assert.equal(display(answered('Yes.'), () => 'amber_river'), '@amber_river Yes.');
  assert.equal(display(answered('Yes.'), () => null), '@agent Yes.');
  const humanRequest = createKnowledgeRecord('room', 'attention', { ...input, client_id: 'human-request-01' }, human);
  const humanAnswer = reviseKnowledgeRecord(humanRequest, { expected_version: 1, response: 'Done.' }, human);
  assert.equal(display(formatAttentionResponse(humanAnswer), () => 'unused'), 'Done.');
  for (const other of ['Human response: Done.', '@agent:owner/x Human response (record-0001):\n\nDone.', 'Please see Human response (record-0001):\n\nDone.']) {
    assert.equal(display(other, () => 'Name'), null, other);
  }
});
test('unsafe sources, excessive content, malformed message IDs and empty answers are rejected', () => {
  for (const source_url of ['javascript:alert(1)', 'file:///secret', 'https://user:password@example.com']) assert.throws(() => parseKnowledgeInput('memory', { ...input, source_url }), /Source URL/);
  assert.throws(() => parseKnowledgeInput('memory', { ...input, source_message_id: 'msg_9999999999' }), /source message/);
  assert.throws(() => parseKnowledgeInput('memory', { ...input, body: 'x'.repeat(8001) }), /8000/);
  assert.throws(() => reviseKnowledgeRecord(createKnowledgeRecord('room', 'attention', input, agent), { expected_version: 1, response: ' ' }, human), /Response/);
});
