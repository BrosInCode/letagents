import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { Express } from 'express';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import('../db/client.js') : null;
const api = url ? await import('../db.js') : null;
const history = await import('../rooms/activity-history.js');
const state = await import('../rooms/activity-state.js');
const helpers = url ? await import('../routes/rooms/presence/helpers.js') : null;
const routes = url ? await import('../routes/rooms/presence/read-routes.js') : null;
const skip = { skip: !url && 'set TEST_DB_URL to run activity history DB tests' };
const roomId = 'history-read-perf';
let project: NonNullable<Awaited<ReturnType<NonNullable<typeof api>['getProjectById']>>>;
let handler: (req: unknown, res: unknown) => Promise<void>;

test.before(async () => {
  if (!client || !api || !routes) return;
  await client.pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public');
  await migrate(client.db, { migrationsFolder: path.resolve('drizzle') });
  await client.pool.query(`
    INSERT INTO rooms (id, display_name, created_at) VALUES ('${roomId}', 'History', '2026-01-01');
    INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
      VALUES ('history-owner','github','history-owner','Owner','2026-01-01','2026-01-01');
    INSERT INTO room_participants (room_id, participant_key, kind, actor_label, agent_key, github_login, display_name, hidden_at, hidden_by, last_seen_at, created_at, updated_at)
      SELECT '${roomId}', CASE WHEN i <= 40 THEN 'agent:Agent ' ELSE 'human:Human ' END || i,
        CASE WHEN i <= 40 THEN 'agent' ELSE 'human' END::room_participant_kind,
        CASE WHEN i <= 40 THEN 'Agent ' || i END,
        CASE WHEN i <= 40 THEN 'owner/agent-' || i END,
        CASE WHEN i > 40 THEN 'Human ' || i END,
        CASE WHEN i <= 40 THEN 'Agent ' ELSE 'Human ' END || i,
        CASE WHEN i % 11 = 0 THEN '2026-01-02'::timestamptz END,
        CASE WHEN i % 11 = 0 THEN 'Owner' END,
        '2026-01-01'::timestamptz + i * interval '1 minute', '2026-01-01', '2026-01-01'
      FROM generate_series(1,60) i;
    INSERT INTO tasks (room_id, number, title, description, status, assignee, assignee_agent_key, created_by, pr_url, workflow_artifacts, created_at, updated_at)
      SELECT '${roomId}', i, CASE WHEN i = 1 THEN 'old searchable needle' ELSE 'Task ' || i END,
        repeat('unused description ', 200),
        (ARRAY['proposed','accepted','assigned','in_progress','blocked','in_review','merged','done','cancelled'])[1 + i % 9]::task_status,
        CASE WHEN i % 60 < 40 THEN 'Agent ' || (1+i%60) ELSE 'Human ' || (1+i%60) END,
        CASE WHEN i % 3 = 0 AND i%60 < 40 THEN 'owner/agent-' || (1+i%60) END,
        CASE WHEN i % 60 < 40 THEN 'Agent ' || (1+i%60) ELSE 'Human ' || (1+i%60) END,
        CASE WHEN i % 10 = 0 THEN 'https://github.com/example/repo/pull/' || i END,
        '[]'::jsonb, '2026-01-01', '2026-01-01'::timestamptz + i * interval '1 second'
      FROM generate_series(1,5000) i;
    INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key, agent_instance_id, display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at, ended_at)
      SELECT 'history-session-' || i, '${roomId}', 'history-token-' || i, 'worker', 'codex', 'Agent ' || (1+i%40),
        'owner/agent-' || (1+i%40), 'instance-' || (1+i%40), 'Agent ' || (1+i%40), 'history-owner', 'Owner', 'Codex',
        '2026-01-01', '2026-01-01'::timestamptz + i * interval '1 second', '2026-01-01', '2026-01-02'
      FROM generate_series(1,2000) i;
    INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, agent_session_id, session_kind, actor_label, agent_key, agent_instance_id, display_name, repo_branch, transport, last_connected_at, last_disconnected_at, created_at, updated_at)
      SELECT '${roomId}', 'agent_session:history-session-' || i, 'history-session-' || i, 'worker', 'Agent ' || (1+i%40),
        'owner/agent-' || (1+i%40), 'instance-' || (1+i%40), 'Agent ' || (1+i%40), 'branch-' || (1+i%40), 'sse',
        '2026-01-01', '2026-01-01'::timestamptz + i * interval '1 second', '2026-01-01', '2026-01-01'::timestamptz + i * interval '1 second'
      FROM generate_series(1,2000) i;
  `);
  project = (await api.getProjectById(roomId))!;
  routes.registerPresenceReadRoutes({get(pattern: RegExp, fn: typeof handler) {
    if (pattern.source.includes('activity-history')) handler = fn;
  }} as Express, {
    resolveCanonicalRoomRequestId: async id => id,
    resolveRoomOrReply: async () => project,
    requireParticipant: async () => true,
  } as Parameters<typeof routes.registerPresenceReadRoutes>[1]);
});
test.after(async () => { await client?.pool.end(); });

