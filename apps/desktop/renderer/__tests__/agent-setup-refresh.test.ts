import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp, h, markRaw, nextTick, reactive, ref, ssrContextKey } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer, type ViteDevServer } from 'vite';
import { listManagedAgentPermissionProfiles, defaultManagedAgentPermissionProfileId } from '#provider-runtime/agents/managed-agent-permission-profiles.js';
import { managedAgentEffortOptionsForProvider } from '../src/components/desktop/content/add-agent/useAddAgentPresentation';
import { useAgentSetupPresentation } from '../src/components/desktop/content/add-agent/useAgentSetupPresentation';
import { composerIdentityPosition } from '../src/components/desktop/content/room-chat/composer-identity-position';
import { supervisedPermissionProfilePresentation } from '../src/domain/managed-agents';

let vite: ViteDevServer;
let Effort: any, Access: any, Identity: any;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  const component = async (name: string) => (await vite.ssrLoadModule(fileURLToPath(new URL(`../../../../shared/ui/agent-identity/${name}.vue`, import.meta.url)))).default;
  [Effort, Access, Identity] = await Promise.all(['AgentEffortControl', 'AgentAccessControl', 'AgentIdentityPicker'].map(component));
});
after(async () => { await vite?.close(); });

async function setupComponent(Component: any, initial: Record<string, unknown>, render = true) {
  const props = reactive(initial);
  const events: Array<{ name: string; value: any }> = [];
  let vm: any;
  const wrapper = { ...Component, setup(input: any, context: any) {
    // SSR renders once; provide the same controlled reactive props for later
    // interactions that a mounted parent's v-model would update.
    Object.assign(props, input);
    vm = Component.setup(props, { ...context, emit(name: string, value: unknown) {
      events.push({ name, value });
      if (name === 'update:modelValue') props.modelValue = value;
    } });
    return vm;
  }, ...(!render ? { ssrRender() {} } : {}) };
  const html = await renderToString(createSSRApp({ render: () => h(wrapper, props) }));
  return { vm, props, events, html };
}

const radios = (html: string) => html.match(/<button\b[^>]*role="radio"[^>]*>[\s\S]*?<\/button>/g) ?? [];
function key(value: string) {
  let prevented = 0;
  return { event: { key: value, preventDefault() { prevented++; } } as KeyboardEvent, prevented: () => prevented };
}

test('effort control uses the supplied provider choices at three, four, five and six stops without changing default effort', async () => {
  const cases = [
    { provider: 'open-model', efforts: ['low', 'high'], labels: ['Default', 'Low', 'High'] },
    { provider: 'open-model', efforts: ['low', 'medium', 'high'], labels: ['Default', 'Low', 'Medium', 'High'] },
    { provider: 'codex', labels: ['Default', 'Low', 'Medium', 'High', 'Extra high'] },
    { provider: 'claude-code', labels: ['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max'] },
  ];
  for (const entry of cases) {
    const actualOptions = managedAgentEffortOptionsForProvider(entry.provider as never, entry.efforts
      ? { id: 'provider-model', label: 'Provider model', source: 'provider', supportedEfforts: entry.efforts as never }
      : null);
    const options = [{ value: '', label: 'Default' }, ...actualOptions];
    const result = await setupComponent(Effort, { modelValue: '', options });
    assert.deepEqual(radios(result.html).map(button => button.match(/>([^<]+)<\/button>/)![1]), entry.labels);
    assert.equal(radios(result.html).filter(button => button.includes('aria-checked="true"')).length, 1);
    assert.equal(radios(result.html).filter(button => button.includes('tabindex="0"')).length, 1);
    assert.deepEqual(result.events, [], `${entry.provider}: rendering must not choose an effort`);
    assert.equal(result.props.modelValue, '');
  }
  assert.deepEqual(managedAgentEffortOptionsForProvider('cursor'), []);
  assert.deepEqual(managedAgentEffortOptionsForProvider('open-model', { id: 'unknown', label: 'Unknown', source: 'custom' } as never), []);
  const empty = await setupComponent(Effort, { modelValue: '', options: [] });
  empty.vm.onKey(key('ArrowRight').event);
  assert.equal(radios(empty.html).length, 0);
  assert.deepEqual(empty.events, [], 'a missing provider capability does not invent choices');
});

