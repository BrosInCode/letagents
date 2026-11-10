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

test('history avoids task bodies and returns one delivery row per worker identity', skip, async () => {
  const capture = captureReads();
  try { await request(); } finally { capture.restore(); }
  const tasks = capture.reads.find(read => /from "tasks"/i.test(read.text))!;
  assert.equal(tasks.rows,5000,'all task titles remain searchable');
  assert.ok(!tasks.fields.includes('description'),'unused task descriptions must not be transferred');
  const delivery = capture.reads.find(read => /from "room_agent_delivery_sessions"/i.test(read.text))!;
  assert.equal(delivery.rows,40,'2,000 ended sessions collapse to 40 durable worker identities in SQL');
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
