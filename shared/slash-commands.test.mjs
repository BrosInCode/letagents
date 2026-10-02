import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideComposerSubmitAction, getSlashCommands, resolveSlashInput } from './slash-commands.mjs';

for (const platform of ['desktop', 'web']) {
  test(`${platform}: registry and parser honor the composer command boundary`, () => {
    assert.deepEqual(getSlashCommands(platform).map(command => command.name), platform === 'desktop' ? ['task', 'search', 'agent'] : ['task', 'search']);
    assert.deepEqual(resolveSlashInput({ text: '/', platform }).commands.map(command => command.name), getSlashCommands(platform).map(command => command.name));
    for (const [text, action] of [
      ['/t', 'complete_command'], ['/se', 'complete_command'],
      ['/task', 'show_hint'], ['/task \t ', 'show_hint'], ['/search ', 'show_hint'],
      ['/task Build it', 'execute_command'], ['/search error 404', 'execute_command'],
      ['/TASK\tTitle', 'execute_command'],
      ['/agent', platform === 'desktop' ? 'execute_command' : 'send_message'],
      ['/agent extra', platform === 'desktop' ? 'show_hint' : 'send_message'],
      ['/usr/bin', 'send_message'], ['/tasker title', 'send_message'], ['/t title', 'send_message'],
      [' /task title', 'send_message'], ['Hello /task title', 'send_message'],
      ['/task first\nsecond', 'send_message'], ['/task title\r', 'send_message'],
    ]) assert.equal(decideComposerSubmitAction({ text, platform }).action, action, text);
    for (const flag of ['hasAttachments', 'isReply', 'menuDismissed']) {
      assert.equal(decideComposerSubmitAction({ text: '/task Title', platform, [flag]: true }).action, 'send_message', flag);
    }
    assert.equal(decideComposerSubmitAction({ text: '/', platform, selectedCommandIndex: 1 }).text, '/search ');
    assert.equal(decideComposerSubmitAction({ text: '/task  Keep  spacing ', platform }).argument, 'Keep  spacing');
  });
}
