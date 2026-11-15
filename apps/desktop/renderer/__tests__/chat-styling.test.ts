import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer, type ViteDevServer } from 'vite';
import { chatBubbleStyle, chatColorContrast, chatColorPresets, defaultChatColors, normalizeChatColor, parseChatColors, readableChatSurface } from '../../../../shared/chat-colors';

test('saved colors accept only known roles and six-digit hex values', () => {
  assert.equal(normalizeChatColor('  #aAbB00 '), '#AABB00');
  for (const value of ['red', '#abc', 'url(https://example.com)', '#123456; color:red', 123, null]) assert.equal(normalizeChatColor(value), null);
  assert.deepEqual(parseChatColors({ self: '#ffffff', human: '#000000', 'own-agent': 'transparent', extra: '#aaaaaa' }), {
    ...defaultChatColors, self: '#FFFFFF', human: '#000000',
  });
  assert.deepEqual(parseChatColors(null), defaultChatColors);
});

test('all palette and custom colors remain readable across gradient, hover and code surfaces', () => {
  const hex = (value: string) => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
  const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const mix = (a: number[], b: number[], amount: number) => a.map((v, i) => v * (1 - amount) + b[i]! * amount);
  const custom: string[] = [];
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
    custom.push(`#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`);
  }
  for (const color of [...chatColorPresets.map(p => p.value), ...custom]) {
    const surface = readableChatSurface(color);
    const foreground = hex(surface.foreground);
    const hover = Number(surface.hover.match(/\/ ([\d.]+)/)![1]);
    for (const stop of [rgb(surface.start), hex(color), rgb(surface.end)]) {
      for (const background of [stop, mix(stop, [255, 255, 255], hover)]) {
        assert.ok(chatColorContrast(foreground, background) >= 4.5, `${color} contrast on ${background}`);
        const code = surface.code.includes('255') ? mix(background, [255, 255, 255], .12) : mix(background, [0, 0, 0], .1);
        assert.ok(chatColorContrast(foreground, code) >= 4.5, `${color} inline code contrast`);
      }
    }
    assert.equal(chatBubbleStyle(color)['--chat-bubble'], color.toUpperCase());
  }
});

let vite: ViteDevServer;
let Palette: any, Settings: any, useStyling: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  Palette = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/ColorPalette.vue', import.meta.url)))).default;
  Settings = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/ChatStylingSettings.vue', import.meta.url)))).default;
  useStyling = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../../shared/ui/chat-styling.ts', import.meta.url)))).useChatStyling;
});
after(async () => { await vite?.close(); });

test('color choices persist locally, synchronize between windows, and safely survive unavailable storage', async t => {
  const original = globalThis.window;
  let stored = JSON.stringify({ self: '#ddaabb', human: 'invalid' });
  let storageListener: (event: { key: string; newValue: string | null }) => void;
  let denied = false;
  Object.assign(globalThis, { window: {
    localStorage: { getItem: () => stored, setItem(_key: string, value: string) { if (denied) throw Error('Denied'); stored = value; } },
    addEventListener(type: string, listener: any) { assert.equal(type, 'storage'); storageListener = listener; },
  } });
  t.after(() => Object.assign(globalThis, { window: original }));
  const preferences = useStyling();
  assert.equal(preferences.colors.value.self, '#DDAABB');
  assert.equal(preferences.colors.value.human, defaultChatColors.human);
  preferences.setColor('own-agent', '#456789');
  assert.equal(JSON.parse(stored)['own-agent'], '#456789');
  assert.equal(preferences.styleFor('own-agent')['--chat-bubble'], '#456789');
  storageListener!({ key: 'unrelated', newValue: '{}' });
  assert.equal(preferences.colors.value.self, '#DDAABB');
  storageListener!({ key: 'letagents-chat-styling-v1', newValue: '{bad json' });
  assert.deepEqual({ ...preferences.colors.value }, defaultChatColors);
  denied = true;
  preferences.setColor('human', '#ffffff');
  assert.equal(preferences.saved.value, false);
  assert.equal(preferences.styleFor('human')['--chat-bubble'], '#FFFFFF');
  denied = false;
  preferences.reset();
  assert.equal(preferences.saved.value, true);
  assert.equal(preferences.isDefault.value, true);
});

