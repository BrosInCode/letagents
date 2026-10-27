import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, effectScope, h, nextTick, reactive, ssrContextKey } from 'vue';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer, access: any, launch: any, draftModule: any, Slider: any, AccessDefault: any, Chip: any, Composer: any, entriesContext: any, controller: any;
const originals = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
const fakeDocument = Object.assign(new EventTarget(), { activeElement: null as unknown, visibilityState: 'visible' });
const storage = new Map<string, string>();
let ipc: any;
let uuid = 0;

before(async () => {
  const fakeWindow = Object.assign(new EventTarget(), {
    setTimeout: () => 0, clearTimeout: () => undefined,
    matchMedia: () => ({ matches: false }),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } },
  });
  // Each test swaps the bridge, so the window reads it at call time.
  Object.defineProperty(fakeWindow, 'letagentsDesktop', { get: () => ipc });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const base = '/renderer/src/components/desktop/content/';
  access = await vite.ssrLoadModule(`${base}room-chat/composer-agent-access.ts`);
  launch = await vite.ssrLoadModule(`${base}room-chat/composer-agent-launch.ts`);
  draftModule = await vite.ssrLoadModule(`${base}room-chat/useComposerAgentDraft.ts`);
  entriesContext = await vite.ssrLoadModule(`${base}add-agent/supervisor-entries-context.ts`);
  controller = await vite.ssrLoadModule(`${base}add-agent/useAddAgentController.ts`);
  Slider = (await vite.ssrLoadModule(`${base}room-chat/ComposerStepSlider.vue`)).default;
  AccessDefault = (await vite.ssrLoadModule(`${base}room-chat/RoomComposerAccessDefault.vue`)).default;
  Chip = (await vite.ssrLoadModule(`${base}room-chat/RoomComposerAgentChip.vue`)).default;
  Composer = (await vite.ssrLoadModule(`${base}room-chat/RoomComposer.vue`)).default;
});
after(async () => {
  await vite?.close();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); };
const key = (name: string, extra: Record<string, unknown> = {}) => {
  const event = { key: name, isComposing: false, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, defaultPrevented: false, target: null as unknown,
    preventDefault() { event.defaultPrevented = true; }, stopPropagation() {}, ...extra };
  return event;
};

