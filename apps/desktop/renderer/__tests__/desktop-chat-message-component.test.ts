import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRenderer, createSSRApp, h, markRaw, nextTick, provide, reactive, ref, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";
import { useSecondClock } from "../src/composables/useSecondClock";
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

const ATTEMPTS_FAILED = "All three automatic attempts failed. The agent now waits for you: check the provider, then use Retry delivery to try again. Existing work is preserved.";
const STOPPED_BY_OWNER = "You stopped the automatic attempts. The task is still assigned to this agent. Send it a message to continue.";
const retryMessage = (id: string) => ({ id, sender: "EmmyMay", text: "continue the task", attachments: [], agentPromptKind: null, source: "browser",
  timestamp: "2026-10-09T14:30:00.000Z", actorLabel: null, agentIdentity: null, threadRootId: null, threadReplyToId: null, thread: null, replyTo: null });
const retryThreadSummary = { count: 0, unreadCount: 0, latest: null, latestPreview: null, latestTimestamp: null, participants: [], hasPartialHistory: false, loadingEarlier: false };
const renderReceipts = (id: string, deliveryReceipts: unknown[], props: Record<string, unknown> = {}) => renderToString(createSSRApp({
  render: () => h(DesktopChatMessage as object, { message: retryMessage(id), threadSummary: retryThreadSummary, activeThreadRoot: false, highlightQuery: "", searchActive: false,
    deliveryRecoveryAvailable: true, roomDeliverySkipAvailable: true, deliveryReceipts, ...props }),
}));
const failedReceipt = { agentId: "ash", agentName: "Ash", state: "acknowledged_failed", blockedByMessageId: null, failureCode: null, terminalReason: null, attemptCount: 1, providerTurnId: "turn_1",
  error: "API Error: Repeated 529 Overloaded errors." };

