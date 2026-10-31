import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let MessageSearchResults: object;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true, fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
  });
  MessageSearchResults = (await vite.ssrLoadModule("../../shared/ui/MessageSearchResults.vue")).default;
});

after(async () => {
  await vite?.close();
});

const hit = (id: string, text: string) => ({ id, sender: "Ada", timestamp: "2026-10-02T12:00:00.000Z", text });
const render = (props: Record<string, unknown>) => renderToString(createSSRApp({
  render: () => h(MessageSearchResults, {
    status: "ready", hits: [], terms: ["mint"], hasMore: false, loadingMore: false, error: null,
    loadedMatchCount: 0, formatTime: () => "Oct 2", ...props,
  }),
}));

test("nothing is shown until there is something to search", async () => {
  assert.equal((await render({ status: "idle" })).replace(/<!--.*?-->/g, ""), "");
});

test("results list the sender, time and a highlighted excerpt, with a way into the room", async () => {
  const html = (await render({ hits: [hit("msg_9", "The worker mint had no lock."), hit("msg_4", "<img src=x onerror=alert(1)> mint")], hasMore: true })).replace(/<!--.*?-->/gs, "");
  assert.match(html, /All matches in this room/);
  assert.match(html, />2\+</, "more pages are signalled on the count");
  assert.match(html, /<strong>Ada<\/strong>/);
  assert.match(html, /<time datetime="2026-10-02T12:00:00.000Z">Oct 2<\/time>/);
  assert.match(html, /The worker <mark>mint<\/mark> had no lock\./);
  assert.equal(html.match(/Show in room/g)?.length, 2);
  assert.match(html, /Show more/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; <mark>mint<\/mark>/, "message text is always text");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /aria-expanded="false"/);
});

test("each state says what is happening", async () => {
  assert.match(await render({ status: "loading" }), /Searching earlier messages…/);
  assert.match(await render({ status: "invalid", error: "too_many_terms" }), /at most 6 words or quoted phrases/);
  assert.match(await render({ status: "invalid", error: "too_long" }), /at most 200 characters/);
  assert.match(await render({ status: "error", error: "This search took too long." }), /role="alert"[^>]*>This search took too long\./);
  assert.match(await render({}), /No messages in this room match\./);
  assert.match(await render({ hits: [hit("msg_9", "mint")], hasMore: true, loadingMore: true }), /<button[^>]*disabled[^>]*>\s*Loading…/);
});

test("the list stays quiet when only the on-screen find has matches", async () => {
  // The find on loaded messages also matches sender and attachment names.
  assert.equal((await render({ loadedMatchCount: 3 })).replace(/<!--.*?-->/g, ""), "");
});


test("the web panel wires search state, load more and the existing reveal path", () => {
  const source = readFileSync(new URL('../src/pages/room/RoomTabPanels.vue', import.meta.url), 'utf8');
  for (const binding of [':status="historySearch.state.value.status"', ':hits="historySearch.hits.value"',
    '@show="openMessageInChat"', '@more="historySearch.loadMore()"', ':revealMessageId="revealMessageId"']) {
    assert.ok(source.includes(binding), binding);
  }
  assert.match(source, /function openMessageInChat[\s\S]*revealMessageId.value = messageId/);
});
