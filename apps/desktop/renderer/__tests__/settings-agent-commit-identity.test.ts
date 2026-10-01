import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp } from "vue";
import { createServer, type ViteDevServer } from "vite";

import { agentCommitIdentityDescription } from "../src/components/desktop/settings/presentation.ts";

const FAKE_IDENTITY = { name: "octo-fake", email: "424242+octo-fake@users.noreply.github.com" };

test("the agent commit setting says who agents commit as", () => {
  assert.equal(agentCommitIdentityDescription(null), "Checking how agents commit…");
  assert.equal(
    agentCommitIdentityDescription({ useHostGitIdentity: false, githubIdentity: FAKE_IDENTITY }),
    "In GitHub repositories that would use your global Git email, agents commit as octo-fake <424242+octo-fake@users.noreply.github.com> instead. Applies when an agent next starts.",
  );
  assert.match(
    agentCommitIdentityDescription({ useHostGitIdentity: false, githubIdentity: null }),
    /^Connect GitHub so agents commit without your Git email/,
  );
  assert.match(
    agentCommitIdentityDescription({ useHostGitIdentity: true, githubIdentity: FAKE_IDENTITY }),
    /^Agents commit with this Mac's own Git name and email/,
  );
});

let vite: ViteDevServer;
let SettingsAgentsPane: unknown;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  SettingsAgentsPane = (await vite.ssrLoadModule("/renderer/src/components/desktop/settings/panes/SettingsAgentsPane.vue")).default;
});

after(async () => {
  await vite?.close();
});

test("the Agents pane offers the commit identity as the shared switch", async () => {
  const html = await renderToString(createSSRApp(SettingsAgentsPane as never, { workers: [], rooms: [] }));
  assert.match(html, /class="desktop-switch"[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Commit as your GitHub account"/);
  assert.match(html, /aria-describedby="settings-agent-commit-identity-description"/);
  assert.match(html, /id="settings-agent-commit-identity-description"[^>]*>Checking how agents commit…</);
  assert.match(html, /data-testid="settings-agent-commit-identity"/);
  assert.match(html, /No agents yet\./);
});
