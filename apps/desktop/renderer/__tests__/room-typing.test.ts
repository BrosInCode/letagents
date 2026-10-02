import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, ref } from 'vue';
import { receiveRoomTyping, setTypingAccount, useRoomTyping } from '../src/composables/useRoomTyping';

test('native typing state clears on room, account, stream and scope changes, without draft reports', () => {
  const originalWindow = globalThis.window;
  const reported: Array<{ room: string; input: any }> = [];
  const events = new Map<string, () => void>();
  globalThis.window = {
    letagentsDesktop: { room: { reportTyping(room: string, input: any) { reported.push({ room, input }); return Promise.resolve(); } } },
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
    removeEventListener: (name: string) => events.delete(name),
  } as any;
  const scope = effectScope();
  const room = ref('room_one');
  const signal = (account_id = 'ada') => ({ room_id: 'room_one', account_id, name: 'Ada',
    client_id: 'composer_source_1', sequence: 1, typing: true, ttl_ms: 5000, expires_at: Date.now() + 5000 });
  setTypingAccount('bea');
  try {
    const typing = scope.run(() => useRoomTyping(room))!;
    assert.equal(reported.length, 0, 'restored drafts do not report');
    receiveRoomTyping('room_one', signal('bea'));
    assert.equal(typing.label.value, '', 'another device on this account is still self');
    receiveRoomTyping('room_one', signal());
    assert.equal(typing.label.value, 'Ada is typing…');
    typing.input(true);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].room, 'room_one');
    room.value = 'room_two';
    assert.equal(typing.label.value, '');
    assert.equal(reported.at(-1)?.room, 'room_one', 'stop targets the room being left');
    assert.equal(reported.at(-1)?.input.typing, false);
    receiveRoomTyping('room_one', signal());
    assert.equal(typing.label.value, '', 'retired room does not repopulate');
    receiveRoomTyping('room_two', { ...signal(), room_id: 'room_two' });
    assert.equal(typing.label.value, 'Ada is typing…');
    receiveRoomTyping('room_two');
    assert.equal(typing.label.value, '', 'stream disconnect clears immediately');
    receiveRoomTyping('room_two', { ...signal(), room_id: 'room_two' });
    setTypingAccount(null);
    assert.equal(typing.label.value, '');
    const count = reported.length;
    typing.input(true);
    assert.equal(reported.length, count, 'signed-out input does not report');
    scope.stop();
    assert.equal(events.size, 0);
    setTypingAccount('bea');
    receiveRoomTyping('room_two', { ...signal(), room_id: 'room_two' });
    assert.equal(typing.label.value, '', 'disposed receiver has no subscription');
  } finally { scope.stop(); setTypingAccount(null); globalThis.window = originalWindow; }
});