async function request(query: Record<string, string> = {}) {
  let body: unknown;
  await handler({ params: {0:roomId}, query }, {
    json(value: unknown) { body = value; },
    status(code: number) { throw new Error(`Unexpected HTTP ${code}`); },
  });
  return body;
}

async function legacyEntries() {
  const [participants, tasks, presence, messageCounts, reasoningSessionCounts] = await Promise.all([
    api!.getRoomParticipantsForRooms([roomId], {includeHidden:true}),
    api!.getTasksForRooms([roomId]),
    api!.getRoomAgentPresenceSnapshot(roomId, {includeEndedSessions:true}),
    api!.getRoomMessageCountsBySender(roomId),
    api!.getRoomReasoningSessionCountsByActor(roomId),
  ]);
  const fallbackMessages = participants.length ? [] : (await api!.getMessages(roomId,{limit:200})).messages;
  const historyParticipants = helpers!.buildRoomActivityHistoryParticipants({roomId,storedParticipants:participants,presence,fallbackMessages});
  return {
    hidden_count: historyParticipants.filter(p => p.hidden_at).length,
    entries: history.decorateRoomActivityHistoryEntriesWithCounts({
      entries: state.decorateRoomActivityHistoryEntriesWithPresence({
        entries: history.buildRoomActivityHistoryEntries({rooms:[project],participants:historyParticipants,tasks}),presence,
      }),messageCounts,reasoningSessionCounts,
    }),
  };
}

test('activity history preserves pages, search across older tasks, and hidden people', skip, async () => {
  const reference = await legacyEntries();
  for (const query of ['', 'old searchable needle', 'branch-3', 'task 49', 'no match']) {
    for (const kind of ['all', 'agent', 'human'] as const) {
      const filtered = history.sortRoomActivityHistoryEntries(history.filterRoomActivityHistoryEntries(reference.entries,{query,kind,roomId}));
      for (const [page,pageSize] of [[1,20],[2,7],[999,50]]) {
        assert.deepEqual(await request({query,kind,page:String(page),page_size:String(pageSize)}), {
          room_id:roomId,root_room_id:roomId,selected_room_id:roomId,hidden_count:reference.hidden_count,
          ...history.paginateRoomActivityHistoryEntries(filtered,{page,pageSize}),
        }, JSON.stringify({query,kind,page,pageSize}));
      }
    }
  }
});

function captureReads() {
  const pool = client!.pool;
  const original = pool.query;
  const reads: {text: string; values: unknown[]; rows: number; fields: string[]}[] = [];
  // Drizzle uses the promise overload with rowMode=array.
  pool.query = (async function (...args: unknown[]) {
    const query = args[0] as string | {text:string};
    const result = await (original as (...args: unknown[]) => Promise<{rows:unknown[]; fields:{name:string}[]}>).apply(pool,args);
    reads.push({text:typeof query === 'string' ? query : query.text,values:args[1] as unknown[] ?? [],rows:result.rows.length,fields:result.fields.map(f=>f.name)});
    return result;
  }) as typeof pool.query;
  return {reads, restore:()=>{pool.query=original;}};
}

