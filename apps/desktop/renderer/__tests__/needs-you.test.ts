import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import { useNeedsYou } from '../src/composables/useNeedsYou';
import { createKnowledgeRecord } from '../../../../shared/room-knowledge.mjs';
import type { DesktopNeedsYou } from '../../electron/ipc-types/knowledge.js';

const record = createKnowledgeRecord('room', 'attention', { client_id: 'request-0001', category: 'decision', title: 'Choose a launch audience', body: '<script>malicious()</script>', recommendation: 'Small product teams', unblocks: 'Onboarding copy' }, { id: 'worker', label: 'Research agent', kind: 'agent' });
const data: DesktopNeedsYou = { rooms: [{ roomIdentifier: 'room', displayName: 'Product launch', records: [record], tasks: [], truncated: false }], failures: [], limited: false, signedOut: false, cloudUnavailable: false };
test('Needs you presents a human decision with context and escapes agent content', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/NeedsYouView.vue')).default;
    const html = await renderToString(createSSRApp(component, { data, loading: false, error: '' }));
    assert.match(html, /Choose a launch audience/); assert.match(html, /Small product teams/); assert.match(html, /Onboarding copy/); assert.match(html, /Your response/);
    assert.match(html, /&lt;script&gt;malicious/); assert.doesNotMatch(html, /<script>malicious/);
    const unavailable = await renderToString(createSSRApp(component, { data: { ...data, rooms: [], failures: [{ roomIdentifier: 'room', displayName: 'Product launch' }] }, loading: false, error: '' }));
    assert.match(unavailable, /Some rooms still need checking/); assert.doesNotMatch(unavailable, /You’re clear for now/);
  } finally { await vite.close(); }
});
test('account reset rejects old in-flight inbox reads and clears private cached content', async () => {
  const priorWindow = globalThis.window;
  const pending: Array<(value: DesktopNeedsYou) => void> = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { room: { getNeedsYou: () => new Promise(resolve => pending.push(resolve)) } } } });
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  let inbox!: ReturnType<typeof useNeedsYou>;
  const app = renderer.createApp({ setup() { inbox = useNeedsYou(); return () => null; } }); app.mount({});
  try {
    const old = inbox.refresh(); inbox.reset();
    const current = inbox.refresh();
    pending[0](data); await old;
    assert.equal(inbox.data.value, null); assert.equal(inbox.loading.value, true);
    pending[1]({ ...data, rooms: [] }); await current;
    assert.equal(inbox.count.value, 0); assert.equal(inbox.loading.value, false);
    inbox.reset(); assert.equal(inbox.data.value, null);
  } finally { app.unmount(); Object.assign(globalThis, { window: priorWindow }); }
});
