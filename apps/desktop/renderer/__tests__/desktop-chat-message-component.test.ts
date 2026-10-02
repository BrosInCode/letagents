import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, createSSRApp, h, markRaw, nextTick, provide, reactive, ref, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";
import {
  restoreContextMenuFocus,
  shouldRestoreContextMenuFocus,
} from "../src/components/desktop/content/desktop-chat-message/context-menu-focus";

let vite: ViteDevServer;
let DesktopChatMessage: unknown;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  DesktopChatMessage = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/DesktopChatMessage.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

test("thread-context messages expose their DOM contract through the shared component", async () => {
  const app = createSSRApp({
    render: () => h(DesktopChatMessage as object, {
      context: "thread-reply",
      message: {
        id: "msg_thread_reply",
        sender: "Oak",
        text: "Review task_42",
        attachments: [],
        agentPromptKind: null,
        source: "agent",
        timestamp: "2026-07-11T12:00:00.000Z",
        actorLabel: "Oak | EmmyMay's agent | Codex",
        agentIdentity: {
          name: "oak",
          displayName: "Oak",
          ownerLabel: "EmmyMay",
          ownerAttribution: null,
          ideLabel: "Codex",
          actorLabel: "Oak | EmmyMay's agent | Codex",
          agentKey: "local/emmymay/codex/oak",
          agentSessionId: "agent_session_oak",
        },
        threadRootId: "msg_root",
        threadReplyToId: "msg_root",
        thread: null,
        replyTo: null,
      },
      threadSummary: {
        count: 0,
        unreadCount: 0,
        latest: null,
        latestPreview: null,
        latestTimestamp: null,
        participants: [],
        hasPartialHistory: false,
        loadingEarlier: false,
      },
      activeThreadRoot: false,
      highlightQuery: "",
      searchActive: false,
      threadMessageId: "msg_thread_reply",
      testId: "room-thread-reply-msg_thread_reply",
      taskReferenceIds: new Set(["task_42"]),
    }),
  });

  const html = await renderToString(app);
  assert.match(html, /data-thread-message-id="msg_thread_reply"/);
  assert.match(html, /data-testid="room-thread-reply-msg_thread_reply"/);
  assert.match(html, /aria-label="Copy message"/);
  assert.match(html, /aria-label="Jump to root"/);
  assert.match(html, /data-task-reference-id="task_42"/);
  assert.match(html, /EmmyMay&#39;s agent/);
  assert.match(html, /room-provider-badge--codex/);
  assert.match(html, /aria-label="Codex provider"/);
  assert.match(html, /<img/);
  assert.doesNotMatch(html, /room-message-ide/);
  assert.doesNotMatch(html, /room-message-provenance[^>]*data-kind="agent"/);
});

test("context-menu dismissal restores focus after Escape, copy and completed actions", () => {
  assert.equal(shouldRestoreContextMenuFocus("escape"), true);
  assert.equal(shouldRestoreContextMenuFocus("copy"), true);
  assert.equal(shouldRestoreContextMenuFocus("complete"), true);
  assert.equal(shouldRestoreContextMenuFocus("outside"), false);
  assert.equal(shouldRestoreContextMenuFocus("action"), false);

  const calls: Array<FocusOptions | undefined> = [];
  restoreContextMenuFocus({
    isConnected: true,
    focus: (options) => calls.push(options),
  });
  restoreContextMenuFocus({
    isConnected: false,
    focus: (options) => calls.push(options),
  });
  assert.deepEqual(calls, [{ preventScroll: true }]);
});

test("a mounted message reuses escaped Markdown while references and search remain reactive", async (t) => {
  const originalWindow = globalThis.window;
  Object.assign(globalThis, { window: { removeEventListener() {} } });
  const text = "## **Original**\nSee msg_42, task_7, `msg_42` and <script>.";
  const replacement = "## **Changed**\nSee msg_42 and <img>.";
  let parses = 0;
  const originalReplace = String.prototype.replace;
  t.mock.method(String.prototype, "replace", function (this: string, pattern: RegExp, value: string) {
    // The block parser starts by normalizing source newlines. Count the real
    // parser entry without changing the production formatter or Vue cache.
    if ((String(this) === text || String(this) === replacement) && pattern instanceof RegExp && pattern.source === "\\r\\n") parses++;
    return originalReplace.call(this, pattern, value);
  });
  const props = reactive({
    message: {
      id: "msg_1", sender: "Oak", text, displayText: null, source: "agent",
      timestamp: "2026-09-27T00:00:00Z", attachments: [], agentIdentity: null,
    },
    messageReferenceIds: new Set<string>(), taskReferenceIds: new Set<string>(),
    highlightQuery: "", context: "timeline", deliveryReceipts: [],
    threadSummary: { count: 0, unreadCount: 0, participants: [] },
  });
  let html = "";
  const renderer = createRenderer<any, any>({
    patchProp(_node, key, _previous, value) { if (key === "innerHTML") html = value; },
    insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      const vm = (DesktopChatMessage as any).setup(props, { expose() {}, emit() {} });
      return () => h("div", { innerHTML: vm.renderedText.value });
    },
  });
  app.provide(ssrContextKey, { modules: new Set() });
  try {
    app.mount({});
    assert.equal(parses, 1);
    assert.match(html, /<h2><strong>Original<\/strong><\/h2>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /data-message-reference-id|data-task-reference-id/);
    props.messageReferenceIds = new Set(["msg_42"]);
    props.taskReferenceIds.add("task_7");
    await nextTick();
    assert.equal(parses, 1, "history and task updates must not reparse existing message Markdown");
    assert.match(html, /data-message-reference-id="msg_42"/);
    assert.match(html, /data-task-reference-id="task_7"/);
    assert.match(html, /<code>msg_42<\/code>/);
    props.highlightQuery = "42";
    await nextTick();
    assert.equal(parses, 1, "search must only decorate the already escaped message");
    assert.match(html, /msg_<mark class="message-search-hit">42<\/mark><\/button>/);
    assert.match(html, /<code>msg_42<\/code>/);
    props.messageReferenceIds.clear();
    props.taskReferenceIds = new Set();
    await nextTick();
    assert.equal(parses, 1);
    assert.doesNotMatch(html, /data-message-reference-id|data-task-reference-id/);
    props.message.text = replacement;
    await nextTick();
    assert.equal(parses, 2, "edited message content must be reparsed");
    assert.match(html, /<strong>Changed<\/strong>/);
    assert.match(html, /&lt;img&gt;/);
    assert.doesNotMatch(html, /<img|Original/);
  } finally {
    app.unmount();
    Object.assign(globalThis, { window: originalWindow });
  }
});

