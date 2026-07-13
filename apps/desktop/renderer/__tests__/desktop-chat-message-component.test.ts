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
        text: "Thread reply",
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
    }),
  });

  const html = await renderToString(app);
  assert.match(html, /data-thread-message-id="msg_thread_reply"/);
  assert.match(html, /data-testid="room-thread-reply-msg_thread_reply"/);
  assert.match(html, /aria-label="Copy message"/);
  assert.match(html, /aria-label="Jump to root"/);
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
