import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE,
  MESSAGE_REACTION_MAX_PER_READ,
  MESSAGE_REACTION_MAX_REACTORS_LISTED,
  MESSAGE_REACTION_QUICK_EMOJI,
} from '../../../shared/message-reactions.mjs';

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import('../db/client.js') : null;
const schema = url ? await import('../db/schema.js') : null;
const rooms = url ? await import('../db.js') : null;
const store = url ? await import('../db/messages/reactions.js') : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve('drizzle') }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? 'Set TEST_DB_URL to run PostgreSQL integration tests.' : false };
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

async function person(label: string, displayName: string | null = null) {
  const login = unique(label);
  return rooms!.upsertAccount({ provider: 'github', provider_user_id: login, login, display_name: displayName });
}

async function roomWithMessage(text = 'Shall we ship it?') {
  const room = await rooms!.createProjectWithName(unique('reactions'));
  const message = await rooms!.addMessage(room.id, 'Emmy', text, { source: 'browser' });
  return { room, message, number: Number(message.id.slice(4)) };
}

// Twenty distinct emoji plus spares, to reach the per-message limit.
const DISTINCT = [...MESSAGE_REACTION_QUICK_EMOJI, '🧪', '🧹'];

test('a reaction is added once, read back with the message, and removed', options, async () => {
  const { room, message, number } = await roomWithMessage();
  const ada = await person('ada', 'Ada Lovelace');
  const target = { roomId: room.id, messageNumber: number, accountId: ada.id, emoji: '👍' };

  assert.deepEqual(message.reactions, [], 'a new message carries an empty list, never a missing field');
  assert.equal(await store!.addMessageReaction(target), 'added');
  assert.equal(await store!.addMessageReaction(target), 'exists');

  const expected = [{ emoji: '👍', count: 1, reactors: [{ login: ada.login, name: 'Ada Lovelace', avatar_url: null }] }];
  assert.deepEqual(await store!.getMessageReactions(room.id, number), expected);
  const history = await rooms!.getMessages(room.id);
  assert.deepEqual(history.messages.find((item) => item.id === message.id)?.reactions, expected);
  assert.deepEqual((await rooms!.getMessageById(room.id, message.id))?.reactions, expected);

  assert.equal(await store!.removeMessageReaction(target), true);
  assert.equal(await store!.removeMessageReaction(target), false);
  assert.deepEqual(await store!.getMessageReactions(room.id, number), []);
});

test('reactions are grouped per emoji in the order they first appeared, with earliest reactors first', options, async () => {
  const { room, number } = await roomWithMessage();
  const [ada, grace, noName] = [await person('ada', 'Ada'), await person('grace', 'Grace'), await person('plain')];
  const react = (accountId: string, emoji: string) =>
    store!.addMessageReaction({ roomId: room.id, messageNumber: number, accountId, emoji });
  await react(grace.id, '🎉');
  await react(ada.id, '👍');
  await react(noName.id, '🎉');
  await react(ada.id, '🎉');

  const reactions = await store!.getMessageReactions(room.id, number);
  assert.deepEqual(reactions.map((reaction) => [reaction.emoji, reaction.count]), [['🎉', 3], ['👍', 1]]);
  assert.deepEqual(reactions[0]!.reactors.map((reactor) => reactor.name), ['Grace', noName.login, 'Ada'],
    'a person without a display name is shown by login');
});