// The read whose own FROM is the table: other reads can name it in a subquery.
function readFrom(reads: ReturnType<typeof captureReads>['reads'], table: string) {
  return reads.find(read => new RegExp(`^select [^()]*? from "${table}"`, 'i').test(read.text))!;
}

test('history avoids task bodies and returns one delivery row per worker identity', skip, async () => {
  const capture = captureReads();
  try { await request(); } finally { capture.restore(); }
  const tasks = capture.reads.find(read => /from "tasks"/i.test(read.text))!;
  assert.equal(tasks.rows,5000,'all task titles remain searchable');
  assert.ok(!tasks.fields.includes('description'),'unused task descriptions must not be transferred');
  const delivery = readFrom(capture.reads, 'room_agent_delivery_sessions');
  assert.equal(delivery.rows,40,'2,000 ended sessions collapse to 40 durable worker identities in SQL');
});

test('history reads the presence rows a participant or a worker can use, and no others', skip, async () => {
  // Chats that connected but never became participants: by far the most rows of a busy room.
  await client!.pool.query(`
    INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, session_kind, actor_label, display_name, repo_branch, transport, last_connected_at, last_disconnected_at, created_at, updated_at)
      SELECT '${roomId}', 'controller:Chat ' || i, 'controller', 'Chat ' || i, 'Chat ' || i, 'chat-branch-' || i, 'sse',
        '2026-01-01', '2026-02-01'::timestamptz + i * interval '1 second', '2026-01-01', '2026-02-01'::timestamptz + i * interval '1 second'
      FROM generate_series(1,3000) i;
  `);
  // Controller rows that share a label with a participant. Each is the oldest
  // entry of its label, which is the entry the history shows. Two labels match
  // only after the trim that JavaScript does (tab, no-break space, line end).
  const controllers: [label: string, branch: string][] = [
    ['Agent 3', 'controller-branch-3'],
    ['\tAgent 4  ', 'controller-branch-4'],
    [' Agent 5﻿\n', 'controller-branch-5'],
    ['Ghost 1 | Owner\'s agent | Codex', 'ghost-branch-1'],
  ];
  for (const [label, branch] of controllers) {
    await client!.pool.query(
      `INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, session_kind, actor_label, display_name, repo_branch, transport, last_connected_at, last_disconnected_at, created_at, updated_at)
       VALUES ($1, 'controller:' || $2, 'controller', $2, $2, $3, 'sse', '2025-12-01', '2025-12-01', '2025-12-01', '2025-12-01')`,
      [roomId, label, branch]);
  }
  // Two rows that tie on every sort column and trim to one participant label:
  // whichever sorts last decorates "Agent 8", so the order must not depend on
  // the query plan.
  for (const [label, branch] of [['\tAgent 8', 'tie-branch-a'], ['Agent 8 ', 'tie-branch-b']]) {
    await client!.pool.query(
      `INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, session_kind, actor_label, display_name, repo_branch, transport, last_connected_at, last_disconnected_at, created_at, updated_at)
       VALUES ($1, 'controller:' || $2, 'controller', $2, 'Tie', $3, 'sse', '2025-11-01', '2025-11-01', '2025-11-01', '2025-11-01')`,
      [roomId, label, branch]);
  }
  // Status rows: one of a chat, one worker row that a controller row hides,
  // and one worker row that stands alone and becomes a participant.
  const statuses: [label: string, kind: string, branch: string][] = [
    ['Chat 7', 'controller', 'chat-status-branch'],
    ['Ghost 1 | Owner\'s agent | Codex', 'worker', 'ghost-status-branch-1'],
    ['Ghost 2 | Owner\'s agent | Codex', 'worker', 'ghost-status-branch-2'],
    ['Agent 6', 'controller', 'status-branch-6'],
  ];
  for (const [label, kind, branch] of statuses) {
    await client!.pool.query(
      `INSERT INTO room_agent_presence (room_id, actor_label, session_kind, display_name, repo_branch, status, last_heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, $3::room_agent_session_kind, $2, $4, 'working', '2026-03-01', '2026-03-01', '2026-03-01')`,
      [roomId, label, kind, branch]);
  }

  const reference = await legacyEntries();
  const branchOf = (name: string) => reference.entries.find(entry => entry.participant.display_name === name)?.participant.repo_branch;
  assert.equal(branchOf('Agent 3'), 'controller-branch-3', 'a controller row decorates the participant with its label');
  assert.equal(branchOf('Agent 4'), 'controller-branch-4');
  assert.equal(branchOf('Agent 5'), 'controller-branch-5');
  assert.match(String(branchOf('Agent 8')), /^tie-branch-[ab]$/);
  const names = reference.entries.map(entry => entry.participant.actor_label);
  assert.ok(names.includes('Ghost 2 | Owner\'s agent | Codex'), 'a worker status row alone is a participant');
  assert.ok(!names.includes('Ghost 1 | Owner\'s agent | Codex'), 'a controller row hides the worker status row with its label');
  assert.ok(!names.some(name => name?.startsWith('Chat ')), 'a chat is not a participant');

  for (const query of ['', 'controller-branch-4', 'ghost', 'chat-branch-9', 'status-branch-6']) {
    for (const kind of ['all', 'agent'] as const) {
      const filtered = history.sortRoomActivityHistoryEntries(history.filterRoomActivityHistoryEntries(reference.entries,{query,kind,roomId}));
      for (const [page,pageSize] of [[1,50],[2,9]]) {
        assert.deepEqual(await request({query,kind,page:String(page),page_size:String(pageSize)}), {
          room_id:roomId,root_room_id:roomId,selected_room_id:roomId,hidden_count:reference.hidden_count,
          ...history.paginateRoomActivityHistoryEntries(filtered,{page,pageSize}),
        }, JSON.stringify({query,kind,page,pageSize}));
      }
    }
  }

  const capture = captureReads();
  try { await request(); } finally { capture.restore(); }
  const delivery = readFrom(capture.reads, 'room_agent_delivery_sessions');
  assert.equal(delivery.rows, 46, '40 worker identities and the 6 controller rows that share a label, of 5,006 rows');
  assert.ok(!capture.reads.some(read => /from "agents"/i.test(read.text)), 'a history entry has no avatar to look up');
});