test("one room message groups delivery receipts for every activated agent", async () => {
  const app = createSSRApp({
    render: () => h(DesktopChatMessage as object, {
      message: {
        id: "msg_everyone",
        sender: "EmmyMay",
        text: "hi @everyone",
        attachments: [],
        agentPromptKind: null,
        source: "browser",
        timestamp: "2026-07-20T12:00:00.000Z",
        actorLabel: null,
        agentIdentity: null,
        threadRootId: null,
        threadReplyToId: null,
        thread: null,
        replyTo: null,
      },
      threadSummary: {
        count: 0, unreadCount: 0, latest: null, latestPreview: null, latestTimestamp: null,
        participants: [], hasPartialHistory: false, loadingEarlier: false,
      },
      activeThreadRoot: false,
      highlightQuery: "",
      searchActive: false,
      deliveryReceipts: [
        { agentId: "stone", agentName: "StoneRidge", state: "dispatching", blockedByMessageId: null, error: null },
        { agentId: "dawn", agentName: "DawnPeak", state: "queued_behind_blocked", blockedByMessageId: "msg_blocked", error: null },
        { agentId: "oak", agentName: "Oak", state: "blocked", blockedByMessageId: null,
          error: "The provider rejected Authori\u200bzation: Be\u202earer super\u2060-secret\u00ad-token-123456789, so delivery stopped." },
        { agentId: "ash", agentName: "Ash", state: "acknowledged_failed", blockedByMessageId: null,
          error: "Open Model request failed (HTTP 404): configured model is no longer available." },
      ],
    }),
  });

  const html = await renderToString(app);
  assert.doesNotMatch(html, /aria-label="StoneRidge is responding"/);
  assert.doesNotMatch(html, />StoneRidge<\/strong>/);
  assert.doesNotMatch(html, /Waiting for StoneRidge/);
  assert.match(html, /aria-label="Waiting — DawnPeak needs attention on msg_blocked"/);
  assert.match(html, /Queued behind an issue/);
  assert.match(html, /View earlier message/);
  const blockedReceipt = html.match(/<li[^>]*data-state="blocked"[\s\S]*?<\/li>/)?.[0];
  assert.ok(blockedReceipt);
  assert.match(blockedReceipt, /aria-label="Oak: The provider rejected Authorization:\[redacted\], so delivery stopped\."/);
  assert.match(blockedReceipt, /The provider rejected Authorization:\[redacted\], so delivery stopped\.<\/small>/);
  assert.doesNotMatch(blockedReceipt, /super-secret-token|\u200b|\u2060|\u00ad|\u202e/);
  assert.match(html, /disabled aria-label="Retry delivery for Oak is unavailable"/);
  assert.match(html, />Retry unavailable<\/button>/);
  assert.match(html, /Retry will be available when delivery recovery is connected/);
  const failedReceipt = html.match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)?.[0];
  assert.ok(failedReceipt);
  assert.match(failedReceipt, /aria-label="Ash: Open Model request failed \(HTTP 404\): configured model is no longer available\."/);
  assert.match(failedReceipt, /Open Model request failed \(HTTP 404\): configured model is no longer available\.<\/small>/);
  assert.doesNotMatch(failedReceipt, /<button|delivery-dots|Needs attention|replied|lucide-check/);
});