function setup(component: any, props: any, t: { after: (fn: () => void) => void }, provides: Array<[unknown, unknown]> = []) {
  const events: any[] = [];
  let vm: any;
  const child = { setup() { vm = component.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div'); } };
  const app = renderer.createApp({ render: () => h(child) });
  app.provide(ssrContextKey, { modules: new Set() });
  for (const [k, value] of provides) app.provide(k as any, value);
  app.mount({});
  t.after(() => app.unmount());
  return { vm, events };
}

/* ---------- fakes ---------- */

const profile = (id: string, label: string, status = 'available', risk = 'medium') => ({ id, label, description: '', status, risk, detail: null, isDefault: false });
const PROFILES = {
  'claude-code': [profile('read_only', 'Read-only'), profile('ask_before_write', 'Ask before writes'), profile('auto_review', 'Auto', 'available', 'high'), profile('full_access', 'Full access', 'available', 'high'), profile('sandboxed_write', 'Sandboxed writes', 'unsupported')],
  codex: [profile('full_access', 'Full access', 'available', 'high'), profile('ask_before_write', 'Ask before writes'), profile('auto_review', 'Auto', 'available', 'high'), profile('read_only', 'Read-only'), profile('sandboxed_write', 'Sandboxed writes', 'unsupported')],
  'open-model': [profile('full_access', 'Full access', 'available', 'high'), profile('ask_before_write', 'Ask before writes'), profile('auto_review', 'Auto', 'available', 'high'), profile('read_only', 'Read-only', 'unsupported')],
  cursor: [profile('read_only', 'Read-only'), profile('ask_before_write', 'Ask before writes', 'unsupported'), profile('sandboxed_write', 'Workspace writes'), profile('full_access', 'Full access', 'available', 'high')],
} as Record<string, any[]>;
const provider = (id: string, name: string) => ({ id, name, description: '', capabilities: ['supervised_runtime'], runtimeCommand: null, mcpTargetId: null, permissionProfiles: PROFILES[id], defaultPermissionProfileId: null });

function fakeIpc(overrides: { preflight?: Record<string, any>; openModel?: any; createAgent?: (input: any) => Promise<any>; listAgents?: () => Promise<any[]> } = {}) {
  const calls = { create: [] as any[], preflight: [] as any[], listAgents: 0 };
  const ready = { status: 'ready', canStart: true, message: '', detail: null, nextAction: null, version: null, mcpStatus: null };
  const preflight = { 'claude-code': ready, codex: ready, 'open-model': ready, cursor: { ...ready, status: 'auth_required', canStart: false }, ...overrides.preflight };
  ipc = {
    room: { getExpressions: async () => ({ enabled: false }) },
    workers: {
      listAgentProviders: async () => [provider('claude-code', 'Claude Code'), provider('codex', 'Codex'), provider('open-model', 'Open Model'), provider('cursor', 'Cursor'), provider('antigravity', 'Antigravity')],
      runAgentProviderPreflight: async (id: string, input: any) => { calls.preflight.push([id, input]); return { providerId: id, ...preflight[id] }; },
      listAgentProviderModels: async (id: string) => ({ providerId: id, status: 'ready', defaultModel: id === 'codex' ? 'gpt-5-codex' : id === 'open-model' ? 'openai/gpt-oss-120b' : null,
        models: id === 'claude-code' ? [{ id: 'opus', label: 'Opus 5.5', source: 'known' }, { id: 'sonnet', label: 'Sonnet 5.5', source: 'known' }]
          : id === 'open-model' ? [{ id: 'openai/gpt-oss-120b', label: 'openai/gpt-oss-120b', source: 'provider', supportedEfforts: ['low', 'medium', 'high'] }, { id: 'qwen/qwen3-coder', label: 'qwen/qwen3-coder', source: 'provider' }]
            : [] }),
    },
    openModel: { getSettingsStatus: async () => overrides.openModel ?? { configured: true, hasApiKey: true, baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', savedAt: null, settingsPath: '', error: null } },
    supervisorGrant: { getStorageStatus: async () => ({ available: true, detail: '' }) },
    supervisor: {
      createAgent: async (input: any) => { calls.create.push(input); return overrides.createAgent ? overrides.createAgent(input) : { id: `supervised_${input.creationRequestId}`, displayName: 'Juniper', charter: input.charter }; },
      listAgents: async () => { calls.listAgents++; return overrides.listAgents ? overrides.listAgents() : []; },
    },
  };
  return calls;
}

function fakeHost(context: Record<string, unknown> = {}) {
  const opened: any[] = [];
  const worktrees: string[] = [];
  return {
    opened, worktrees,
    host: {
      context: () => ({ roomStorageMode: 'cloud', roomGitRoom: null, repoRootPath: '/repo/letagents', repoStatus: { rootPath: '/repo/letagents', branch: 'staging', worktrees: [] }, gitRoomMatchesActiveRepo: true, viewerLogin: 'EmmyMay', ...context }),
      openAddAgent: (options?: any) => { opened.push(options ?? {}); },
      chooseWorktree: (root: string) => { worktrees.push(root); },
    },
  };
}

function useDraft(t: any, host: any, room = { id: 'room-a' }) {
  const scope = effectScope();
  const refreshes: number[] = [];
  const draft = scope.run(() => draftModule.useComposerAgentDraft({
    roomIdentifier: () => room.id, host, supervisorEntries: { refresh: async () => { refreshes.push(1); } },
  }))!;
  t.after(() => scope.stop());
  return { draft, refreshes };
}

beforeEach(() => storage.clear());

/* ---------- access ladder ---------- */

test('access stops run from least to most permission, over only the levels a provider really has', () => {
  assert.deepEqual(access.accessStops(PROFILES.codex).map((p: any) => p.id), ['read_only', 'ask_before_write', 'auto_review', 'full_access']);
  assert.deepEqual(access.accessStops(PROFILES['open-model']).map((p: any) => p.id), ['ask_before_write', 'auto_review', 'full_access']);
  assert.deepEqual(access.accessStops(PROFILES.cursor).map((p: any) => p.id), ['read_only', 'sandboxed_write', 'full_access']);
});

test('a provider without the personal default falls back to the next safer level it has', () => {
  assert.deepEqual(access.resolveAccess(PROFILES.codex, 'auto_review'), { id: 'auto_review', fellBack: false });
  assert.deepEqual(access.resolveAccess(PROFILES.cursor, 'auto_review'), { id: 'sandboxed_write', fellBack: true });
  assert.deepEqual(access.resolveAccess(PROFILES.cursor, 'ask_before_write'), { id: 'read_only', fellBack: true });
  // Nothing safer: the least permission it has.
  assert.deepEqual(access.resolveAccess(PROFILES['open-model'], 'read_only'), { id: 'ask_before_write', fellBack: true });
  assert.equal(access.resolveAccess([], 'read_only'), null);
});

test('raising the default to a high level needs confirmation; lowering it does not', () => {
  assert.equal(access.accessChangeNeedsConfirmation('ask_before_write', 'auto_review'), true);
  assert.equal(access.accessChangeNeedsConfirmation('ask_before_write', 'full_access'), true);
  assert.equal(access.accessChangeNeedsConfirmation('full_access', 'auto_review'), false);
  assert.equal(access.accessChangeNeedsConfirmation('read_only', 'ask_before_write'), false);
});

test('the personal default is stored per person and per room, and only on this Mac', () => {
  assert.equal(access.readPersonalAccess('EmmyMay', 'room-a'), 'ask_before_write', 'the default when nothing is stored');
  access.rememberPersonalAccess('EmmyMay', 'Room-A', 'read_only');
  assert.equal(access.readPersonalAccess('emmymay', 'room-a'), 'read_only');
  assert.equal(access.readPersonalAccess('EmmyMay', 'room-b'), 'ask_before_write', 'another room keeps its own default');
  assert.equal(access.readPersonalAccess('Shannon', 'room-a'), 'ask_before_write', 'another person on this Mac keeps theirs');
  storage.set('letagents-desktop:composer-agent-access', '{"emmymay\\u0000room-a":"rm -rf"}');
  assert.equal(access.readPersonalAccess('EmmyMay', 'room-a'), 'ask_before_write', 'an unknown stored value is ignored');
  storage.set('letagents-desktop:composer-agent-access', 'not json');
  assert.equal(access.readPersonalAccess('EmmyMay', 'room-a'), 'ask_before_write');
});

test('provider checks map to chip, "Not set up" or the Add agent window', () => {
  const pf = (status: string, canStart = false, nextAction: string | null = null) => ({ status, canStart, nextAction });
  assert.deepEqual(launch.composerAgentReadiness('codex', null), { state: 'checking' });
  assert.deepEqual(launch.composerAgentReadiness('codex', pf('ready', true)), { state: 'ready' });
  assert.deepEqual(launch.composerAgentReadiness('codex', pf('auth_required')), { state: 'setup', word: 'Sign in' });
  assert.deepEqual(launch.composerAgentReadiness('claude-code', pf('missing_runtime')), { state: 'setup', word: 'Install' });
  assert.deepEqual(launch.composerAgentReadiness('open-model', pf('config_required')), { state: 'not_set_up' });
  assert.deepEqual(launch.composerAgentReadiness('open-model', pf('ready', true), { openModelConfigured: false }), { state: 'not_set_up' });
  assert.deepEqual(launch.composerAgentReadiness('codex', pf('branch_mismatch', false, 'choose_worktree')), { state: 'ready' });
});

/* ---------- chip lifecycle ---------- */

test('the submenu lists Claude, Codex and Open Model, and Cursor only once it can start', async t => {
  fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  assert.deepEqual(draft.rows.value.map((row: any) => [row.providerId, row.name]), [['claude-code', 'Claude'], ['codex', 'Codex'], ['open-model', 'Open Model']]);
  fakeIpc({ preflight: { cursor: { status: 'ready', canStart: true, nextAction: null } } });
  await draft.refreshProviders();
  assert.equal(draft.rows.value.length, 3, 'a check younger than 30 s is reused, so opening the submenu again runs no CLI probes');
  await draft.refreshProviders({ force: true });
  assert.deepEqual(draft.rows.value.map((row: any) => row.providerId), ['claude-code', 'codex', 'open-model', 'cursor']);
});

test('picking a ready provider adds a chip with the personal default; a provider that needs setup opens the window instead', async t => {
  fakeIpc({ preflight: { codex: { status: 'auth_required', canStart: false, nextAction: 'authenticate' } } });
  access.rememberPersonalAccess('EmmyMay', 'room-a', 'read_only');
  const { host, opened } = fakeHost();
  const { draft } = useDraft(t, host);
  await draft.refreshProviders();
  assert.equal(draft.rows.value.find((row: any) => row.providerId === 'codex').hint, 'Sign in');

  assert.equal(draft.pick('codex'), 'setup');
  assert.deepEqual(opened, [{ providerId: 'codex' }]);
  assert.equal(draft.chip.value, null);

  assert.equal(draft.pick('claude-code'), 'chip');
  assert.equal(draft.chip.value.providerId, 'claude-code');
  assert.equal(draft.chip.value.access, 'read_only');
  assert.equal(draft.chip.value.model, null, 'the provider default until a model is chosen');
  await flush();
  assert.deepEqual(draft.chipModels.value.map((m: any) => m.label), ['Default', 'Opus 5.5', 'Sonnet 5.5'], 'the real catalog, title only');
  assert.deepEqual(draft.chipEfforts.value, [], 'supervised Claude takes no effort, as in the Add agent window');

  draft.removeChip();
  assert.equal(draft.chip.value, null);
});

test('Codex has an effort scale of Default plus its real levels', async t => {
  fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('codex');
  assert.deepEqual(draft.chipEfforts.value.map((e: any) => e.label), ['Default', 'Low', 'Medium', 'High', 'Extra high']);
  assert.deepEqual(draft.chipAccessStops.value.map((p: any) => p.label), ['Read-only', 'Ask before writes', 'Auto', 'Full access']);
});

test('a new personal default moves a chip the person has not changed, never one they set', async t => {
  fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('codex');
  assert.equal(draft.chip.value.access, 'ask_before_write');
  draft.setPersonalAccess('full_access');
  assert.equal(draft.chip.value.access, 'full_access');
  assert.equal(access.readPersonalAccess('EmmyMay', 'room-a'), 'full_access', 'stored for this person and room');
  draft.setAccess('read_only');
  draft.setPersonalAccess('auto_review');
  assert.equal(draft.chip.value.access, 'read_only');
});

test('the chip falls back to a safer level when the provider lacks the personal default', async t => {
  fakeIpc({ preflight: { cursor: { status: 'ready', canStart: true, nextAction: null } } });
  access.rememberPersonalAccess('EmmyMay', 'room-a', 'auto_review');
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('cursor');
  assert.equal(draft.chip.value.access, 'sandboxed_write');
  assert.equal(draft.chip.value.fellBack, true);
});

test('a chip belongs to its room: switching rooms removes it', async t => {
  fakeIpc();
  const room = reactive({ id: 'room-a' });
  const { draft } = useDraft(t, fakeHost().host, room);
  await draft.refreshProviders();
  draft.pick('codex');
  room.id = 'room-b';
  await flush();
  assert.equal(draft.chip.value, null);
});

/* ---------- launch on Enter ---------- */

test('Enter starts the agent through the supervised create, with the draft as its first message', async t => {
  const calls = fakeIpc();
  const { draft, refreshes } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('codex');
  draft.setModel('gpt-5');
  draft.setEffort('high');
  draft.setAccess('auto_review');
  const result = await draft.launch('  Fix the flaky login test  ');
  assert.equal(result.outcome, 'started');
  assert.equal(calls.create.length, 1);
  const input = calls.create[0];
  assert.equal(input.providerId, 'codex');
  assert.equal(input.roomIdentifier, 'room-a');
  assert.equal(input.charter, 'Fix the flaky login test');
  assert.equal(input.permissionProfileId, 'auto_review');
  assert.equal(input.model, 'gpt-5');
  assert.equal(input.reasoningEffort, 'high');
  assert.equal(input.repoRootPath, '/repo/letagents');
  assert.equal(input.displayName, '', 'the daemon names the agent');
  assert.match(input.creationRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(draft.chip.value, null, 'the chip is spent');
  assert.equal(refreshes.length, 1, 'the room shell reads the new entry');
  const preflight = calls.preflight.at(-1);
  assert.deepEqual([preflight[0], preflight[1].permissionProfileId, preflight[1].model], ['codex', 'auto_review', 'gpt-5'], 'checked again with the final choices');
});

test('Claude gets the same launch policy the Add agent window sends, and no effort', async t => {
  const calls = fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('claude-code');
  draft.setAccess('read_only');
  await draft.launch('Review the PR');
  const input = calls.create[0];
  assert.equal(input.reasoningEffort ?? null, null);
  assert.deepEqual(input.launchPolicy, (await vite.ssrLoadModule('/renderer/src/domain/managed-agents.ts')).supervisedProviderLaunchPolicy('claude-code', 'read_only'));
});

test('a failed start keeps the chip, says why, and the retry uses a new id', async t => {
  let fail = true;
  const calls = fakeIpc({ createAgent: async (input) => { if (fail) throw new Error('daemon unavailable'); return { id: `supervised_${input.creationRequestId}`, charter: input.charter }; } });
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('codex');
  const first = await draft.launch('Ship it');
  assert.equal(first.outcome, 'blocked');
  assert.ok(draft.chip.value, 'the chip stays');
  assert.match(draft.notice.value, /Couldn't start Codex/);
  assert.equal(calls.listAgents, 1, 'it checks whether the agent was saved anyway');
  fail = false;
  assert.equal((await draft.launch('Ship it')).outcome, 'started');
  assert.notEqual(calls.create[0].creationRequestId, calls.create[1].creationRequestId);
});

test('a start that failed after the agent was saved counts as started', async t => {
  let saved: any = null;
  fakeIpc({
    createAgent: async (input) => { saved = { id: `supervised_${input.creationRequestId}`, charter: input.charter }; throw new Error('timeout'); },
    listAgents: async () => [saved],
  });
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('codex');
  const result = await draft.launch('Ship it');
  assert.equal(result.outcome, 'started');
  assert.equal(result.entry, saved);
});

test('when the check on Enter finds sign-in missing, the chip stays, says why, and only the button opens the window', async t => {
  const calls = fakeIpc();
  const { host, opened } = fakeHost();
  const { draft } = useDraft(t, host);
  await draft.refreshProviders();
  draft.pick('claude-code');
  ipc.workers.runAgentProviderPreflight = async (id: string) => ({ providerId: id, status: 'auth_required', canStart: false, message: 'Claude Code needs sign-in.', detail: null, nextAction: 'authenticate' });
  assert.equal((await draft.launch('Hello')).outcome, 'blocked');
  assert.deepEqual(opened, [], 'Enter never opens the Add agent window');
  assert.equal(calls.create.length, 0);
  assert.ok(draft.chip.value, 'the chip stays');
  assert.match(draft.notice.value, /^Claude can't start yet\. Claude Code needs sign-in\. Your message is still here\.$/);
  assert.equal(draft.noticeAction.value, 'setup');
  await draft.runNoticeAction();
  assert.deepEqual(opened, [{ providerId: 'claude-code' }]);
});

test('a check that only needs repeating offers Check again, which refreshes and says when it is ready', async t => {
  fakeIpc();
  const { host, opened } = fakeHost();
  const { draft } = useDraft(t, host);
  await draft.refreshProviders();
  draft.pick('claude-code');
  const inputs: any[] = [];
  let ready = false;
  ipc.workers.runAgentProviderPreflight = async (id: string, input: any) => {
    inputs.push(input);
    return ready ? { providerId: id, status: 'ready', canStart: true, message: 'ok', detail: null, nextAction: null }
      : { providerId: id, status: 'config_required', canStart: false, message: 'Agent setup needs refreshing.', detail: 'Choose Check again to apply the current provider environment.', nextAction: null };
  };
  assert.equal((await draft.launch('Hello')).outcome, 'blocked');
  assert.match(draft.notice.value, /Choose Check again to apply the current provider environment\./);
  assert.equal(draft.noticeAction.value, 'check-again');
  ready = true;
  await draft.runNoticeAction();
  assert.equal(inputs.at(-1).refreshEnvironment, true);
  assert.match(draft.notice.value, /^Claude is ready\. Press Enter to start it\.$/);
  assert.equal(draft.noticeAction.value, null);
  assert.deepEqual(opened, []);
});

test('a chosen Claude model is checked against the known list, not as a provider model', async t => {
  const calls = fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('claude-code');
  await flush();
  draft.setModel('opus');
  await draft.launch('Hello');
  const [, input] = calls.preflight.at(-1)!;
  assert.equal(input.model, 'opus');
  assert.equal(input.modelSource, 'known');
  draft.pick('claude-code');
  draft.setModel('claude-old-id');
  await draft.launch('Hello');
  assert.equal(calls.preflight.at(-1)![1].modelSource, 'custom', 'an id the list no longer has passes as custom');
});

test('a project room with no local project explains instead of starting', async t => {
  const calls = fakeIpc();
  const { host } = fakeHost({ repoRootPath: null, roomGitRoom: { ref: { type: 'branch', name: 'x' } } });
  const { draft } = useDraft(t, host);
  await draft.refreshProviders();
  draft.pick('codex');
  assert.equal((await draft.launch('Hello')).outcome, 'blocked');
  assert.match(draft.notice.value, /Connect this room to its local project/);
  assert.equal(calls.create.length, 0);
});

/* ---------- Open Model gating ---------- */

test('Open Model is always a chip, says "Not set up", and Enter is blocked calmly until it is configured', async t => {
  const calls = fakeIpc({ openModel: { configured: false, baseUrl: '', model: '', error: null } });
  const { host, opened } = fakeHost();
  const { draft } = useDraft(t, host);
  await draft.refreshProviders();
  const row = draft.rows.value.find((r: any) => r.providerId === 'open-model');
  assert.equal(row.detail, 'Not set up');
  assert.equal(draft.pick('open-model'), 'chip', 'a chip even before setup');
  assert.equal(opened.length, 0);
  await flush();
  assert.equal(draft.chipReadiness.value.state, 'not_set_up');
  assert.deepEqual(draft.chipModels.value, [], 'no model rows before setup');
  assert.equal((await draft.launch('Summarise the thread')).outcome, 'blocked');
  assert.equal(draft.notice.value, 'Configure Open Model before this agent can start. Your message is still here.');
  assert.equal(calls.create.length, 0);

  // After setup in the Add agent window, the same chip starts.
  ipc.openModel.getSettingsStatus = async () => ({ configured: true, baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', error: null });
  assert.equal((await draft.launch('Summarise the thread')).outcome, 'started');
  assert.equal(calls.create[0].providerId, 'open-model');
  assert.equal(calls.create[0].reasoningEffort ?? null, null, 'a model without listed efforts sends none');
});

/* ---------- stepped slider ---------- */

function mountSlider(t: any, index = 0) {
  const props = reactive({ kind: 'access', label: 'Access', stops: ['Read-only', 'Ask before writes', 'Auto', 'Full access'], index, note: null });
  const mounted = setup(Slider, props, t);
  mounted.vm.track.value = { getBoundingClientRect: () => ({ left: 100, width: 300 }) };
  mounted.vm.control.value = { focus() {}, setPointerCapture() {} };
  return { ...mounted, props };
}

test('the slider follows a drag 1:1, then snaps to the nearest stop on release', t => {
  const { vm, events } = mountSlider(t);
  const pointer = (clientX: number) => ({ button: 0, clientX, pointerId: 1, preventDefault() {} });
  vm.startDrag(pointer(100));
  vm.moveDrag(pointer(240));
  assert.ok(Math.abs(vm.position.value - 1.4) < 1e-9, 'the thumb sits between stops while dragging');
  assert.equal(vm.shownIndex.value, 1);
  vm.moveDrag(pointer(260));
  assert.equal(vm.shownIndex.value, 2, 'the label follows the nearest stop');
  vm.endDrag(pointer(260));
  assert.equal(vm.dragging.value, false);
  assert.deepEqual(events, [['update:index', 2]]);
});

test('a click on the track picks that stop; cancel restores the value', t => {
  const { vm, events } = mountSlider(t, 1);
  const pointer = (clientX: number) => ({ button: 0, clientX, pointerId: 1, preventDefault() {} });
  vm.startDrag(pointer(400));
  vm.endDrag(pointer(400));
  assert.deepEqual(events.at(-1), ['update:index', 3]);
  vm.startDrag(pointer(100));
  vm.cancelDrag();
  assert.equal(vm.position.value, 1);
  assert.equal(events.length, 1);
});

test('←/→ step, Home and End jump, and ↑/↓ are left to the menu', t => {
  const { vm, events, props } = mountSlider(t, 1);
  vm.handleKey(key('ArrowRight'));
  assert.deepEqual(events.at(-1), ['update:index', 2]);
  props.index = 2;
  vm.handleKey(key('ArrowLeft'));
  assert.deepEqual(events.at(-1), ['update:index', 1]);
  vm.handleKey(key('End'));
  assert.deepEqual(events.at(-1), ['update:index', 3]);
  vm.handleKey(key('Home'));
  assert.deepEqual(events.at(-1), ['update:index', 0]);
  props.index = 3;
  const count = events.length;
  vm.handleKey(key('ArrowRight'));
  assert.equal(events.length, count, 'no change past the last stop');
  const down = key('ArrowDown');
  vm.handleKey(down);
  assert.equal(down.defaultPrevented, false);
});

/* ---------- personal access selector ---------- */

test('the access selector applies a lower level at once and asks before a higher one', t => {
  const props = reactive({ modelValue: 'ask_before_write', roomHandle: '#letagents' });
  const { vm, events } = setup(AccessDefault, props, t);
  vm.choose('read_only');
  assert.deepEqual(events.at(-2), ['update:modelValue', 'read_only']);
  vm.choose('full_access');
  assert.equal(vm.confirming.value.id, 'full_access', 'asks first');
  assert.equal(events.filter((e: any) => e[0] === 'update:modelValue').length, 1);
  vm.cancelConfirm();
  assert.equal(vm.confirming.value, null);
  vm.choose('full_access');
  vm.apply('full_access');
  assert.deepEqual(events.filter((e: any) => e[0] === 'update:modelValue').at(-1), ['update:modelValue', 'full_access']);
  const source = readFileSync(new URL('../src/components/desktop/content/room-chat/RoomComposerAccessDefault.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /New agents:/, 'shield and level only');
});

/* ---------- chip popover ---------- */

test('the chip shows no risk pills or descriptions, except Open Model Auto\'s one line', t => {
  const props = reactive({
    chip: { id: 1, providerId: 'open-model', model: 'qwen/qwen3-coder', effort: '', access: 'auto_review', accessChosen: false, fellBack: false },
    providerName: 'Open Model', readiness: { state: 'ready' }, models: [{ id: 'qwen/qwen3-coder', label: 'qwen/qwen3-coder' }], efforts: [],
    accessStops: PROFILES['open-model'].filter((p: any) => p.status === 'available'), worksIn: 'letagents · staging', worktrees: [], repoRootPath: '/repo',
    openModelHost: 'openrouter.ai', launching: false, coachVisible: false, wantedAccessLabel: 'Ask before writes',
  });
  const { vm } = setup(Chip, props, t);
  assert.equal(vm.accessNote.value, 'LetAgents and Jev review each command before it runs. Routine commands and project edits run without asking.');
  assert.equal(vm.spec.value, 'qwen/qwen3-coder · Auto');
  props.chip = { ...props.chip, access: 'full_access' };
  assert.equal(vm.accessNote.value, null);
  props.chip = { ...props.chip, providerId: 'codex', access: 'auto_review' };
  assert.equal(vm.accessNote.value, null, 'only Open Model\'s own Auto has a line');
  const source = readFileSync(new URL('../src/components/desktop/content/room-chat/RoomComposerAgentChip.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /risk/i, 'no risk labels');
  assert.doesNotMatch(source, /@(pointerenter|mouseenter|mouseover|pointerover)=/, 'hover never opens anything');
});

test('number keys choose a model without closing the popover; Escape closes it', async t => {
  const props = reactive({
    chip: { id: 2, providerId: 'claude-code', model: null, effort: '', access: 'read_only', accessChosen: false, fellBack: false },
    providerName: 'Claude', readiness: { state: 'ready' }, models: [{ id: null, label: 'Default' }, { id: 'opus', label: 'Opus 5.5' }], efforts: [],
    accessStops: [], worksIn: '', worktrees: [], repoRootPath: null, openModelHost: null, launching: false, coachVisible: true, wantedAccessLabel: null,
  });
  const { vm, events } = setup(Chip, props, t);
  vm.toggle({ detail: 0 });
  assert.equal(vm.open.value, true);
  assert.deepEqual(events.at(-1), ['opened']);
  assert.ok(events.some((e: any) => e[0] === 'coach-dismissed'), 'opening the chip retires the coach hint');
  vm.menu.value = { querySelectorAll: () => [], contains: () => true };
  vm.handleMenuKey(key('2', { target: {} }));
  assert.deepEqual(events.at(-1), ['set-model', 'opus']);
  assert.equal(vm.open.value, true, 'choosing does not close it');
  vm.handleMenuKey(key('Tab', { target: {} }));
  assert.equal(vm.open.value, true, 'Tab does not close it');
  vm.handleMenuKey(key('Escape', { target: {} }));
  assert.equal(vm.open.value, false);
  assert.deepEqual(events.at(-1), ['dismiss']);
});

/* ---------- composer wiring ---------- */

let sequence = 0;
function mountComposer(t: any, host: any) {
  const props = reactive({ attaching: false, attachmentDrafts: [] as any[], attachmentError: null, eventPreviews: [], messageNamespace: `inline-agent-${++sequence}`,
    participants: [], pendingAttachmentDrafts: [] as any[], replyTo: null, roomIdentifier: 'room-a', roomLabel: 'letagents', roomLoading: false, sendError: null, sending: false });
  const refreshes: number[] = [];
  const mounted = setup(Composer, props, t, [[launch.composerAgentLaunchKey, host], [entriesContext.supervisorEntriesKey, { refresh: async () => { refreshes.push(1); } }]]);
  return { ...mounted, props, refreshes };
}

test('with a chip, Enter launches the agent instead of posting, and clears the draft only once it started', async t => {
  const calls = fakeIpc();
  const { vm, events } = mountComposer(t, fakeHost().host);
  await vm.agentDraft.refreshProviders();
  vm.pickAgent('codex', null);
  assert.equal(vm.agentCoachVisible.value, true, 'the coach hint shows the first time');
  assert.equal(vm.sendLabel.value, 'Start agent with this message');
  vm.draft.value = 'Fix the flaky login test';
  await vm.submitMessage();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].charter, 'Fix the flaky login test');
  assert.equal(events.some((e: any) => e[0] === 'send-message'), false, 'no plain room post: the first message reaches the agent privately');
  assert.equal(vm.draft.value, '');
  assert.equal(vm.agentChip.value, null);
});

test('a failed launch keeps the draft and the chip', async t => {
  fakeIpc({ createAgent: async () => { throw new Error('nope'); } });
  const { vm, events } = mountComposer(t, fakeHost().host);
  await vm.agentDraft.refreshProviders();
  vm.pickAgent('codex', null);
  vm.draft.value = 'Keep me';
  await vm.submitMessage();
  assert.equal(vm.draft.value, 'Keep me');
  assert.ok(vm.agentChip.value);
  assert.match(vm.agentNotice.value, /Couldn't start Codex/);
  assert.equal(events.some((e: any) => e[0] === 'send-message'), false);
  vm.draft.value = 'Keep me, edited';
  await flush();
  assert.equal(vm.agentNotice.value, null, 'the notice goes once the draft changes');
});

test('attachments cannot ride on a first message', async t => {
  const calls = fakeIpc();
  const { vm, props } = mountComposer(t, fakeHost().host);
  await vm.agentDraft.refreshProviders();
  vm.pickAgent('codex', null);
  props.attachmentDrafts = [{ uploadId: 'u1' }];
  vm.draft.value = 'With a file';
  await flush();
  await vm.submitMessage();
  assert.equal(calls.create.length, 0);
  assert.match(vm.agentNotice.value, /text only/);
});

test('"Don\'t show again" keeps the coach hint away for the next chip', async t => {
  fakeIpc();
  const { vm } = mountComposer(t, fakeHost().host);
  await vm.agentDraft.refreshProviders();
  vm.pickAgent('codex', null);
  vm.dismissAgentCoach(true);
  vm.removeAgentChip();
  vm.pickAgent('claude-code', null);
  assert.equal(vm.agentCoachVisible.value, false);
});

test('without a launch host the composer keeps the plain Add agent window', t => {
  fakeIpc();
  const props = reactive({ attaching: false, attachmentDrafts: [], attachmentError: null, eventPreviews: [], messageNamespace: `inline-agent-${++sequence}`,
    participants: [], pendingAttachmentDrafts: [], replyTo: null, roomIdentifier: 'room-a', roomLabel: 'letagents', roomLoading: false, sendError: null, sending: false });
  const { vm, events } = setup(Composer, props, t);
  assert.equal(vm.agentHost, null);
  vm.handleAddMenuSelect('agent');
  assert.deepEqual(events.at(-1), ['open-add-agent']);
});

/* ---------- "First message · <name>" in the timeline ---------- */

test('the first message shows in its starter\'s timeline at the agent\'s start time, never the window\'s generic one', async () => {
  const timeline = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/timeline.ts');
  const { defaultSupervisedCharter } = await vite.ssrLoadModule('/renderer/src/components/desktop/content/add-agent/useAddAgentConfiguration.ts');
  const message = (id: string, timestamp: string) => ({ id, sender: 'EmmyMay', text: id, attachments: [], agentPromptKind: null, source: 'browser', timestamp, actorLabel: null, agentIdentity: null, threadRootId: id, threadReplyToId: null, thread: null });
  const agent = (id: string, createdAt: string, charter: string, createdBy = 'desktop') => ({ id, displayName: 'Juniper', charter, createdAt, createdBy });
  const messages = [message('m1', '2026-10-26T09:00:00Z'), message('m2', '2026-10-26T09:10:00Z')];
  const agents = [
    agent('a-new', '2026-10-26T09:05:00Z', 'Fix the flaky test'),
    agent('a-generic', '2026-10-26T09:06:00Z', defaultSupervisedCharter),
    agent('a-old', '2026-10-26T08:00:00Z', 'Older than the loaded page'),
    agent('a-rental', '2026-10-26T09:07:00Z', 'Rented', 'server'),
  ];
  assert.deepEqual(timeline.firstMessageAgents(agents, messages, true).map((a: any) => a.id), ['a-new']);
  assert.deepEqual(timeline.firstMessageAgents(agents, messages, false).map((a: any) => a.id), ['a-new', 'a-old'], 'with the whole history loaded, an older start belongs at its place');
  const entries = timeline.buildMessageTimelineEntries(messages, [], [], [], [agents[0]]).filter((e: any) => e.type !== 'date');
  assert.deepEqual(entries.map((e: any) => e.id), ['m1', 'first-message:a-new', 'm2']);
});

/* ---------- review follow-ups ---------- */

test('a second Enter while the first launch runs starts nothing more', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls = fakeIpc({ openModel: { configured: false, baseUrl: '', model: '', error: null } });
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  ipc.openModel.getSettingsStatus = async () => { await gate; return { configured: true, baseUrl: 'https://openrouter.ai/api/v1', model: 'm', error: null }; };
  draft.pick('open-model');
  const first = draft.launch('Go');
  const second = await draft.launch('Go');
  assert.equal(second.outcome, 'blocked', 'refused at once, before any await');
  release();
  assert.equal((await first).outcome, 'started');
  assert.equal(calls.create.length, 1);
});

test('leaving the room during the checks cancels the start and keeps the draft for that room', async t => {
  const calls = fakeIpc();
  const room = reactive({ id: 'room-a' });
  const { draft } = useDraft(t, fakeHost().host, room);
  await draft.refreshProviders();
  draft.pick('codex');
  const original = ipc.workers.runAgentProviderPreflight;
  ipc.workers.runAgentProviderPreflight = async (id: string, input: any) => { room.id = 'room-b'; return original(id, input); };
  assert.equal((await draft.launch('Go')).outcome, 'blocked');
  assert.equal(calls.create.length, 0);
});

test('locked secure storage blocks the start with its own explanation', async t => {
  const calls = fakeIpc();
  ipc.supervisorGrant.getStorageStatus = async () => ({ available: false, detail: 'Unlock your login Keychain, then try again.' });
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('codex');
  assert.equal((await draft.launch('Go')).outcome, 'blocked');
  assert.equal(draft.notice.value, 'Unlock your login Keychain, then try again.');
  assert.equal(calls.create.length, 0);
});

test('a local room skips the secure-storage check, as the window does', async t => {
  const calls = fakeIpc();
  ipc.supervisorGrant.getStorageStatus = async () => { throw new Error('must not be read'); };
  const { draft } = useDraft(t, fakeHost({ roomStorageMode: 'local' }).host);
  await draft.refreshProviders();
  draft.pick('codex');
  assert.equal((await draft.launch('Go')).outcome, 'started');
  assert.equal(calls.create.length, 1);
});

test('an access level the provider lacks never reaches the create', async t => {
  const calls = fakeIpc({ preflight: { cursor: { status: 'ready', canStart: true, nextAction: null } } });
  const context: any = { repoRootPath: '/repo/letagents' };
  const { draft } = useDraft(t, fakeHost(context).host);
  await draft.refreshProviders();
  draft.pick('codex');
  draft.setAccess('sandboxed_write');
  assert.equal(draft.chip.value.access, 'ask_before_write', 'a level outside the stops is ignored');
  draft.pick('cursor');
  draft.setAccess('sandboxed_write');
  assert.equal(draft.chip.value.access, 'sandboxed_write');
  // The project disconnects: Cursor's workspace writes are no longer available here.
  context.repoRootPath = null;
  context.roomGitRoom = null;
  assert.equal((await draft.launch('Go')).outcome, 'blocked');
  assert.match(draft.notice.value, /can't start with that access here/);
  assert.equal(calls.create.length, 0);
});

test('an unreadable Open Model status says so, instead of asking to configure it', async t => {
  fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  ipc.openModel.getSettingsStatus = async () => { throw new Error('EACCES'); };
  draft.pick('open-model');
  await flush();
  assert.equal((await draft.launch('Go')).outcome, 'blocked');
  assert.match(draft.notice.value, /Couldn't read the Open Model settings/);
});

test('the Add agent submenu toggles on its row, goes back with ← or Esc, and picks with a number key', async t => {
  const Menu = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/RoomComposerAddMenu.vue')).default;
  const rows = [{ providerId: 'claude-code', name: 'Claude', detail: 'Default', hint: '', readiness: { state: 'ready' } }, { providerId: 'codex', name: 'Codex', detail: 'Default', hint: '', readiness: { state: 'ready' } }];
  const props = reactive({ disabled: false, attachDisabled: false, gifAvailable: false, gifDisabled: false, agentRows: rows });
  const { vm, events } = setup(Menu, props, t);
  const fake = (attrs: Record<string, string>) => { const item: any = { dataset: attrs, disabled: false, focus() { fakeDocument.activeElement = item; }, getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }) }; return item; };
  const mainItems = ['attach', 'task', 'agent'].map(id => fake({ item: id }));
  const flyItems = [fake({ agent: 'back' }), fake({ agent: 'claude-code' }), fake({ agent: 'codex' }), fake({ agent: 'setup' })];
  vm.toggle({ detail: 1 });
  vm.menu.value = { querySelectorAll: () => mainItems, contains: (n: unknown) => mainItems.includes(n) };
  vm.agentMenu.value = { querySelectorAll: () => flyItems, contains: (n: unknown) => flyItems.includes(n) };
  const agentItem = vm.items.value.find((i: any) => i.id === 'agent');
  vm.choose(agentItem);
  assert.equal(vm.agentMenuOpen.value, true);
  assert.deepEqual(events.at(-1), ['agent-menu-opened']);
  vm.choose(agentItem);
  assert.equal(vm.agentMenuOpen.value, false, 'a second click closes the submenu');
  assert.equal(vm.open.value, true, 'and keeps the "+" menu open');
  vm.choose(agentItem);
  vm.handleAgentMenuKey(key('ArrowLeft', { target: flyItems[1] }));
  assert.equal(vm.agentMenuOpen.value, false);
  vm.choose(agentItem);
  vm.handleAgentMenuKey(key('Escape', { target: flyItems[1] }));
  assert.equal(vm.agentMenuOpen.value, false, 'Escape goes back one level');
  assert.equal(vm.open.value, true);
  vm.choose(agentItem);
  vm.handleAgentMenuKey(key('Tab', { target: flyItems[1] }));
  assert.equal(vm.agentMenuOpen.value, true, 'Tab does not close it');
  vm.handleAgentMenuKey(key('2', { target: flyItems[1] }));
  assert.equal(vm.open.value, false);
  assert.deepEqual(events.at(-1).slice(0, 2), ['select-agent', 'codex']);
  vm.toggle({ detail: 1 });
  vm.choose(agentItem);
  vm.root.value = { contains: (n: unknown) => mainItems.includes(n) || flyItems.includes(n) };
  vm.closeOnOutsidePointer({ target: flyItems[2] });
  assert.equal(vm.agentMenuOpen.value, true, 'a click inside the submenu keeps it open');
  vm.closeOnOutsidePointer({ target: { outside: true } });
  assert.equal(vm.open.value, false);
  assert.equal(vm.agentMenuOpen.value, false, 'a click outside closes both');
});

test('Open Model shows Default plus the model\'s listed efforts, none for a model without them, and a model change resets an unsupported effort', async t => {
  const calls = fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  ipc.openModel.getSettingsStatus = async () => ({ configured: true, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b', error: null });
  draft.pick('open-model');
  await flush();
  // The saved model (gpt-oss-120b) lists low, medium and high.
  assert.deepEqual(draft.chipEfforts.value.map((e: any) => e.label), ['Default', 'Low', 'Medium', 'High']);
  draft.setEffort('high');
  draft.setModel('qwen/qwen3-coder');
  await flush();
  assert.deepEqual(draft.chipEfforts.value, [], 'no slider for a model that lists no efforts');
  assert.equal(draft.chip.value.effort, '', 'the unsupported effort goes back to Default');
  draft.setModel('openai/gpt-oss-120b');
  await flush();
  draft.setEffort('medium');
  assert.equal((await draft.launch('Summarise the thread')).outcome, 'started');
  assert.equal(calls.create[0].providerId, 'open-model');
  assert.equal(calls.create[0].model, 'openai/gpt-oss-120b');
  assert.equal(calls.create[0].reasoningEffort, 'medium');
});

test('an effort the model does not list never reaches the create', async t => {
  const calls = fakeIpc();
  const { draft } = useDraft(t, fakeHost().host);
  await draft.refreshProviders();
  draft.pick('open-model');
  await flush();
  draft.setModel('qwen/qwen3-coder');
  draft.setEffort('xhigh');
  assert.equal((await draft.launch('Go')).outcome, 'started');
  assert.equal(calls.create[0].reasoningEffort, null);
});