test('a reaction never becomes a message, a receipt or a push notification', options, async () => {
  const { room, number } = await roomWithMessage();
  const ada = await person('ada');
  const count = async (table: any, column: any) =>
    (await client!.db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(column, room.id)))[0]!.n;
  const before = {
    messages: await count(schema!.messages, schema!.messages.room_id),
    receipts: await count(schema!.message_agent_receipts, schema!.message_agent_receipts.message_room_id),
    pushes: await count(schema!.desktop_push_notifications, schema!.desktop_push_notifications.room_id),
  };
  await store!.addMessageReaction({ roomId: room.id, messageNumber: number, accountId: ada.id, emoji: '👀' });
  await store!.removeMessageReaction({ roomId: room.id, messageNumber: number, accountId: ada.id, emoji: '👀' });
  assert.deepEqual({
    messages: await count(schema!.messages, schema!.messages.room_id),
    receipts: await count(schema!.message_agent_receipts, schema!.message_agent_receipts.message_room_id),
    pushes: await count(schema!.desktop_push_notifications, schema!.desktop_push_notifications.room_id),
  }, before);
});

test('a missing or hidden message cannot be reacted to', options, async () => {
  const { room, number } = await roomWithMessage();
  const ada = await person('ada');
  assert.equal(
    await store!.addMessageReaction({ roomId: room.id, messageNumber: number + 50, accountId: ada.id, emoji: '👍' }),
    'message_not_found',
  );
  const other = await roomWithMessage();
  assert.equal(
    await store!.addMessageReaction({ roomId: other.room.id, messageNumber: number + 50, accountId: ada.id, emoji: '👍' }),
    'message_not_found',
    'a message number from another room is not found here',
  );
  const prompt = await rooms!.addMessage(room.id, 'Agent', '', { source: 'agent', agent_prompt_kind: 'auto' });
  assert.equal(
    await store!.addMessageReaction({ roomId: room.id, messageNumber: Number(prompt.id.slice(4)), accountId: ada.id, emoji: '👍' }),
    'message_not_found',
    'an empty prompt-only message is invisible, so it cannot be reacted to',
  );
});

test('a message holds a bounded number of different emoji, also under concurrent writers', options, async () => {
  const { room, number } = await roomWithMessage();
  const ada = await person('ada');
  const grace = await person('grace');
  const react = (accountId: string, emoji: string) =>
    store!.addMessageReaction({ roomId: room.id, messageNumber: number, accountId, emoji });
  for (const emoji of DISTINCT.slice(0, MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE - 1)) {
    assert.equal(await react(ada.id, emoji), 'added');
  }
  // One slot is left. Three different new emoji race for it.
  const racers = DISTINCT.slice(MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE - 1, MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE + 2);
  assert.equal(racers.length, 3);
  const outcomes = (await Promise.all(racers.map((emoji) => react(grace.id, emoji)))).sort();
  assert.deepEqual(outcomes, ['added', 'limit_reached', 'limit_reached']);
  assert.equal((await store!.getMessageReactions(room.id, number)).length, MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE);
  assert.equal(await react(grace.id, DISTINCT[0]!), 'added', 'joining an emoji that is already there is always allowed');
});

test('the count stays exact when the listed reactors are capped', options, async () => {
  const { room, number } = await roomWithMessage();
  const total = MESSAGE_REACTION_MAX_REACTORS_LISTED + 5;
  const people = [];
  for (let index = 0; index < total; index += 1) people.push(await person(`crowd${index}`));
  const startedAt = Date.now();
  await client!.db.insert(schema!.message_reactions).values(people.map((account, index) => ({
    room_id: room.id,
    message_number: number,
    account_id: account.id,
    emoji: '🚀',
    created_at: new Date(startedAt + index).toISOString(),
  })));
  const [reaction] = await store!.getMessageReactions(room.id, number);
  assert.equal(reaction!.count, total);
  assert.deepEqual(
    reaction!.reactors.map((reactor) => reactor.login),
    people.slice(0, MESSAGE_REACTION_MAX_REACTORS_LISTED).map((account) => account.login),
  );
  assert.deepEqual(await store!.loadViewerMessageReactions(client!.db, room.id, people.at(-1)!.id, { first: number, last: number }),
    new Map([[number, ['🚀']]]), 'viewer state includes a reactor beyond the named list cap');
});