test('task lookups give each participant the tasks that comparing every pair gave', async () => {
  // The comparison the history used before it indexed tasks by name.
  type P = Parameters<typeof history.buildRoomActivityHistoryEntries>[0]['participants'][number];
  type T = Parameters<typeof history.buildRoomActivityHistoryEntries>[0]['tasks'][number];
  const norm = (value: string | null | undefined) => String(value ?? '').trim().toLowerCase();
  const assigned = (p: P, t: T) => {
    if (p.kind === 'agent') {
      const key = norm(t.assignee_agent_key);
      if (key && key === norm(p.agent_key)) return true;
      const assignee = norm(t.assignee);
      return Boolean(assignee && (assignee === norm(p.actor_label) || assignee === norm(p.display_name)));
    }
    const assignee = norm(t.assignee);
    return Boolean(assignee && (assignee === norm(p.github_login) || assignee === norm(p.display_name)));
  };
  const created = (p: P, t: T) => {
    const by = norm(t.created_by);
    if (!by) return false;
    return p.kind === 'agent'
      ? by === norm(p.actor_label) || by === norm(p.display_name)
      : by === norm(p.github_login) || by === norm(p.display_name);
  };
  const byUpdated = (tasks: T[]) => [...tasks].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const latest = (...values: Array<string | null | undefined>) => {
    let best = ''; let bestValue = -1;
    for (const value of values) {
      const parsed = Date.parse(String(value ?? ''));
      if (Number.isFinite(parsed) && parsed > bestValue) { bestValue = parsed; best = String(value ?? ''); }
    }
    return best;
  };
  const compare = (left: {last_seen_at:string;room:{display_name:string};participant:{display_name:string}}, right: typeof left) => {
    const leftTime = Date.parse(left.last_seen_at); const rightTime = Date.parse(right.last_seen_at);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
    return left.room.display_name.localeCompare(right.room.display_name)
      || left.participant.display_name.localeCompare(right.participant.display_name);
  };

  let seed = 20261120;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = <V,>(values: readonly V[]) => values[Math.floor(random() * values.length)];
  // Few names in many spellings, so one task often matches by several fields and many tasks share an owner.
  const names = ['Ada', ' ada ', 'ADA', 'Bob', 'bob\t', 'Cy | Owner\'s agent | Codex', 'cy | owner\'s agent | codex', 'owner/ada', 'OWNER/ADA', 'owner/bob', 'Dee', '', null];
  const times = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T10:00:00.000Z', 'not a time'];
  const statuses = ['proposed','accepted','assigned','in_progress','blocked','in_review','merged','done','cancelled'];
  const rooms = ['room-a', 'room-b'].map(id => ({
    id, display_name: id === 'room-a' ? 'Same name' : pick(['Same name', 'Other']), kind: 'main', focus_status: null, source_task_id: null,
  })) as unknown as Parameters<typeof history.buildRoomActivityHistoryEntries>[0]['rooms'];

  for (let round = 0; round < 40; round += 1) {
    const participants = Array.from({length: 1 + Math.floor(random() * 30)}, (_, index) => ({
      room_id: pick(['room-a', 'room-b', 'room-missing']), participant_key: `p${index}`,
      kind: pick(['agent', 'agent', 'human'] as const), actor_label: pick(names), agent_key: pick(names), github_login: pick(names),
      display_name: pick(names) ?? 'Zed', owner_label: pick(names), ide_label: null, hidden_at: null, hidden_by: null,
      last_seen_at: pick(times), last_room_activity_at: null, last_live_heartbeat_at: null, activity_state: null,
      source_flags: [], created_at: times[0], updated_at: times[0],
    })) as unknown as P[];
    const tasks = Array.from({length: Math.floor(random() * 60)}, (_, index) => ({
      id: `task_${index}`, room_id: pick(['room-a', 'room-b']), title: `Title ${index} ${pick(['alpha', 'beta', 'gamma'])}`,
      status: pick(statuses), assignee: pick(names), assignee_agent_key: pick(names), created_by: pick(names),
      updated_at: pick(times.slice(0, 4)), workflow_refs: [],
    })) as unknown as T[];

    const summary = (task: T) => ({id: task.id, title: task.title, status: task.status, updated_at: task.updated_at, workflow_refs: task.workflow_refs});
    const expected = participants.flatMap(participant => {
      const room = rooms.find(candidate => candidate.id === participant.room_id);
      if (!room) return [];
      const roomTasks = tasks.filter(task => task.room_id === room.id);
      const mine = roomTasks.filter(task => assigned(participant, task));
      const current = byUpdated(mine.filter(task => ['proposed','accepted','assigned','in_progress','blocked','in_review'].includes(task.status)));
      const completed = byUpdated(mine.filter(task => ['merged','done'].includes(task.status)));
      const made = byUpdated(roomTasks.filter(task => created(participant, task)));
      return [{
        id: `${room.id}:${participant.participant_key}`,
        room: {id: room.id, display_name: room.display_name, kind: room.kind, focus_status: room.focus_status, source_task_id: room.source_task_id},
        participant: {
          participant_key: participant.participant_key, kind: participant.kind, actor_label: participant.actor_label,
          agent_key: participant.agent_key, github_login: participant.github_login, display_name: participant.display_name,
          owner_label: participant.owner_label, ide_label: participant.ide_label, repo_branch: null, hidden_at: null, hidden_by: null,
          last_live_heartbeat_at: null, activity_state: null, source_flags: [],
        },
        first_seen_at: participant.created_at, last_seen_at: participant.last_seen_at,
        last_room_activity_at: latest(participant.last_seen_at, current[0]?.updated_at, completed[0]?.updated_at, made[0]?.updated_at),
        message_count: 0, reasoning_session_count: 0,
        current_tasks: current.slice(0, 5).map(summary), completed_tasks: completed.slice(0, 5).map(summary), created_tasks: made.slice(0, 5).map(summary),
        // Every matching task is searchable, not only the five an entry shows.
        searchable: [room.display_name, room.id, participant.display_name, participant.actor_label, participant.github_login,
          participant.owner_label, participant.ide_label, ...[...current, ...completed, ...made].flatMap(task => [task.id, task.title, task.status]),
        ].filter(Boolean).join(' ').toLowerCase(),
      }];
    }).sort(compare);

    const actual = history.buildRoomActivityHistoryEntries({rooms, participants, tasks});
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected.map(({searchable: _searchable, ...entry}) => entry), `round ${round}`);
    for (const query of [...tasks.slice(0, 8).map(task => task.id), 'Gamma', ' in_review', 'owner/ada', 'no such text']) {
      assert.deepEqual(
        history.filterRoomActivityHistoryEntries(actual, {query}).map(entry => entry.id),
        expected.filter(entry => entry.searchable.includes(query.trim().toLowerCase())).map(entry => entry.id),
        `round ${round} search ${query}`);
    }
    const shuffled = [...actual].sort(() => random() - 0.5);
    assert.deepEqual(history.sortRoomActivityHistoryEntries(shuffled), [...shuffled].sort(compare), `round ${round} sort`);
  }
});