test("GitHub event task chips expose the shared Board navigation contract", async () => {
  const app = createSSRApp({
    render: () => h(DesktopChatMessage as object, {
      message: {
        id: "msg_github",
        sender: "github",
        text: "PR #800 opened in BrosInCode/letagents linked to task_42: Link task mentions https://github.com/BrosInCode/letagents/pull/800",
        attachments: [],
        agentPromptKind: null,
        source: "github",
        timestamp: "2026-07-17T04:34:00.000Z",
        actorLabel: null,
        agentIdentity: null,
        threadRootId: null,
        threadReplyToId: null,
        thread: null,
        replyTo: null,
      },
      threadSummary: {
        count: 0,
        unreadCount: 0,
        latest: null,
        latestPreview: null,
        latestTimestamp: null,
        participants: [],
        hasPartialHistory: false,
        loadingEarlier: false,
      },
      activeThreadRoot: false,
      highlightQuery: "",
      searchActive: false,
      taskReferenceIds: new Set(["task_42"]),
    }),
  });

  const html = await renderToString(app);
  assert.match(html, /<button[^>]*data-task-reference-id="task_42"/);
  assert.match(html, /title="Open task_42 on the Board"/);
});


test("board notification renders readable copy while keeping its canonical body intact", async () => {
  const message = {
    id: "msg_approval", sender: "letagents", source: "system",
    text: "@agent:owner/lumen Board intent bi_123 was approved. Continue with board_intent_id.",
    displayText: "@LumenRiver — Your request to claim task_19: “Tests and CI” was approved. You can continue.",
    attachments: [], agentPromptKind: null, timestamp: "2026-09-07T00:00:00Z",
    actorLabel: null, agentIdentity: null, threadRootId: "msg_approval", threadReplyToId: null,
    thread: null, replyTo: null,
  };
  const html = await renderToString(createSSRApp({
    render: () => h(DesktopChatMessage as object, {
      message, threadSummary: { count: 0, unreadCount: 0, latest: null, latestPreview: null,
        latestTimestamp: null, participants: [], hasPartialHistory: false, loadingEarlier: false },
      activeThreadRoot: false, highlightQuery: "", searchActive: false, taskReferenceIds: new Set(["task_19"]),
    }),
  }));
  assert.match(html, /mention-token[^>]*>@LumenRiver/);
  assert.match(html, /data-task-reference-id="task_19"/);
  assert.match(html, /Tests and CI/);
  assert.doesNotMatch(html, /owner\/lumen|bi_123|board_intent_id/);
  assert.match(message.text, /board_intent_id/);
});