test('a range read returns only reacted messages and never half a message when truncated', options, async () => {
  const room = await rooms!.createProjectWithName(unique('reactions-range'));
  const numbers: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    numbers.push(Number((await rooms!.addMessage(room.id, 'Emmy', `Message ${index}`, { source: 'browser' })).id.slice(4)));
  }
  const ada = await person('ada');
  await store!.addMessageReaction({ roomId: room.id, messageNumber: numbers[0]!, accountId: ada.id, emoji: '👍' });
  await store!.addMessageReaction({ roomId: room.id, messageNumber: numbers[2]!, accountId: ada.id, emoji: '✅' });

  const all = await store!.loadMessageReactions(client!.db, room.id, { first: numbers[0]!, last: numbers[3]! });
  assert.deepEqual([...all.reactions.keys()], [numbers[0], numbers[2]]);
  assert.equal(all.nextFirst, null);
  const tail = await store!.loadMessageReactions(client!.db, room.id, { first: numbers[1]!, last: numbers[3]! });
  assert.deepEqual([...tail.reactions.keys()], [numbers[2]]);
  const inverted = await store!.loadMessageReactions(client!.db, room.id, { first: numbers[3]!, last: numbers[0]! });
  assert.equal(inverted.reactions.size, 0);
  assert.equal((await store!.loadMessageReactions(client!.db, room.id, { numbers: [] })).reactions.size, 0);

  // Push the last message past the read limit: it must drop out whole.
  const crowd = [];
  for (let index = 0; index < MESSAGE_REACTION_MAX_REACTORS_LISTED; index += 1) crowd.push(await person(`range${index}`));
  const emojiNeeded = Math.ceil((MESSAGE_REACTION_MAX_PER_READ + 1) / (MESSAGE_REACTION_MAX_REACTORS_LISTED * 3));
  assert.ok(emojiNeeded <= MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE);
  const rows = [];
  for (const messageNumber of [numbers[1]!, numbers[2]!, numbers[3]!]) {
    for (const emoji of DISTINCT.slice(2, 2 + emojiNeeded)) {
      for (const account of crowd) rows.push({ room_id: room.id, message_number: messageNumber, account_id: account.id, emoji });
    }
  }
  await client!.db.insert(schema!.message_reactions).values(rows);
  const truncated = await store!.loadMessageReactions(client!.db, room.id, { first: numbers[0]!, last: numbers[3]! });
  assert.equal(truncated.nextFirst, numbers[3]);
  assert.deepEqual([...truncated.reactions.keys()], [numbers[0], numbers[1], numbers[2]]);
  assert.equal(truncated.reactions.get(numbers[1]!)!.length, emojiNeeded, 'kept messages are complete');
  const continued = await store!.loadMessageReactions(client!.db, room.id, { first: truncated.nextFirst!, last: numbers[3]! });
  assert.equal(continued.nextFirst, null);
  assert.deepEqual([...continued.reactions.keys()], [numbers[3]]);
  assert.equal(continued.reactions.get(numbers[3]!)!.length, emojiNeeded);
  // A page of history is bounded by its messages instead, so nothing is dropped.
  const page = await store!.loadMessageReactions(client!.db, room.id, { numbers });
  assert.equal(page.nextFirst, null);
  assert.equal(page.reactions.get(numbers[3]!)!.length, emojiNeeded);
});

test('reactions go away with the account or the room', options, async () => {
  const { room, number } = await roomWithMessage();
  const ada = await person('ada');
  const grace = await person('grace');
  for (const account of [ada, grace]) {
    await store!.addMessageReaction({ roomId: room.id, messageNumber: number, accountId: account.id, emoji: '👍' });
  }
  await client!.db.delete(schema!.accounts).where(eq(schema!.accounts.id, ada.id));
  assert.deepEqual((await store!.getMessageReactions(room.id, number)).map((reaction) => reaction.count), [1]);
  await client!.db.delete(schema!.rooms).where(eq(schema!.rooms.id, room.id));
  const [left] = await client!.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema!.message_reactions)
    .where(eq(schema!.message_reactions.room_id, room.id));
  assert.equal(left!.n, 0);
});

