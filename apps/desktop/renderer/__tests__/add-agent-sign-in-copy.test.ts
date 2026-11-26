import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSSRApp,
  h,
  type Component,
} from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let AddAgentSetupStatus: Component;

const longSignInCommand = "env -i HOME='/Users/example/.letagents/home' CODEX_HOME='/Users/example/.codex' PATH='/usr/bin:/bin' claude auth login --scope full-length-example";

const setupProps = {
  providerName: "Claude",
  preflight: { status: "auth_required", nextAction: "authenticate" },
  loading: false,
  statusTitle: "Sign in to Claude",
  statusDescription: "Sign in to your agent app, then check again.",
  runtimeLabel: "Claude Code",
  bridgeLabel: "Connected",
  repoLabel: "Ready",
  showSecureStorage: false,
  secureStorageLabel: null,
  secureStorageNeedsAttention: false,
  canOpenSecureStorage: false,
  showWorktrees: false,
  worktrees: [],
  worktreeDescription: "",
  authCommand: longSignInCommand,
  installCommand: null,
  error: null,
};

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  AddAgentSetupStatus = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/add-agent/AddAgentSetupStatus.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

test("the sign-in command box shows a Copy button and the full, unclipped command", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, setupProps),
  }));
  assert.match(html, /<button[^>]*class="desktop-add-agent-auth-copy"[^>]*>\s*Copy sign-in command\s*<\/button>/);
  // The whole command is in the page text, not cut to a prefix with an ellipsis.
  assert.match(html, /claude auth login --scope full-length-example/);
  assert.match(html, /CODEX_HOME=&#39;\/Users\/example\/\.codex&#39;/);
  assert.doesNotMatch(html, /…/);
});

test("the Copy button shows Copying while a copy is in flight", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, { ...setupProps, copyingAuthCommand: true }),
  }));
  assert.match(html, /<button[^>]*class="desktop-add-agent-auth-copy"[^>]*disabled[^>]*>\s*Copying\.\.\.\s*<\/button>/);
});

test("the Copy button emits copy-auth-command, which the modal wires to the shared copy helper", async () => {
  // The SSR-loaded component cannot mount in the test renderer, so the click wiring is read from source.
  const base = "../src/components/desktop/content";
  const status = await readFile(fileURLToPath(new URL(`${base}/add-agent/AddAgentSetupStatus.vue`, import.meta.url)), "utf8");
  const modal = await readFile(fileURLToPath(new URL(`${base}/AddAgentModal.vue`, import.meta.url)), "utf8");
  assert.match(status, /"copy-auth-command": \[\];/);
  assert.match(status, /class="desktop-add-agent-auth-copy"[\s\S]*?@click="emit\('copy-auth-command'\)"/);
  assert.match(modal, /@copy-auth-command="copyAgentAuthCommand"/);
  assert.match(modal, /:copying-auth-command="copyingAuthCommand"/);
});

test("the sign-in command wraps instead of truncating with an ellipsis", async () => {
  const css = await readFile(
    fileURLToPath(new URL("../src/components/desktop/content/add-agent/AddAgentSetupStatus.css", import.meta.url)),
    "utf8",
  );
  const rule = css.match(/\.desktop-add-agent-auth-command code \{[^}]*\}/)?.[0] ?? "";
  assert.ok(rule, "the sign-in command code block must have its own rule");
  assert.doesNotMatch(rule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/);
  assert.match(rule, /white-space:\s*pre-wrap/);
});
