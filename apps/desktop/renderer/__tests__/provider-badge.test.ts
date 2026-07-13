import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let ProviderBadge: object;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ProviderBadge = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/desktop-chat-message/ProviderBadge.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

async function renderBadge(label: string): Promise<string> {
  return renderToString(createSSRApp(ProviderBadge, { label }));
}

test("provider badges render platform artwork with accessible names", async () => {
  for (const [label, providerKey] of [
    ["Codex", "codex"],
    ["Claude Code", "claude"],
    ["Antigravity", "antigravity"],
    ["Cursor", "cursor"],
  ] as const) {
    const html = await renderBadge(label);
    assert.match(html, new RegExp(`room-provider-badge--${providerKey}`));
    assert.match(html, new RegExp(`aria-label="${label} provider"`));
    assert.match(html, /<img/);
  }
});

test("provider badges preserve meaningful fallback labels", async () => {
  const openModel = await renderBadge("Open Model");
  assert.match(openModel, /room-provider-badge--open-model/);
  assert.match(openModel, /aria-label="Open Model provider"/);
  assert.doesNotMatch(openModel, /<img/);

  const unknown = await renderBadge("Future IDE");
  assert.match(unknown, /room-provider-badge--other/);
  assert.match(unknown, /aria-label="Future IDE provider"/);
  assert.doesNotMatch(unknown, /aria-label="Other provider"/);
});