test('SQL trims an actor label as JavaScript does', async () => {
  const { JS_TRIM_CHARACTERS } = await import('../db/presence/helpers.js');
  let trimmed = '';
  for (let code = 0; code <= 0xffff; code += 1) {
    const character = String.fromCharCode(code);
    if (character.trim() === '') trimmed += character;
  }
  assert.equal(JS_TRIM_CHARACTERS, trimmed);
});

test('SQL succession matches presence merging for reachable, grace, tied and legacy sessions', skip, async () => {
  await client!.pool.query(`
    UPDATE room_agent_delivery_sessions SET reconnect_grace_expires_at='2099-01-01'
      WHERE room_id='${roomId}' AND delivery_key='agent_session:history-session-1';
    UPDATE room_agent_delivery_sessions SET active_connection_count=1, updated_at='2099-01-01'
      WHERE room_id='${roomId}' AND delivery_key='agent_session:history-session-2';
    UPDATE room_agent_delivery_sessions SET agent_instance_id='different-instance'
      WHERE room_id='${roomId}' AND delivery_key='agent_session:history-session-3';
    UPDATE room_agent_delivery_sessions SET agent_key=NULL
      WHERE room_id='${roomId}' AND delivery_key='agent_session:history-session-4';
    UPDATE room_agent_delivery_sessions SET agent_instance_id=''
      WHERE room_id='${roomId}' AND delivery_key='agent_session:history-session-5';
    UPDATE room_agent_delivery_sessions SET session_kind='controller'
      WHERE room_id='${roomId}' AND delivery_key='agent_session:history-session-6';
    UPDATE room_agent_delivery_sessions SET last_disconnected_at='2026-01-02'
      WHERE room_id='${roomId}' AND delivery_key IN ('agent_session:history-session-7','agent_session:history-session-47');
  `);
  assert.deepEqual(
    await api!.getRoomAgentPresenceSnapshot(roomId,{includeEndedSessions:true,collapseWorkerSessions:true}),
    await api!.getRoomAgentPresenceSnapshot(roomId,{includeEndedSessions:true}),
  );
});