// Execute the integrated menu and its SSR template; browser geometry is supplied
// separately because this suite has no layout engine.
class MenuAuditElement {
  isConnected = true;
  disabled = false;
  href: string | null = null;
  constructor(readonly label = '') { markRaw(this); }
  focus() { if (!this.disabled) (document as any).activeElement = this; }
  closest(selector: string) { return this.href && (selector.includes('a[') || selector.includes('button, a')) ? this : null; }
  getAttribute(name: string) { return name === 'href' ? this.href : null; }
}
async function desktopMenuAudit(t: any, flags = 63, extra: Record<string, unknown> = {}) {
  const originals = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement };
  const doc: any = { activeElement: null, querySelectorAll: () => [] };
  Object.assign(globalThis, { document: doc, Element: MenuAuditElement, HTMLElement: MenuAuditElement,
    window: { innerWidth: 800, innerHeight: 600, location: { href: 'https://letagents.chat/' }, setTimeout() { return 0; }, addEventListener() {}, removeEventListener() {} } });
  const pins = await vite.ssrLoadModule('/renderer/src/composables/useRoomMessagePins.ts');
  const reactions = await vite.ssrLoadModule('/renderer/src/composables/useRoomMessageReactions.ts');
  const reminders = await vite.ssrLoadModule('/renderer/src/composables/useMessageReminders.ts');
  const { unreadMenuKey } = await vite.ssrLoadModule('/@fs' + fileURLToPath(new URL('../../../../shared/room-unread-client.ts', import.meta.url)));
  reminders.setReminderAccount(flags & 8 ? 'person' : null);
  t.after(() => { reminders.setReminderAccount(null); Object.assign(globalThis, originals); });
  const invoker = new MenuAuditElement('message');
  const target = new MenuAuditElement();
  if (flags & 1) target.href = 'https://example.com/';
  const props = { message: { id: 'msg_12', text: 'Message', sender: 'Ada', timestamp: '2026-10-02T00:00:00Z', attachments: [], reactions: [], ...extra },
    roomIdentifier: flags & 32 ? 'room' : 'local_room', threadSummary: { count: 0, unreadCount: 0, participants: [] }, activeThreadRoot: false, highlightQuery: '', searchActive: false };
  const events: any[] = [];
  let vm: any;
  const OpenChat = { ...(DesktopChatMessage as any), setup(props: any, context: any) {
    vm = (DesktopChatMessage as any).setup(props, context);
    vm.openContextMenu({ target, currentTarget: invoker, clientX: 799, clientY: 599, preventDefault() {} });
    return vm;
  } };
  const app = createSSRApp({ setup() {
    pins.provideRoomMessagePins({ canPin: ref(Boolean(flags & 2)), state: ref({ pending: extra.pinPending ? 'msg_12' : null }), isPinned: () => false, toggle: () => events.push('pin') });
    reactions.provideRoomMessageReactions({ canReact: ref(Boolean(flags & 4)), reactionsFor: () => [], viewerReacted: () => false, track: () => () => {}, toggle() {} });
    provide(unreadMenuKey, { client: { account: ref(flags & 16 ? 'person' : null), mark: () => events.push('unread') }, room: ref('room') });
    return () => h(OpenChat, props);
  } });
  const context: any = {};
  await renderToString(app, context);
  const html = context.teleports?.body ?? '';
  const rows = [...html.matchAll(/<button([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/button>/g)].map(match => {
    const row = new MenuAuditElement(match[2].replace(/<[^>]+>/g, '').trim());
    row.disabled = /\bdisabled\b/.test(match[1]);
    return row;
  });
  const menu = markRaw({ querySelectorAll: (selector: string) => rows.filter(row => !selector.includes(':not(:disabled)') || !row.disabled) });
  for (const row of rows) Object.assign(row, { parentElement: menu });
  vm.firstContextMenuButton.value = rows[0];
  doc.querySelectorAll = menu.querySelectorAll;
  return { vm, rows, invoker: flags & 1 ? target : invoker, events, html, doc, reminders };
}

test('integrated desktop menu renders ordered rows and reserves height across all 64 feature configurations', async t => {
  for (let flags = 0; flags < 64; flags++) await t.test(String(flags), async t => {
    const { vm, rows, invoker } = await desktopMenuAudit(t, flags);
    const expected = flags & 1 ? ['Open link in browser', 'Copy link', 'Message info'] : [
      'Copy message', ...(flags & 32 ? ['Copy link to message'] : []), 'Quote reply', 'Reply in thread',
      ...(flags & 8 && flags & 32 ? ['Remind me ›'] : []), ...(flags & 2 ? ['Pin message'] : []),
      ...(flags & 4 ? ['Add reaction…'] : []), ...(flags & 16 ? ['Mark unread from here'] : []), 'Message info',
    ];
    assert.deepEqual(rows.map(row => row.label), expected);
    // Current CSS: 32px minimum rows, 12px border/padding, 9px separator.
    assert.ok(vm.contextMenuPosition.value.y + rows.length * 32 + 21 <= 592);
    for (let i = 0; i < rows.length; i++) {
      rows[i].focus(); vm.focusContextMenuItem(1); assert.equal(document.activeElement, rows[(i + 1) % rows.length]);
      vm.focusContextMenuItem(-1); assert.equal(document.activeElement, rows[i]);
    }
    vm.handleContextMenuKeydown({ key: 'Escape' }); await nextTick();
    assert.equal(document.activeElement, invoker);
  });
});

test('desktop keyboard navigation skips a pending disabled pin row', async t => {
  const { vm, rows } = await desktopMenuAudit(t, 62, { pinPending: true });
  const disabled = rows.findIndex(row => row.disabled);
  assert.ok(disabled > 0);
  rows[disabled - 1].focus(); vm.focusContextMenuItem(1);
  assert.equal(document.activeElement, rows[disabled + 1]);
});

test('desktop non-navigation actions return focus to the message', async t => {
  for (const action of ['pinFromContext', 'markUnreadFromContext', 'reminderScheduled']) await t.test(action, async t => {
    const { vm, rows, invoker } = await desktopMenuAudit(t, 62);
    rows.at(-1)!.focus();
    vm[action]('2026-10-03T09:00:00Z'); await nextTick();
    assert.equal(document.activeElement, invoker);
  });
});

test('desktop parent navigation stays out of a separately open submenu', async t => {
  const { vm, rows, doc } = await desktopMenuAudit(t, 62);
  const nested = new MenuAuditElement('20 minutes');
  // An open reminder submenu is a descendant of the parent menu, but has its
  // own keyboard handler; it must not enter the parent's arrow-key sequence.
  const reminderIndex = rows.findIndex(row => row.label === 'Remind me ›');
  assert.ok(reminderIndex >= 0);
  const descendants = [...rows.slice(0, reminderIndex + 1), nested, ...rows.slice(reminderIndex + 1)];
  doc.querySelectorAll = () => descendants;
  rows[reminderIndex].focus(); vm.focusContextMenuItem(1);
  assert.equal(document.activeElement, rows[reminderIndex + 1]);
});

test('desktop link menu reserves only its rendered rows when reminders are available', async t => {
  const { vm, invoker, reminders } = await desktopMenuAudit(t, 63);
  const withReminders = vm.contextMenuPosition.value.y;
  reminders.setReminderAccount(null);
  vm.openContextMenu({ target: invoker, currentTarget: invoker, clientX: 799, clientY: 599, preventDefault() {} });
  assert.equal(vm.contextMenuPosition.value.y, withReminders);
});

test('desktop copy restores focus while outside dismissal preserves the new focus target', async t => {
  for (const action of ['copyFromContext', 'copyMessageLinkFromContext', 'closeContextMenuFromOutside']) await t.test(action, async t => {
    const { vm, rows, invoker } = await desktopMenuAudit(t, 62);
    rows[0].focus();
    await vm[action](); await nextTick();
    assert.equal(document.activeElement, action === 'closeContextMenuFromOutside' ? rows[0] : invoker);
  });
});

test('desktop row conditions exclude outgoing messages, unconfirmed IDs and unread thread replies', async t => {
  for (const message of [{ outgoing: { state: 'pending' } }, { id: 'pending:1' }, { threadRootId: 'msg_1', threadReplyToId: 'msg_1' }, { source: 'wake_rule' }]) await t.test(JSON.stringify(message), async t => {
    const { vm, rows } = await desktopMenuAudit(t, 62, message);
    if ('outgoing' in message) assert.deepEqual(rows, []);
    if ('id' in message) for (const name of ['canCopyMessageLink', 'remindable', 'pinnable', 'reactable', 'canMarkUnread']) assert.equal(vm[name].value, false, name);
    if ('threadRootId' in message) assert.equal(vm.canMarkUnread.value, false);
    if ('source' in message) assert.equal(vm.reactable.value, false);
  });
});
