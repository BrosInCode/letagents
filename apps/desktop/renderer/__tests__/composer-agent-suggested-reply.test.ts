import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { effectScope, nextTick, ref } from 'vue';
import { createServer, type ViteDevServer } from 'vite';

const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
let vite: ViteDevServer;
let ipc: any;
let module: any;

before(async () => {
  const fakeWindow = Object.assign(new EventTarget(), {});
  Object.defineProperty(fakeWindow, 'letagentsDesktop', { get: () => ipc });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  module = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/composer-suggested-reply.ts');
});
after(async () => {
  await vite?.close();
  if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test('the composer reads the agent suggestion when the newest message changes, and never shows another room\'s', async (t) => {
  const asked: string[] = [];
  let answer: any = { messageId: 'msg_7', agentKey: 'codex:1', from: 'StoneGrove', text: 'Yes, merge it' };
  ipc = { room: { getSuggestedReply: async (room: string) => { asked.push(room); return answer; } } };
  const room = ref<string | null>('room-a');
  const latest = ref<string | null>('msg_7');
  const scope = effectScope();
  t.after(() => scope.stop());
  const suggestion = scope.run(() => module.useAgentSuggestedReply(() => room.value, () => latest.value))!;
  await settle();
  assert.deepEqual(suggestion.value, { recordId: 'message:room-a:msg_7', from: 'StoneGrove', text: 'Yes, merge it' });
  assert.deepEqual(asked, ['room-a']);

  // A burst of new messages costs one request.
  answer = null;
  latest.value = 'msg_8';
  latest.value = 'msg_9';
  await settle();
  assert.equal(suggestion.value, null);
  assert.deepEqual(asked, ['room-a', 'room-a']);

  // Switching rooms clears the old suggestion at once, before the new answer.
  answer = { messageId: 'msg_2', agentKey: 'claude:1', from: 'Fern', text: 'Use option 2' };
  latest.value = 'msg_10';
  await settle();
  assert.equal(suggestion.value?.text, 'Use option 2');
  room.value = 'room-b';
  latest.value = 'msg_1';
  await nextTick();
  assert.equal(suggestion.value, null, 'cleared before the screen updates');
  await settle();
  assert.equal(suggestion.value?.text, 'Use option 2');
});

test('no bridge, no room or a failed read shows no suggestion', async (t) => {
  ipc = { room: {} };
  const scope = effectScope();
  t.after(() => scope.stop());
  const none = scope.run(() => module.useAgentSuggestedReply(() => 'room-a', () => 'msg_1'))!;
  await settle();
  assert.equal(none.value, null);
  ipc = { room: { getSuggestedReply: async () => { throw new Error('offline'); } } };
  const failed = scope.run(() => module.useAgentSuggestedReply(() => 'room-a', () => 'msg_1'))!;
  await settle();
  assert.equal(failed.value, null);
});