test('a heartbeat expiring during the query uses the response-time session winner', skip, async (t) => {
  const at = Date.parse('2026-06-01T12:00:00Z');
  await client!.pool.query("UPDATE room_agent_delivery_sessions SET active_connection_count=0, reconnect_grace_expires_at=NULL WHERE room_id=$1 AND agent_key='owner/agent-9'", [roomId]);
  await client!.pool.query("UPDATE room_agent_delivery_sessions SET active_connection_count=1, updated_at=$2, repo_branch='old-live' WHERE room_id=$1 AND delivery_key='agent_session:history-session-8'", [roomId,new Date(at-89_999).toISOString()]);
  await client!.pool.query("UPDATE room_agent_delivery_sessions SET last_disconnected_at=$2, repo_branch='new-offline' WHERE room_id=$1 AND delivery_key='agent_session:history-session-48'", [roomId,new Date(at-1).toISOString()]);
  let now=at+2;
  t.mock.method(Date,'now',()=>now);
  const expected=await api!.getRoomAgentPresenceSnapshot(roomId,{includeEndedSessions:true});
  const original=client!.pool.query;
  client!.pool.query=(async function (...args: unknown[]) {
    const result=await (original as (...args:unknown[])=>Promise<unknown>).apply(client!.pool,args);
    const query=args[0] as string | {text:string};
    if ((typeof query === 'string' ? query : query.text).includes('history_delivery')) now=at+2;
    return result;
  }) as typeof original;
  now=at;
  try {
    assert.deepEqual(await api!.getRoomAgentPresenceSnapshot(roomId,{includeEndedSessions:true,collapseWorkerSessions:true}),expected);
  } finally {client!.pool.query=original;}
});

