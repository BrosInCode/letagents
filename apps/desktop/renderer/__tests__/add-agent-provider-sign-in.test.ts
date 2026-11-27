import assert from "node:assert/strict";
import test from "node:test";
import { nextTick, ref } from "vue";
import type { DesktopAgentProviderId, DesktopProviderSignInUpdate } from "../../electron/ipc-types";
import { useProviderSignIn } from "../src/components/desktop/content/add-agent/useProviderSignIn";

function installBridge() {
  let push: ((update: DesktopProviderSignInUpdate) => void) | null = null;
  const calls: string[] = [];
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: {
        app: { openExternalUrl: async (url: string) => { calls.push(`open ${url}`); } },
        workers: {
          onProviderSignInUpdate: (callback: (update: DesktopProviderSignInUpdate) => void) => {
            push = callback;
            return () => { push = null; };
          },
          startProviderSignIn: async (providerId: DesktopAgentProviderId) => {
            calls.push(`start ${providerId}`);
            return { providerId, state: "starting" } satisfies DesktopProviderSignInUpdate;
          },
          submitProviderSignInCode: async (providerId: DesktopAgentProviderId, code: string) => {
            calls.push(`code ${providerId} ${code}`);
            return { providerId, state: "verifying", acceptsCode: false } satisfies DesktopProviderSignInUpdate;
          },
          cancelProviderSignIn: async (providerId: DesktopAgentProviderId) => { calls.push(`cancel ${providerId}`); },
        },
      },
    },
  });
  return { calls, push: (update: DesktopProviderSignInUpdate) => push?.(update) };
}

test("Add Agent sign-in follows the selected provider and re-checks it once signed in", async () => {
  const bridge = installBridge();
  const open = ref(true);
  const providerId = ref<DesktopAgentProviderId | null>("claude-code");
  const signedIn: DesktopProviderSignInUpdate[] = [];
  const signIn = useProviderSignIn({
    open: () => open.value,
    providerId: () => providerId.value,
    providerName: () => "Claude Code",
    onSignedIn: (update) => signedIn.push(update),
  });

  await signIn.start();
  assert.deepEqual(bridge.calls, ["start claude-code"]);
  assert.equal(signIn.active.value, true);

  bridge.push({ providerId: "codex", state: "waiting", url: "https://example.invalid/other" });
  assert.equal(signIn.update.value?.url, undefined, "another provider's update is ignored");

  bridge.push({ providerId: "claude-code", state: "waiting", url: "https://claude.com/cai/oauth/authorize?x=1", acceptsCode: true });
  await signIn.openLink();
  signIn.setPastedCode(" abc#def ");
  await signIn.submitCode();
  assert.deepEqual(bridge.calls.slice(1), ["open https://claude.com/cai/oauth/authorize?x=1", "code claude-code abc#def"]);
  assert.equal(signIn.update.value?.state, "verifying");
  assert.equal(signIn.pastedCode.value, "");

  bridge.push({ providerId: "claude-code", state: "signed_in", message: "Signed in to Claude Code." });
  assert.equal(signIn.update.value, null);
  assert.equal(signIn.active.value, false);
  assert.deepEqual(signedIn.map((update) => update.message), ["Signed in to Claude Code."]);
});

test("Add Agent sign-in keeps a failure on screen and cancels when the provider changes or the window closes", async () => {
  const bridge = installBridge();
  const open = ref(true);
  const providerId = ref<DesktopAgentProviderId | null>("codex");
  const signIn = useProviderSignIn({
    open: () => open.value,
    providerId: () => providerId.value,
    providerName: () => "Codex",
    onSignedIn: () => assert.fail("not signed in"),
  });

  await signIn.start();
  bridge.push({ providerId: "codex", state: "failed", message: "Error: device code expired" });
  assert.equal(signIn.active.value, false);
  assert.equal(signIn.update.value?.message, "Error: device code expired");

  await signIn.start();
  bridge.push({ providerId: "codex", state: "waiting", url: "https://auth.openai.com/codex/device", code: "37UV-E7QNH" });
  providerId.value = "cursor";
  await nextTick();
  assert.equal(signIn.update.value, null);
  assert.ok(bridge.calls.includes("cancel codex"));

  providerId.value = "codex";
  await nextTick();
  await signIn.start();
  bridge.push({ providerId: "codex", state: "waiting", url: "https://auth.openai.com/codex/device" });
  open.value = false;
  await nextTick();
  assert.equal(bridge.calls.filter((call) => call === "cancel codex").length, 2);
  assert.equal(signIn.update.value, null);
});