test('the database refuses an oversized emoji value', options, async () => {
  const { room, number } = await roomWithMessage();
  const ada = await person('ada');
  await assert.rejects(
    client!.db.insert(schema!.message_reactions).values({
      room_id: room.id, message_number: number, account_id: ada.id, emoji: 'x'.repeat(65),
    }),
    (error: any) => /message_reactions_emoji_check/.test(String(error?.cause?.message ?? error?.message)),
  );
});


test('viewer reactions are scoped to the account, room and inclusive message range', options, async () => {
  const { room, number } = await roomWithMessage();
  const second = Number((await rooms!.addMessage(room.id, 'Emmy', 'Second', { source: 'browser' })).id.slice(4));
  const other = await roomWithMessage();
  const ada = await person('viewer');
  const grace = await person('other-viewer');
  for (const target of [
    { roomId: room.id, messageNumber: number, accountId: ada.id, emoji: '👍' },
    { roomId: room.id, messageNumber: number, accountId: ada.id, emoji: '🎉' },
    { roomId: room.id, messageNumber: second, accountId: ada.id, emoji: '✅' },
    { roomId: room.id, messageNumber: number, accountId: grace.id, emoji: '👀' },
    { roomId: other.room.id, messageNumber: other.number, accountId: ada.id, emoji: '🚀' },
  ]) await store!.addMessageReaction(target);
  const read = (first: number, last: number) => store!.loadViewerMessageReactions(client!.db, room.id, ada.id, { first, last });
  assert.deepEqual(await read(number, second), new Map([[number, ['👍', '🎉']], [second, ['✅']]]));
  assert.deepEqual(await read(second, second), new Map([[second, ['✅']]]));
  assert.deepEqual(await read(second, number), new Map());
  assert.deepEqual(await read(second + 1, second + 10), new Map());
});


test('the migration times out behind a message writer and restores the connection setting', options, async () => {
  const namespace = unique('reaction-migration');
  const identifier = sql.identifier(namespace);
  await client!.db.execute(sql`CREATE SCHEMA ${identifier}`);
  await client!.db.execute(sql`CREATE TABLE ${identifier}.accounts (id text PRIMARY KEY)`);
  await client!.db.execute(sql`CREATE TABLE ${identifier}.messages (room_id text, number integer, PRIMARY KEY (room_id, number))`);
  const writer = await client!.pool.connect();
  const migrator = await client!.pool.connect();
  const writerDb = drizzle(writer);
  const migratorDb = drizzle(migrator);
  const migration = readFileSync(resolve('drizzle/0108_message_reactions.sql'), 'utf8').split('--> statement-breakpoint');
  try {
    const before = await migrator.query('SHOW lock_timeout');
    await writer.query('BEGIN');
    await writerDb.execute(sql`LOCK TABLE ${identifier}.messages IN ROW EXCLUSIVE MODE`);
    await assert.rejects(migratorDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path = ${identifier}`);
      for (const statement of migration) await tx.execute(sql.raw(statement));
    }), (error: any) => (error?.cause?.code ?? error?.code) === '55P03');
    assert.deepEqual((await migrator.query('SHOW lock_timeout')).rows, before.rows, 'SET LOCAL does not leak out of the rolled-back migration');
    await writer.query('ROLLBACK');
    await migratorDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path = ${identifier}`);
      for (const statement of migration) await tx.execute(sql.raw(statement));
    });
    assert.deepEqual((await migrator.query('SHOW lock_timeout')).rows, before.rows, 'successful migration also restores the connection setting');
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    migrator.release();
    await client!.db.execute(sql`DROP SCHEMA ${identifier} CASCADE`);
  }
});