test('history retains fallback participants when no stored roster exists', skip, async () => {
  await client!.pool.query('DELETE FROM room_participants WHERE room_id=$1',[roomId]);
  const reference=await legacyEntries();
  assert.ok(reference.entries.length >= 40, 'every historical identity remains available');
  for (const page of [1,2,99]) {
    assert.deepEqual(await request({page:String(page)}),{
      room_id:roomId,root_room_id:roomId,selected_room_id:roomId,hidden_count:reference.hidden_count,
      ...history.paginateRoomActivityHistoryEntries(history.sortRoomActivityHistoryEntries(reference.entries),{page,pageSize:20}),
    });
  }
});

test('a room without stored participants decorates its message senders from every presence row', skip, async () => {
  // Without a stored roster the participants come from message senders, which
  // the presence read cannot know, so it must not leave any row out.
  const sender = 'Ghost 3 | Owner\'s agent | Codex';
  await client!.pool.query('DELETE FROM room_participants WHERE room_id=$1',[roomId]);
  await client!.pool.query(
    `INSERT INTO messages (room_id, number, sender, text, timestamp) VALUES ($1, 1, $2, 'hello', '2026-04-01')`,
    [roomId, sender]);
  await client!.pool.query(
    `INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, session_kind, actor_label, display_name, repo_branch, transport, last_connected_at, last_disconnected_at, created_at, updated_at)
     VALUES ($1, 'controller:' || $2, 'controller', $2, $2, 'sender-branch', 'sse', '2025-12-01', '2025-12-01', '2025-12-01', '2025-12-01')`,
    [roomId, sender]);
  const reference=await legacyEntries();
  assert.equal(reference.entries.find(entry => entry.participant.actor_label === sender)?.participant.repo_branch, 'sender-branch');
  assert.deepEqual(await request({query:'sender-branch'}),{
    room_id:roomId,root_room_id:roomId,selected_room_id:roomId,hidden_count:reference.hidden_count,
    ...history.paginateRoomActivityHistoryEntries(history.sortRoomActivityHistoryEntries(
      history.filterRoomActivityHistoryEntries(reference.entries,{query:'sender-branch',roomId})),{page:1,pageSize:20}),
  });
});

test('measure activity history reads' , {...skip, skip: !url || !process.env.MEASURE_ACTIVITY_HISTORY}, async () => {
  const times: number[] = [];
  for (let i=0;i<6;i++) {const start=performance.now();await request(); if(i) times.push(performance.now()-start);}
  console.log('ROUTE_MS',JSON.stringify(times), 'MEDIAN', [...times].sort((a,b)=>a-b)[2]);
  const capture = captureReads();
  try { await request(); } finally { capture.restore(); }
  for (const read of capture.reads.filter(r => /from "(tasks|room_agent_delivery_sessions)"/i.test(r.text))) {
    const result=await client!.pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+read.text,read.values);
    console.log('READ_ROWS',read.rows,'FIELDS',read.fields.join(','));
    console.log('PLAN',read.text,JSON.stringify(result.rows[0]['QUERY PLAN']));
  }
});