test('palette keyboard navigation crosses rows; invalid custom input does not change the color', async () => {
  let vm: any;
  const emitted: string[] = [];
  const Component = { ...Palette, setup(props: any, context: any) {
    vm = Palette.setup(props, context);
    return vm;
  } };
  const html = await renderToString(createSSRApp({ render: () => h(Component, { modelValue: '#303030', label: 'Other humans', 'onUpdate:modelValue': (value: string) => emitted.push(value) }) }));
  assert.equal((html.match(/role="radio"/g) ?? []).length, 60);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  let focus = '', returned = 0, hidden = 0, prevented = 0;
  vm.panel.value = { querySelector: (selector: string) => ({ focus() { focus = selector; } }), hidePopover() { hidden++; } };
  vm.trigger.value = { focus() { returned++; } };
  vm.moveFocus({ key: 'ArrowDown', preventDefault() { prevented++; } });
  assert.equal(focus, '[data-index="10"]');
  vm.moveFocus({ key: 'End', preventDefault() { prevented++; } });
  assert.equal(focus, '[data-index="59"]');
  vm.moveFocus({ key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.equal(focus, '[data-index="0"]');
  assert.equal(prevented, 3);
  assert.deepEqual(emitted, [chatColorPresets[10]!.value, chatColorPresets[59]!.value, chatColorPresets[0]!.value]);
  emitted.length = 0;
  vm.draft.value = 'transparent'; vm.applyCustom();
  assert.equal(vm.invalid.value, true); assert.deepEqual(emitted, []);
  vm.draft.value = '#abcdef'; vm.applyCustom();
  assert.deepEqual(emitted, ['#ABCDEF']); assert.equal(returned, 1); assert.equal(hidden, 1);
});

test('Styling exposes all four roles with their corresponding live preview colors', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(Settings) }));
  for (const label of ['You', 'Your agents', 'Other humans', 'Other agents']) assert.ok(html.includes(label));
  assert.equal((html.match(/data-side="right"/g) ?? []).length, 2);
  assert.equal((html.match(/data-side="left"/g) ?? []).length, 2);
  assert.match(html, /--chat-bubble:#0A0A0A/);
  assert.match(html, /--chat-bubble:#1B1B1B/);
  assert.match(html, /--chat-bubble:#303030/);
  assert.match(html, /--chat-bubble:#282D34/);
});

test('desktop messages use authenticated ownership for the four colors without changing thread contracts', async t => {
  const Chat = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/DesktopChatMessage.vue')).default;
  const { setMessageReactionViewer } = await vite.ssrLoadModule('/renderer/src/composables/useRoomMessageReactions.ts');
  setMessageReactionViewer({ login: 'EmmyMay' });
  t.after(() => setMessageReactionViewer(null));
  const cases = [
    { source: 'browser', sender: 'EmmyMay', senderProfile: { login: 'EmmyMay' }, role: 'self' },
    { source: 'browser', sender: 'Ada', senderProfile: { login: 'Ada' }, role: 'human' },
    { source: 'agent', sender: 'Orbit', agentIdentity: { displayName: 'Orbit', ownerLabel: 'EmmyMay', agentKey: 'emmymay/orbit' }, role: 'own-agent' },
    { source: 'agent', sender: 'Nova', agentIdentity: { displayName: 'Nova', ownerLabel: 'Ada', agentKey: 'ada/nova' }, role: 'other-agent' },
    { source: 'browser', sender: 'EmmyMay', role: 'human' },
  ] as const;
  for (const { role, ...message } of cases) {
    const html = await renderToString(createSSRApp({ render: () => h(Chat, {
      message: { id: 'msg_99', text: 'Ready to review.', timestamp: '2026-11-15T12:00:00Z', attachments: [], ...message },
      context: 'thread-reply', threadMessageId: 'msg_99', highlightQuery: '', searchActive: false,
      threadSummary: { count: 0, unreadCount: 0, participants: [] },
    }) }));
    assert.ok(html.includes(`data-chat-role="${role}"`));
    assert.ok(html.includes(`--chat-bubble:${defaultChatColors[role]}`));
    assert.match(html, /data-thread-message-id="msg_99"/);
    assert.match(html, /aria-label="Copy message"/);
    assert.match(html, /aria-label="Jump to root"/);
  }
});
