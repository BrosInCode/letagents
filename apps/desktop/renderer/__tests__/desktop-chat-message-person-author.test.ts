import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

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

function message(overrides: Record<string, unknown>) {
  return {
    id: "msg_author",
    attachments: [],
    agentPromptKind: null,
    timestamp: "2026-10-13T12:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    threadRootId: null,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
    text: "Hello room",
    ...overrides,
  };
}

async function renderMessage(msg: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({
    render: () => h(DesktopChatMessage as object, {
      context: "timeline",
      message: msg,
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
      testId: "room-message-msg_author",
    }),
  });
  app.provide(ssrContextKey, { modules: new Set() });
  return renderToString(app);
}

test("a human sender with a GitHub login renders a button that opens the person menu", async () => {
  const html = await renderMessage(message({
    sender: "Ana Lee",
    source: "browser",
    senderProfile: { login: "ana-lee", avatarUrl: null },
  }));
  assert.match(html, /<button[^>]*class="room-message-author-button is-person-author"[^>]*>\s*Ana Lee\s*<\/button>/);
  assert.doesNotMatch(html, /<strong>Ana Lee<\/strong>/);
});

test("a system sender keeps the plain strong author", async () => {
  const html = await renderMessage(message({
    sender: "letagents",
    source: "room",
    senderProfile: null,
  }));
  assert.doesNotMatch(html, /is-person-author/);
  assert.match(html, /<strong>letagents<\/strong>/);
});
