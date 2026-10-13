import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let PersonWorkPanel: unknown;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  PersonWorkPanel = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/PersonWorkPanel.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

async function renderPanel(viewerLogin: string | null): Promise<string> {
  const context: { teleports?: Record<string, string> } = {};
  const app = createSSRApp({
    render: () => h(PersonWorkPanel as object, {
      target: { login: "mira", displayName: "Mira Patel", avatarUrl: null },
      roomId: "github.com/acme/app",
      viewerLogin,
    }),
  });
  const html = await renderToString(app, context);
  return `${html}${Object.values(context.teleports ?? {}).join("")}`;
}

test("person work panel renders the four sections and their empty lines with no events", async () => {
  const html = await renderPanel("owen");

  assert.match(html, /Open pull requests/);
  assert.match(html, /Waiting for review/);
  assert.match(html, /Reviews given/);
  assert.match(html, /Merged in the last 24 hours/);
  assert.match(html, /No open pull requests in this room/);
  assert.match(html, /No pull requests waiting for review in this room/);
  assert.match(html, /No reviews given in this room/);
  assert.match(html, /No pull requests merged in the last 24 hours/);
  assert.match(html, /Mira Patel/);
  assert.match(html, /@mira in this room/);
  assert.match(html, /aria-label="Close work panel"/);
  assert.doesNotMatch(html, /Your work/);
  // The events route does not name a room per event, so the panel has no room links.
  assert.doesNotMatch(html, /Go to room/);
});

test("person work panel labels the signed-in person's own work", async () => {
  const html = await renderPanel("Mira");
  assert.match(html, /Your work/);
});
