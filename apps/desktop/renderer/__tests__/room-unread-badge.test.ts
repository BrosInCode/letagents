import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let RoomUnreadBadge: object;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  RoomUnreadBadge = (await vite.ssrLoadModule("/renderer/src/components/desktop/sidebar/RoomUnreadBadge.vue")).default;
});
after(async () => { await vite?.close(); });

test("unread badges show bounded numbers, exact accessible counts and manual markers", async () => {
  const render = (count: number, markedUnread = false) => renderToString(createSSRApp(RoomUnreadBadge, { count, markedUnread }));
  assert.doesNotMatch(await render(0), /room-unread/);
  assert.match(await render(1), /aria-label="1 unread message"[^>]*>1<\/span>/);
  assert.match(await render(145), /aria-label="145 unread messages"[^>]*>99\+<\/span>/);
  assert.match(await render(0, true), /class="room-unread-dot" aria-label="Marked unread"/);
  const grouped = await renderToString(createSSRApp(RoomUnreadBadge, { count: 23, label: "23 unread messages in 3 rooms" }));
  assert.match(grouped, /aria-label="23 unread messages in 3 rooms" title="23 unread messages in 3 rooms">23<\/span>/, "a group total says which rooms it spans");
  const bounded = await renderToString(createSSRApp(RoomUnreadBadge, { count: 124, label: "124 unread messages in 2 rooms" }));
  assert.match(bounded, /aria-label="124 unread messages in 2 rooms"[^>]*>99\+<\/span>/, "the label stays exact when the number is bounded");
  assert.doesNotMatch(bounded, /\slabel=/, "the label is a prop, not an attribute on the span");
  const unlabeled = await renderToString(createSSRApp(RoomUnreadBadge, { count: 2, label: undefined }));
  assert.match(unlabeled, /aria-label="2 unread messages"/, "an undefined label falls back to the plain count");
});