test('effort keyboard navigation skips unavailable choices, wraps and leaves unrelated keys alone', async () => {
  const options = [{ value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium', disabled: true }, { value: 'high', label: 'High' }];
  const { vm, props, events, html } = await setupComponent(Effort, { modelValue: 'low', options });
  assert.match(radios(html)[2]!, /disabled/);
  let focus = 0;
  vm.group.value = { querySelector: () => ({ focus() { focus++; } }) };
  for (const [pressed, expected] of [['ArrowRight', 'high'], ['ArrowDown', ''], ['ArrowLeft', 'high'], ['Home', ''], ['End', 'high'], ['ArrowUp', 'low']]) {
    const input = key(pressed!); vm.onKey(input.event); await nextTick();
    assert.equal(input.prevented(), 1); assert.equal(props.modelValue, expected);
  }
  assert.equal(focus, 6);
  assert.ok(events.every(event => event.value !== 'medium'));
  const ignored = key('Tab'); vm.onKey(ignored.event);
  assert.equal(ignored.prevented(), 0); assert.equal(events.length, 6);
  const unavailable = await setupComponent(Effort, { modelValue: '', options: [{ value: '', label: 'Default', disabled: true }] });
  unavailable.vm.onKey(key('End').event);
  assert.deepEqual(unavailable.events, []);
});

test('access control respects three-, four- and five-option catalogs and preserves provider defaults', async () => {
  const cursor = listManagedAgentPermissionProfiles('cursor');
  const claude = listManagedAgentPermissionProfiles('claude-code');
  const codex = listManagedAgentPermissionProfiles('codex');
  const cases = [
    { options: cursor.filter(option => option.status === 'available'), selected: 'read_only', ids: ['read_only', 'sandboxed_write', 'full_access'] },
    { options: claude, selected: 'read_only', ids: ['read_only', 'ask_before_write', 'auto_review', 'full_access'] },
    // A saved, now-unavailable choice stays visible so it is not misrepresented.
    { options: codex, selected: 'sandboxed_write', ids: ['read_only', 'ask_before_write', 'sandboxed_write', 'auto_review', 'full_access'] },
  ];
  for (const entry of cases) {
    const { vm, props, html, events } = await setupComponent(Access, { modelValue: entry.selected, options: entry.options });
    assert.deepEqual(vm.visibleOptions.value.map((option: { id: string }) => option.id), entry.ids);
    assert.equal(radios(html).length, entry.ids.length);
    assert.match(html, new RegExp(`--access-count:${entry.ids.length}`));
    assert.equal(props.modelValue, entry.selected);
    assert.deepEqual(events, []);
  }
  for (const [provider, expected] of [['codex', 'full_access'], ['claude-code', 'read_only'], ['cursor', 'read_only'], ['open-model', 'full_access']] as const) {
    const { props, events } = await setupComponent(Access, { modelValue: defaultManagedAgentPermissionProfileId(provider), options: listManagedAgentPermissionProfiles(provider) });
    assert.equal(props.modelValue, expected);
    assert.deepEqual(events, [], `${provider}: a new visual control must not change permissions`);
  }
});

test('access selection follows restriction order and skips disabled choices without hiding their reason', async () => {
  const options = listManagedAgentPermissionProfiles('cursor').reverse();
  const { vm, props, events, html } = await setupComponent(Access, { modelValue: 'read_only', options });
  assert.deepEqual(vm.visibleOptions.value.map((option: { id: string }) => option.id), ['read_only', 'ask_before_write', 'sandboxed_write', 'full_access']);
  assert.match(radios(html)[1]!, /disabled/);
  assert.match(radios(html)[1]!, /Cursor does not request approval/);
  for (const [pressed, expected] of [['ArrowRight', 'sandboxed_write'], ['ArrowRight', 'full_access'], ['ArrowRight', 'read_only'], ['ArrowLeft', 'full_access'], ['Home', 'read_only'], ['End', 'full_access']]) {
    vm.onKey(key(pressed!).event); await nextTick(); assert.equal(props.modelValue, expected);
  }
  assert.ok(events.every(event => event.value !== 'ask_before_write'));
  const blocked = await setupComponent(Access, { modelValue: 'read_only', options: options.map(option => ({ ...option, status: 'gated' })) });
  blocked.vm.onKey(key('ArrowRight').event);
  assert.deepEqual(blocked.events, []);
});

test('unknown and unavailable saved access retain a keyboard entry point without selecting a fallback permission', async () => {
  for (const [platform, entryLabel, nextAccess] of [
    ['darwin', 'Read-only', 'ask_before_write'],
    ['linux', 'Read-only', 'ask_before_write'],
    ['win32', 'Ask before writes', 'auto_review'],
  ] as const) {
    const options = listManagedAgentPermissionProfiles('codex')
      .map(option => supervisedPermissionProfilePresentation('codex', option, { hasProject: true, platform }));
    const savedChoices = ['', 'unknown', 'sandboxed_write', ...(platform === 'win32' ? ['read_only'] : [])];
    for (const saved of savedChoices) {
      const { vm, props, events, html } = await setupComponent(Access, { modelValue: saved, options });
      const tabStops = radios(html).filter(button => button.includes('tabindex="0"'));
      assert.equal(tabStops.length, 1, platform);
      assert.doesNotMatch(tabStops[0]!, /disabled/);
      assert.match(tabStops[0]!, new RegExp(entryLabel));
      assert.equal(props.modelValue, saved);
      assert.deepEqual(events, [], 'focus availability must not change the saved permission');
      if (saved === 'sandboxed_write' || saved === 'read_only') {
        const checked = radios(html).filter(button => button.includes('aria-checked="true"'));
        assert.equal(checked.length, 1);
        assert.match(checked[0]!, /disabled/);
        assert.equal(vm.selected.value.id, saved);
      } else {
        assert.equal(radios(html).filter(button => button.includes('aria-checked="true"')).length, 0);
        assert.doesNotMatch(html, /class="agent-access-description"/);
      }
      vm.onKey(key('ArrowRight').event); await nextTick();
      assert.equal(props.modelValue, nextAccess, `${platform}: navigation starts from the first available option`);
    }
    const blocked = await setupComponent(Access, { modelValue: '', options: options.map(option => ({ ...option, status: 'gated' })) });
    assert.equal(radios(blocked.html).filter(button => button.includes('tabindex="0"')).length, 0);
    blocked.vm.onKey(key('ArrowRight').event);
    assert.deepEqual(blocked.events, []);
  }
});

test('quick identity picker remains anchored and inside desktop, narrow and shifted visual viewports', () => {
  const cases = [
    { anchor: { left: 720, top: 760, bottom: 800 }, viewport: { left: 0, top: 0, width: 1280, height: 900 }, above: true },
    { anchor: { left: 20, top: 30, bottom: 70 }, viewport: { left: 0, top: 0, width: 1280, height: 900 }, above: false },
    { anchor: { left: 270, top: 600, bottom: 645 }, viewport: { left: 0, top: 0, width: 390, height: 700 }, above: true },
    { anchor: { left: 430, top: 385, bottom: 425 }, viewport: { left: 180, top: 200, width: 360, height: 310 }, above: true },
    { anchor: { left: 24, top: 80, bottom: 120 }, viewport: { left: 10, top: 45, width: 300, height: 250 }, above: false },
  ];
  for (const { anchor, viewport, above } of cases) {
    const result = composerIdentityPosition(anchor, viewport);
    assert.equal(result.opensAbove, above);
    assert.ok(result.width <= 410);
    assert.ok(result.left >= viewport.left + 12);
    assert.ok(result.left + result.width <= viewport.left + viewport.width - 12);
    assert.ok(result.top >= viewport.top + 12);
    assert.ok(result.top + result.height <= viewport.top + viewport.height - 12);
    assert.equal(above ? result.top + result.height : result.top, above ? anchor.top - 10 : anchor.bottom + 10);
  }
});

test('keyboard resizing keeps the picker inside the visual viewport even while its composer anchor is offscreen', () => {
  const viewport = { left: 0, top: 0, width: 390, height: 340 };
  const result = composerIdentityPosition({ left: 24, top: 580, bottom: 620 }, viewport);
  assert.ok(result.height > 0, 'the picker retains a usable scrolling area');
  assert.ok(result.top >= 12);
  assert.ok(result.top + result.height <= 328, 'keyboard must not hide the bottom of the picker');
});

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
function presentation(t: TestContext, initial = { name: 'Atlas', open: true, reduced: false, initialSection: undefined as string | undefined }) {
  const globals = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, matchMedia: globalThis.matchMedia, ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map<number, FrameRequestCallback>();
  const styles = new Map<string, string>();
  let sequence = 0, time = 0, focusReturns = 0, dialogFocus = 0, disconnects = 0;
  const surfaceFocus: FocusOptions[] = [], surfaceScroll: ScrollIntoViewOptions[] = [];
  const surface = markRaw({ focus(options: FocusOptions) { surfaceFocus.push(options); }, scrollIntoView(options: ScrollIntoViewOptions) { surfaceScroll.push(options); } });
  let mediaListener: (() => void) | undefined;
  class Element { focus() { focusReturns++; } }
  const previousFocus = new Element();
  const media = { matches: initial.reduced, addEventListener(_type: string, listener: () => void) { mediaListener = listener; }, removeEventListener() { mediaListener = undefined; } };
  Object.assign(globalThis, {
    document: { activeElement: previousFocus, contains: (element: unknown) => element === previousFocus }, HTMLElement: Element,
    matchMedia: () => media,
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    ResizeObserver: class { observe() {} disconnect() { disconnects++; } },
  });
  const props = reactive({ open: initial.open, initialSection: initial.initialSection });
  const name = ref(initial.name), avatar = ref<any>({ kind: 'character', character: 'orbit', color: 'sage' });
  const launchView = ref<object | null>(null);
  let vm: ReturnType<typeof useAgentSetupPresentation>;
  const app = renderer.createApp({ setup() {
    vm = useAgentSetupPresentation(props as never, name, avatar, { launch: { view: launchView, recoveryCandidate: ref(null), recoverDetectedLaunch: async () => { launchView.value = { failed: true, durable: true }; } } } as never);
    vm.dialogElement.value = markRaw({ focus() { dialogFocus++; }, querySelector() { return surface; } }) as unknown as HTMLElement;
    vm.turnStage.value = markRaw({ style: { setProperty: (key: string, value: string) => { styles.set(key, value); } } }) as unknown as HTMLElement;
    return () => h('div');
  } });
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({});
  let mounted = true;
  const unmount = () => { if (mounted) { app.unmount(); mounted = false; } };
  t.after(() => { unmount(); Object.assign(globalThis, globals); });
  const advance = (count = 1) => { for (let index = 0; index < count; index++) { time += 16; const callbacks = [...frames.entries()]; frames.clear(); for (const [, callback] of callbacks) callback(time); } };
  return { vm: vm!, props, name, avatar, launchView, styles, frames, advance, unmount,
    reduce: () => { media.matches = true; mediaListener?.(); },
    counts: () => ({ focusReturns, dialogFocus, disconnects, mediaListener, surfaceFocus, surfaceScroll }) };
}

test('identity validation keeps invalid names on identity and accepts Unicode names up to 32 code points', t => {
  const { vm, name, avatar } = presentation(t);
  for (const invalid of [' ', '---', '✨', 'A'.repeat(33)]) {
    name.value = invalid; vm.showStep('brain');
    assert.equal(vm.step.value, 'identity'); assert.match(vm.identityError.value, /1–32/);
  }
  name.value = '  Équipe 星🌟  '; vm.showStep('brain');
  assert.equal(vm.step.value, 'brain'); assert.equal(vm.identityError.value, '');
  assert.deepEqual(avatar.value, { kind: 'character', character: 'orbit', color: 'sage' });
  vm.showStep('identity'); name.value = '𐐀'.repeat(32); vm.showStep('brain');
  assert.equal(vm.step.value, 'brain', 'code points, not UTF-16 code units, set the boundary');
});

test('reversing the scene preserves the edited name and avatar without restarting the animation', async t => {
  const { vm, props, name, avatar, styles, frames, advance, counts } = presentation(t);
  name.value = 'Reviewer'; avatar.value = { kind: 'character', character: 'spark', color: 'rose' };
  const click = { detail: 1, currentTarget: { blur() {} } } as unknown as MouseEvent;
  vm.showStep('brain', click); advance(8);
  const midway = Number(styles.get('--turn-angle')!.replace('deg', ''));
  assert.ok(midway < 0 && midway > -90); assert.equal(vm.turning.value, true);
  vm.showStep('identity', click);
  assert.equal(styles.get('--turn-angle'), `${midway}deg`, 'reversal starts from the current pose');
  assert.equal(frames.size, 1, 'reversal reuses the running spring');
  advance(180);
  assert.equal(styles.get('--turn-angle'), '0deg'); assert.equal(vm.turning.value, false); assert.equal(frames.size, 0);
  assert.equal(name.value, 'Reviewer'); assert.deepEqual(avatar.value, { kind: 'character', character: 'spark', color: 'rose' });
  props.open = false; await nextTick(); vm.handleAfterLeave();
  assert.equal(counts().focusReturns, 1);
  props.open = true; await nextTick();
  assert.equal(name.value, 'Reviewer'); assert.equal(vm.step.value, 'identity');
  assert.deepEqual(avatar.value, { kind: 'character', character: 'spark', color: 'rose' });
});

test('reopening a saved launch shows Brain recovery directly instead of editable Identity', async t => {
  const { vm, props, name, avatar, launchView, styles, frames } = presentation(t);
  name.value = 'EndpointFailureQA';
  avatar.value = { kind: 'character', character: 'spark', color: 'rose' };
  props.open = false; await nextTick();
  launchView.value = { failed: true, durable: true }; await nextTick();
  props.open = true; await nextTick();
  assert.equal(vm.step.value, 'brain');
  assert.equal(styles.get('--turn-angle'), '-90deg');
  assert.equal(frames.size, 0, 'restoring progress does not replay the setup transition');
  assert.equal(name.value, 'EndpointFailureQA');
  assert.deepEqual(avatar.value, { kind: 'character', character: 'spark', color: 'rose' });

  props.open = false; launchView.value = null; await nextTick();
  props.open = true; await nextTick();
  assert.equal(vm.step.value, 'identity', 'a new agent still opens on Identity');
});

test('a launch restored asynchronously reveals recovery without validating the new-agent draft', async t => {
  const { vm, name, launchView, styles, frames, counts } = presentation(t);
  await nextTick();
  name.value = '---';
  vm.showStep('brain');
  assert.equal(vm.step.value, 'identity');
  const focusBeforeRecovery = counts().dialogFocus;
  launchView.value = { failed: true, durable: true }; await nextTick();
  assert.equal(vm.step.value, 'brain', 'recovery must not require a valid new-agent name');
  assert.equal(counts().dialogFocus, focusBeforeRecovery + 1, 'focus leaves Identity before it becomes inert');
  assert.equal(styles.get('--turn-angle'), '-90deg');
  assert.equal(frames.size, 0);
  assert.equal(name.value, '---', 'showing existing progress does not rewrite the draft');
});

test('failed launches reveal recovery once, preserve focus on equivalent snapshots, and reveal it again when reopened', async t => {
  const { vm, props, launchView, counts } = presentation(t);
  const flush = async () => { await nextTick(); await nextTick(); };
  await flush();
  vm.showStep('brain');
  launchView.value = { failed: false, durable: true, currentPhaseId: 'starting_provider' };
  await flush();
  assert.equal(counts().surfaceFocus.length, 0, 'ordinary launch progress does not move focus');
  launchView.value = { failed: true, durable: true, currentPhaseId: 'starting_provider' };
  await flush();
  assert.equal(vm.step.value, 'brain');
  assert.deepEqual(counts().surfaceFocus, [{ preventScroll: true }]);
  assert.deepEqual(counts().surfaceScroll, [{ block: 'nearest', behavior: 'instant' }]);
  launchView.value = { ...launchView.value, failureDetail: 'New diagnostic snapshot' };
  await flush();
  assert.equal(counts().surfaceFocus.length, 1, 'status polling must not steal focus from a recovery control');
  assert.equal(counts().surfaceScroll.length, 1);
  props.open = false; await flush();
  props.open = true; await flush();
  assert.equal(counts().surfaceFocus.length, 2, 'reopening a saved failure restores its recovery surface');
  launchView.value = { failed: false }; await flush();
  launchView.value = { failed: true }; await flush();
  assert.equal(counts().surfaceFocus.length, 3, 'a new failed retry is a new recovery transition');
});

test('asynchronously attached failures reveal recovery with reduced motion and never focus a closed dialog', async t => {
  const { vm, props, launchView, counts, frames } = presentation(t, { name: 'Atlas', open: true, reduced: true, initialSection: undefined });
  const flush = async () => { await nextTick(); await nextTick(); };
  await flush();
  launchView.value = { failed: true, durable: true };
  await flush();
  assert.deepEqual(counts().surfaceFocus, [{ preventScroll: true }]);
  assert.deepEqual(counts().surfaceScroll, [{ block: 'nearest', behavior: 'instant' }]);
  assert.equal(frames.size, 0, 'revealing recovery does not animate the scene or scroll');
  launchView.value = null; await flush();
  await vm.handleRecoverSupervisedLaunch(); await flush();
  assert.equal(counts().surfaceFocus.length, 2, 'explicit Recover attaches and reveals the failed entry exactly once');
  launchView.value = null; await flush();
  props.open = false; launchView.value = { failed: true, durable: true }; await flush();
  assert.equal(counts().surfaceFocus.length, 2);
  assert.equal(counts().surfaceScroll.length, 2);
});

test('keyboard navigation, pause and reduced motion settle the selected face and clean up pending frames', async t => {
  const { vm, frames, styles, reduce, advance, unmount, counts } = presentation(t);
  vm.showStep('brain', { detail: 0 } as MouseEvent);
  assert.equal(frames.size, 0); assert.equal(styles.get('--turn-angle'), '-90deg');
  vm.showStep('identity', { detail: 1 } as MouseEvent); advance(4);
  assert.equal(vm.turning.value, true);
  vm.motionPaused.value = true; await nextTick();
  assert.equal(frames.size, 0); assert.equal(styles.get('--turn-angle'), '0deg');
  vm.motionPaused.value = false; await nextTick(); vm.showStep('brain', { detail: 1 } as MouseEvent); advance(4);
  reduce(); assert.equal(frames.size, 0); assert.equal(styles.get('--turn-angle'), '-90deg');
  vm.showStep('identity', { detail: 1 } as MouseEvent);
  assert.equal(frames.size, 0); assert.equal(styles.get('--turn-angle'), '0deg');
  unmount(); assert.equal(counts().mediaListener, undefined); assert.ok(counts().disconnects > 0);
});

test('a slow image decode cannot replace a later character, colour or avatar mode selection', async t => {
  const globals = { createImageBitmap: globalThis.createImageBitmap, document: globalThis.document };
  t.after(() => Object.assign(globalThis, globals));
  let resolveBitmap!: (value: unknown) => void;
  let closes = 0, canvasCalls = 0;
  Object.assign(globalThis, { createImageBitmap: () => new Promise(resolve => { resolveBitmap = resolve; }), document: { createElement() { canvasCalls++; throw new Error('stale image must not be drawn'); } } });
  for (const choose of [(vm: any) => vm.chooseCharacter('spark'), (vm: any) => vm.chooseColor('rose'), (vm: any) => vm.chooseMode('initials')]) {
    // Exercise the picker without mounting its unrelated 3D portrait children.
    const { vm, events } = await setupComponent(Identity, { modelValue: { kind: 'character', character: 'orbit', color: 'sage' }, name: 'Atlas', active: false, animate: false }, false);
    const input = { files: [{ type: 'image/png', size: 1024 }], value: 'image.png' };
    const pending = vm.upload({ target: input }); choose(vm);
    const explicit = events.filter(event => event.name === 'update:modelValue');
    assert.equal(explicit.length, 1); assert.notEqual(explicit[0]!.value.kind, 'image');
    resolveBitmap({ width: 100, height: 100, close() { closes++; } }); await pending;
    assert.equal(input.value, ''); assert.equal(vm.uploadError.value, '');
    assert.deepEqual(events.filter(event => event.name === 'update:modelValue'), explicit);
  }
  assert.equal(closes, 3); assert.equal(canvasCalls, 0);
});

test('a stale image decode failure stays silent after a newer explicit selection', async t => {
  const original = globalThis.createImageBitmap;
  t.after(() => Object.assign(globalThis, { createImageBitmap: original }));
  let rejectBitmap!: (error: Error) => void;
  Object.assign(globalThis, { createImageBitmap: () => new Promise((_resolve, reject) => { rejectBitmap = reject; }) });
  const { vm, events } = await setupComponent(Identity, { modelValue: { kind: 'character', character: 'orbit', color: 'sage' }, name: 'Atlas', active: false, animate: false }, false);
  const pending = vm.upload({ target: { files: [{ type: 'image/png', size: 1024 }], value: 'image.png' } });
  vm.chooseCharacter('spark'); rejectBitmap(new Error('decode failed')); await pending;
  assert.equal(vm.uploadError.value, '');
  assert.equal(events.filter(event => event.name === 'update:modelValue').length, 1);
  assert.equal(events.find(event => event.name === 'update:modelValue')!.value.character, 'spark');
});
