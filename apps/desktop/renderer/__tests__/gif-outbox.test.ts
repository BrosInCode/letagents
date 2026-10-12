import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearDesktopMessageOutbox, desktopMessageOutbox, enqueueDesktopMessage,
  retryDesktopOutgoingMessage, sendDesktopOutgoingWithoutGif, discardRefusedDesktopGif,
} from '../src/domain/message-outbox.js';

const gif = {provider:'giphy' as const,id:'abc123',title:'Small win'};
function enqueue(text='Done') {
  return enqueueDesktopMessage({roomIdentifier:'trial',messageNamespace:null,text,replyTo:null,
    threadRootId:null,attachments:[],gif,replyPreview:null,onConfirmed() {}});
}
function bridge(send: (...args: unknown[]) => Promise<unknown>) {
  Object.defineProperty(globalThis,'window',{configurable:true,value:{letagentsDesktop:{room:{sendMessage:send}}}});
}
test.afterEach(() => {clearDesktopMessageOutbox(); Reflect.deleteProperty(globalThis,'window');});
test('an unconfirmed GIF cannot be converted or discarded; retry preserves its publication identity', async () => {
  const calls: unknown[][]=[];
  bridge(async (...args) => {calls.push(args);throw new Error('Connection lost after request');});
  const key=enqueue(); await retryDesktopOutgoingMessage(key);
  await sendDesktopOutgoingWithoutGif(key); discardRefusedDesktopGif(key);
  assert.equal(calls.length,1); assert.equal(desktopMessageOutbox.value.length,1);
  assert.deepEqual(desktopMessageOutbox.value[0].message.gif,gif);
  await retryDesktopOutgoingMessage(key);
  assert.deepEqual(calls[1],calls[0]); assert.equal(calls[0][5],key);
});
test('a known precommit flag refusal can send the original text without a GIF using the same id', async () => {
  const calls: unknown[][]=[];
  bridge(async (...args) => {
    calls.push(args);
    if (calls.length===1) throw new Error('HTTP 400 expressions_disabled: GIF sending is disabled in this room.');
    return {message:{...desktopMessageOutbox.value[0].message,id:'msg_2',gif:null,outgoing:undefined}};
  });
  const key=enqueue(); await retryDesktopOutgoingMessage(key); await sendDesktopOutgoingWithoutGif(key);
  assert.equal(calls.length,2); assert.equal(calls[1][5],key);
  assert.equal(calls[1][1],'Done'); assert.equal(calls[1][7],null);
  assert.equal(desktopMessageOutbox.value[0].confirmed,true);
});
test('an explicitly refused GIF-only send can be removed without affecting an uncertain send', async () => {
  bridge(async () => {throw new Error('expressions_disabled: GIF sending is disabled');});
  const key=enqueue(''); await retryDesktopOutgoingMessage(key); discardRefusedDesktopGif(key);
  assert.equal(desktopMessageOutbox.value.length,0);
  bridge(async () => {throw new Error('Network interrupted');});
  const uncertain=enqueue(''); await retryDesktopOutgoingMessage(uncertain); discardRefusedDesktopGif(uncertain);
  assert.equal(desktopMessageOutbox.value.length,1);
});