test("a failed message shows its agent's automatic attempt with the time, the attempt and two controls; a later message says that it waits for it", async () => {
  const render = renderReceipts;
  const retry = { atMs: Date.now() + 100_000, attempt: 2, attempts: 3, kind: "provider_fault", sourceMessageId: "task-continuation:inbox_1" };
  const failed = { ...failedReceipt, scheduledRetry: retry };

  const html = await render("msg_1", [failed]);
  const receipt = html.match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)?.[0];
  assert.ok(receipt);
  // What failed, in the provider's words; when the agent tries again, and which attempt; what happens if it keeps failing.
  assert.match(receipt, /API Error: Repeated 529 Overloaded errors\.<\/small>/);
  assert.match(receipt, /<small aria-hidden="true">Trying again in 1 min (?:39|40) s \(attempt 2 of 3\)<\/small>/);
  assert.match(receipt, /<small>If all 3 attempts fail, the agent stops and waits for you\.<\/small>/);
  // Read aloud, the time is a clock time: the list is a live region, and a count would be read out each second.
  assert.match(receipt, /aria-label="Ash: API Error: Repeated 529 Overloaded errors\. Trying again at [^"(]+ \(attempt 2 of 3\)\. If all 3 attempts fail, the agent stops and waits for you\."/);
  assert.doesNotMatch(receipt.match(/aria-label="Ash:[^"]*"/)![0], / in \d/);
  // The two controls, in the receipt's own buttons.
  assert.match(receipt, /<button type="button" aria-label="Try again now for Ash" title="Asks the agent to start this attempt now instead of waiting\.">Try now<\/button>/);
  assert.match(receipt, /<button type="button" aria-label="Stop the automatic attempts for Ash" title="No more automatic attempts\. Later messages go ahead\. The task stays assigned to the agent: send it a message to continue\.">Stop trying<\/button>/);
  assert.equal(receipt.match(/<button/g)?.length, 2);
  assert.doesNotMatch(receipt, /disabled|Retry delivery|Skip message/);

  // A request that is on its way is named by the follow-up's own id, not by this message's. It is a request: nothing has started.
  const busy = await render("msg_1", [failed], { deliveryRetryKeys: new Set(["ash:task-continuation:inbox_1"]), roomDeliverySkipKeys: new Set(["ash:msg_1"]) });
  assert.match(busy, /disabled[^>]*aria-label="Try again now for Ash"[^>]*>Asking…<\/button>/);
  assert.match(busy, />Stop trying<\/button>/);
  const stopping = await render("msg_1", [failed], { roomDeliverySkipKeys: new Set(["ash:task-continuation:inbox_1"]) });
  assert.match(stopping, /disabled[^>]*aria-label="Stop the automatic attempts for Ash"[^>]*>Stopping…<\/button>/);
  // Without the background service's retry and skip, the controls show and cannot be used.
  const unavailable = await render("msg_1", [failed], { deliveryRecoveryAvailable: false, roomDeliverySkipAvailable: false });
  assert.equal(unavailable.match(/<button type="button" disabled/g)?.length, 2);
  // The last automatic attempt, and a time that has passed. The turn may not have started: the message does not say that it has.
  const last = await render("msg_1", [{ ...failed, scheduledRetry: { ...retry, atMs: Date.now() - 5_000, attempt: 3 } }]);
  assert.match(last, /<small aria-hidden="true">About to try again \(attempt 3 of 3\)<\/small>/);
  assert.match(last, /aria-label="Ash: API Error: Repeated 529 Overloaded errors\. About to try again \(attempt 3 of 3\)\. This is the last automatic attempt\./);
  assert.match(last, /<small>This is the last automatic attempt\. If it fails, the agent stops and waits for you\.<\/small>/);
  assert.doesNotMatch(last, /Trying again now|Trying again in/);
  // A failed message with no follow-up has no controls and no note, as before.
  const plain = (await render("msg_1", [{ ...failed, scheduledRetry: null, followUpNote: null }])).match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)?.[0];
  assert.ok(plain);
  assert.doesNotMatch(plain, /Trying again|try again|Try now|Stop trying|<button/);

  // A message that arrived during the wait.
  const queued = await render("msg_2", [{ agentId: "ash", agentName: "Ash", state: "queued_behind_retry", blockedByMessageId: "msg_1", failureCode: null, terminalReason: null,
    attemptCount: 0, providerTurnId: null, error: null }]);
  const waiting = queued.match(/<li[^>]*data-state="queued_behind_retry"[\s\S]*?<\/li>/)?.[0];
  assert.ok(waiting);
  assert.match(waiting, /aria-label="Waiting — Ash will try earlier work again first"/);
  assert.match(waiting, /<small>Queued until the agent has tried again<\/small>/);
  assert.match(waiting, /View earlier message/);
  assert.match(waiting, /room-message-delivery-dots/);
  // The state's own name is not shown. What the owner reads has one family of words: "try again" and "attempt".
  assert.doesNotMatch(waiting.replace(/ data-state="[^"]*"/, ""), /an issue|needs attention|Try now|Stop trying|retry/i);
});

test("after a turn that ended without a reply the message says one attempt, and names no provider problem and no wait for the owner", async () => {
  const noReply = { atMs: Date.now() + 10_000, attempt: 1, attempts: 1, kind: "no_reply", sourceMessageId: "task-continuation:inbox_1" };
  const html = await renderReceipts("msg_1", [{ ...failedReceipt, error: "The model returned no reply.", scheduledRetry: noReply }]);
  const receipt = html.match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)?.[0];
  assert.ok(receipt);
  assert.match(receipt, /<small aria-hidden="true">Trying again in (?:9|10) s \(the only automatic attempt\)<\/small>/);
  assert.match(receipt, /<small>If it ends without a reply again, the agent stops\. Send it a message to continue\.<\/small>/);
  assert.match(receipt, /aria-label="Ash: The model returned no reply\. Trying again at [^"(]+ \(the only automatic attempt\)\. If it ends without a reply again, the agent stops\. Send it a message to continue\."/);
  assert.doesNotMatch(receipt, /of 3|all 3|waits for you|provider/);
  assert.equal(receipt.match(/<button/g)?.length, 2, "Try now and Stop trying are the same");
});

test("after the last automatic attempt the failed message says that the agent waits for its owner, with Retry; a follow-up that ended unstarted leaves its reason", async () => {
  const waiting = { state: "waiting_for_owner", sourceMessageId: "task-continuation:inbox_4", text: ATTEMPTS_FAILED, canRetry: true };
  const html = await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: waiting }]);
  const receipt = html.match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)?.[0];
  assert.ok(receipt);
  // The provider's own words stay, and the note is whole: it is not cut.
  assert.match(receipt, /<small>API Error: Repeated 529 Overloaded errors\.<\/small>/);
  assert.ok(receipt.includes(`<small>${ATTEMPTS_FAILED}</small>`));
  assert.ok(receipt.includes(`aria-label="Ash: API Error: Repeated 529 Overloaded errors. ${ATTEMPTS_FAILED}"`));
  // The existing Retry control, for the follow-up.
  assert.match(receipt, /<button type="button" aria-label="Retry delivery for Ash" title="Retry delivery">Retry<\/button>/);
  assert.equal(receipt.match(/<button/g)?.length, 1);
  assert.doesNotMatch(receipt, /Try now|Stop trying|Trying again/);
  const busy = await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: waiting }], { deliveryRetryKeys: new Set(["ash:task-continuation:inbox_4"]) });
  assert.match(busy, /disabled[^>]*aria-label="Retry delivery for Ash"[^>]*>Retrying…<\/button>/);
  const own = await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: waiting }], { deliveryRetryKeys: new Set(["ash:msg_1"]) });
  assert.match(own, />Retry<\/button>/, "a request of this message's own does not hold the follow-up's control");
  const unavailable = await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: waiting }], { deliveryRecoveryAvailable: false });
  assert.match(unavailable, /disabled aria-label="Retry delivery for Ash is unavailable"[^>]*>Retry unavailable<\/button>/);
  // A follow-up that is recovered another way has the text, and no control here.
  const other = await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: { ...waiting, canRetry: false } }]);
  assert.ok(other.includes(`<small>${ATTEMPTS_FAILED}</small>`));
  assert.doesNotMatch(other.match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)![0], /<button/);

  // Stopped by its owner, and each other way to end with nothing started: the reason stays on the message, with no control.
  for (const reason of [STOPPED_BY_OWNER,
    "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.",
    "The agent did not try again: the task is finished, or is no longer this agent's.",
    "The agent did not try again: an earlier action has an uncertain result. Check that result, then send an instruction to continue only the verified unfinished work."]) {
    const ended = (await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: { state: "ended", sourceMessageId: "task-continuation:inbox_1", text: reason, canRetry: false } }]))
      .match(/<li[^>]*data-state="acknowledged_failed"[\s\S]*?<\/li>/)?.[0];
    assert.ok(ended);
    const shown = reason.replace(/'/g, "&#39;");
    assert.ok(ended.includes(`<small>${shown}</small>`), reason);
    assert.ok(ended.includes(`aria-label="Ash: API Error: Repeated 529 Overloaded errors. ${shown}"`), reason);
    assert.match(ended, /<small>API Error: Repeated 529 Overloaded errors\.<\/small>/);
    assert.doesNotMatch(ended, /<button|Trying again/);
  }
  // A note with no text still says what happened.
  assert.match(await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: { state: "ended", sourceMessageId: "x", text: null, canRetry: false } }]), /<small>The agent did not try again\.<\/small>/);
  assert.match(await renderReceipts("msg_1", [{ ...failedReceipt, followUpNote: { state: "waiting_for_owner", sourceMessageId: "x", text: null, canRetry: true } }]),
    /<small>The agent stopped and now waits for you\.<\/small>/);
});

