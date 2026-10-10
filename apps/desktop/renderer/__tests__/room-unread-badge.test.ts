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
});
