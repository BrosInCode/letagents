import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
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

test("context-menu dismissal restores focus only for keyboard and copy actions", () => {
  assert.equal(shouldRestoreContextMenuFocus("escape"), true);
  assert.equal(shouldRestoreContextMenuFocus("copy"), true);
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
        { agentId: "oak", agentName: "Oak", state: "blocked", blockedByMessageId: null, error: null },
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