/** A mounted message whose script is live: its clock runs, and its controls can be used. */
function mountedMessage(props: Record<string, unknown>) {
  const renderer = createRenderer<any, any>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const emitted: unknown[][] = [];
  let vm: any;
  const app = renderer.createApp({
    setup() {
      vm = (DesktopChatMessage as any).setup(reactive({
        message: { id: "msg_1", sender: "EmmyMay", text: "continue", displayText: null, source: "browser", timestamp: "2026-10-09T14:30:00Z", attachments: [], agentIdentity: null },
        messageReferenceIds: new Set<string>(), taskReferenceIds: new Set<string>(), highlightQuery: "", context: "timeline", deliveryReceipts: [],
        threadSummary: { count: 0, unreadCount: 0, participants: [] }, deliveryRecoveryAvailable: true, roomDeliverySkipAvailable: true, ...props,
      }), { expose() {}, emit: (...args: unknown[]) => emitted.push(args) });
      return () => h("div");
    },
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  return { vm, emitted, unmount: () => app.unmount() };
}

test("Try now, Stop trying and Retry name the agent's follow-up, not the message they show on, and do nothing while they cannot be used", () => {
  const originalWindow = globalThis.window;
  Object.assign(globalThis, { window: { removeEventListener() {} } });
  const retry = { atMs: Date.now() + 100_000, attempt: 1, attempts: 3, kind: "provider_fault", sourceMessageId: "task-continuation:inbox_1" };
  const receipt = { agentId: "ash", agentName: "Ash", state: "acknowledged_failed", scheduledRetry: retry };
  const blocked = { agentId: "ash", agentName: "Ash", state: "acknowledged_failed",
    followUpNote: { state: "waiting_for_owner", sourceMessageId: "task-continuation:inbox_4", text: ATTEMPTS_FAILED, canRetry: true } };
  /** Use the controls of `clicked` on a mounted message with these props, and return what the message asked for. */
  const controls = (props: Record<string, unknown>, clicked: Record<string, unknown> = receipt) => {
    const mounted = mountedMessage({ deliveryReceipts: [clicked], ...props });
    mounted.vm.tryRetryNow(clicked);
    mounted.vm.stopRetrying(clicked);
    mounted.vm.retryFollowUp(clicked);
    mounted.unmount();
    return mounted.emitted;
  };
  try {
    assert.deepEqual(controls({}), [["retry-delivery", "ash", "task-continuation:inbox_1"], ["skip-delivery", "ash", "task-continuation:inbox_1"]]);
    // A request of this message's own, for a blocked delivery, holds neither control.
    assert.equal(controls({ deliveryRetryKeys: new Set(["ash:msg_1"]), roomDeliverySkipKeys: new Set(["ash:msg_1"]) }).length, 2);
    // While its own request is on its way, a control does nothing. The other still works.
    assert.deepEqual(controls({ deliveryRetryKeys: new Set(["ash:task-continuation:inbox_1"]) }), [["skip-delivery", "ash", "task-continuation:inbox_1"]]);
    assert.deepEqual(controls({ roomDeliverySkipKeys: new Set(["ash:task-continuation:inbox_1"]) }), [["retry-delivery", "ash", "task-continuation:inbox_1"]]);
    // Without the background service's retry or skip, that control does nothing.
    assert.deepEqual(controls({ deliveryRecoveryAvailable: false }), [["skip-delivery", "ash", "task-continuation:inbox_1"]]);
    assert.deepEqual(controls({ roomDeliverySkipAvailable: false }), [["retry-delivery", "ash", "task-continuation:inbox_1"]]);
    // A receipt with no follow-up has nothing to start, stop or retry.
    assert.deepEqual(controls({}, { agentId: "ash", scheduledRetry: null, followUpNote: null }), []);
    assert.deepEqual(controls({}, { agentId: "ash" }), []);

    // Retry on the message, for the follow-up that waits for its owner: the request names that follow-up.
    assert.deepEqual(controls({}, blocked), [["retry-delivery", "ash", "task-continuation:inbox_4"]]);
    assert.deepEqual(controls({ deliveryRetryKeys: new Set(["ash:msg_1"]) }, blocked), [["retry-delivery", "ash", "task-continuation:inbox_4"]]);
    assert.deepEqual(controls({ deliveryRetryKeys: new Set(["ash:task-continuation:inbox_4"]) }, blocked), []);
    assert.deepEqual(controls({ deliveryRecoveryAvailable: false }, blocked), []);
    // Not for one that is recovered another way, and not for one that ended.
    assert.deepEqual(controls({}, { ...blocked, followUpNote: { ...blocked.followUpNote, canRetry: false } }), []);
    assert.deepEqual(controls({}, { ...blocked, followUpNote: { state: "ended", sourceMessageId: "task-continuation:inbox_4", text: STOPPED_BY_OWNER, canRetry: false } }), []);
  } finally {
    Object.assign(globalThis, { window: originalWindow });
  }
});

test("the countdown that the message shows follows the saved time as the clock goes on, also across a sleep, and is read from the time each second", (t) => {
  const originalWindow = globalThis.window;
  Object.assign(globalThis, { window: { removeEventListener() {} } });
  // The time of day is the test's. A second passes only when the test says so, and the two are apart: after a
  // sleep the time is far ahead, and one tick comes.
  const start = Date.parse("2026-10-09T14:30:00.000Z");
  let now = start;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const receipt = { agentId: "ash", agentName: "Ash", state: "acknowledged_failed",
    scheduledRetry: { atMs: start + 100_000, attempt: 2, attempts: 3, kind: "provider_fault", sourceMessageId: "task-continuation:inbox_1" } };
  const mounted = mountedMessage({ deliveryReceipts: [receipt] });
  const second = (passedMs = 1_000) => { now += passedMs; t.mock.timers.tick(1_000); };
  try {
    const shown = () => mounted.vm.scheduledRetryText(receipt);
    assert.equal(shown(), "Trying again in 1 min 40 s (attempt 2 of 3)");
    second();
    assert.equal(shown(), "Trying again in 1 min 39 s (attempt 2 of 3)");
    second(); second();
    assert.equal(shown(), "Trying again in 1 min 37 s (attempt 2 of 3)");
    // The machine sleeps for a minute. One tick comes after it: the count is the saved time minus the time now.
    second(60_000);
    assert.equal(shown(), "Trying again in 37 s (attempt 2 of 3)");
    second(36_000);
    assert.equal(shown(), "Trying again in 1 s (attempt 2 of 3)");
    // At the time, and after it while the turn has not started.
    second();
    assert.equal(shown(), "About to try again (attempt 2 of 3)");
    second(120_000);
    assert.equal(shown(), "About to try again (attempt 2 of 3)");
    // The spoken label has the clock time, and follows the same clock.
    assert.match(mounted.vm.receiptLabel({ ...receipt, error: "It failed.", blockedByMessageId: null, terminalReason: null }), /^Ash: It failed\. About to try again \(attempt 2 of 3\)\. /);
    // A receipt with nothing scheduled shows no count.
    assert.equal(mounted.vm.scheduledRetryText({ agentId: "ash" }), "");
  } finally {
    mounted.unmount();
    Object.assign(globalThis, { window: originalWindow });
  }
  // The message's own markup shows that text, and nothing else counts.
  const source = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopChatMessage.vue", import.meta.url)), "utf8");
  assert.match(source, /<small aria-hidden="true">\{\{ scheduledRetryText\(receipt\) \}\}<\/small>/);
  assert.equal(source.match(/scheduledRetryLabel\(/g)?.length, 1, "the count is made in one place");
});

test("the second clock is off while nothing counts down, and stops with its owner", (t) => {
  let now = Date.parse("2026-10-09T14:30:00.000Z");
  const start = now;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const renderer = createRenderer<any, any>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  const active = ref(false);
  let clock!: { value: number };
  const app = renderer.createApp({ setup() { clock = useSecondClock(() => active.value); return () => h("div"); } });
  app.mount({});
  const second = (passedMs = 1_000) => { now += passedMs; t.mock.timers.tick(1_000); };
  second(5_000);
  assert.equal(clock.value, start, "nothing counts down: the clock does not run");
  // Something starts to count down: the clock is right at once, and then each second.
  active.value = true;
  return nextTick().then(async () => {
    assert.equal(clock.value, start + 5_000);
    second();
    assert.equal(clock.value, start + 6_000);
    // It reads the time. It does not add a second for each tick.
    second(3_600_000);
    assert.equal(clock.value, start + 3_606_000);
    active.value = false;
    await nextTick();
    second(9_000);
    assert.equal(clock.value, start + 3_606_000, "and it is off again");
    active.value = true;
    await nextTick();
    assert.equal(clock.value, start + 3_615_000);
    app.unmount();
    second(1_000);
    assert.equal(clock.value, start + 3_615_000, "no timer is left after its owner is gone");
  });
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
