import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computed,
  createSSRApp,
  h,
  ref,
  type Component,
} from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let AddAgentSignIn: Component;

const longSignInCommand = "env -i HOME='/Users/example/.letagents/home' CODEX_HOME='/Users/example/.codex' PATH='/usr/bin:/bin' claude auth login --scope full-length-example";

// In-app sign-in (#2141) replaced the sign-in command box; the command stays one click away
// as a fallback under the sign-in, with the copy button #2136 added.
const idleController = {
  update: ref(null), active: computed(() => false), pastedCode: ref(""), setPastedCode: () => undefined,
  submittingCode: ref(false), codeCopied: ref(false), error: ref(null),
  start: async () => undefined, submitCode: async () => undefined, cancel: async () => undefined,
  copyCode: async () => undefined, openLink: async () => undefined,
};
const signInProps = { controller: idleController, needsSignIn: true, authCommand: longSignInCommand, copying: false };

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  AddAgentSignIn = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/add-agent/AddAgentSignIn.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

test("a provider that needs sign-in keeps a Copy button for its sign-in command", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSignIn, signInProps),
  }));
  assert.match(html, /<button[^>]*class="desktop-add-agent-sign-in-quiet"[^>]*>\s*Copy the sign-in command instead\s*<\/button>/);
});

test("the Copy button shows Copying while a copy is in flight", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSignIn, { ...signInProps, copying: true }),
  }));
  assert.match(html, /<button[^>]*class="desktop-add-agent-sign-in-quiet"[^>]*disabled[^>]*>\s*Copying\.\.\.\s*<\/button>/);
});

test("the Copy button emits copy-command, which the modal wires to the shared copy helper", async () => {
  // The SSR-loaded component cannot mount in the test renderer, so the click wiring is read from source.
  const base = "../src/components/desktop/content";
  const signIn = await readFile(fileURLToPath(new URL(`${base}/add-agent/AddAgentSignIn.vue`, import.meta.url)), "utf8");
  const modal = await readFile(fileURLToPath(new URL(`${base}/AddAgentModal.vue`, import.meta.url)), "utf8");
  assert.match(signIn, /"copy-command": \[\]/);
  assert.match(signIn, /@click="emit\('copy-command'\)"/);
  assert.match(modal, /@copy-command="copyAgentAuthCommand\(\)"/);
  assert.match(modal, /:copying="copyingAuthCommand"/);
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
