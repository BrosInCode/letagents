import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopProviderSignInUpdate,
} from "../../electron/ipc-types";
import {
  onboardingStateFromPreflight,
  onboardingUnavailableText,
  useOnboardingAgents,
} from "../src/components/desktop/onboarding/useOnboardingAgents";

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function provider(id: DesktopAgentProviderId, extra: Partial<DesktopAgentProvider> = {}): DesktopAgentProvider {
  return {
    id, name: id, description: "", capabilities: ["supervised_runtime"], runtimeCommand: id,
    mcpTargetId: null, permissionProfiles: [], defaultPermissionProfileId: null, ...extra,
  };
}

function preflight(providerId: DesktopAgentProviderId, status: DesktopAgentProviderPreflight["status"], extra: Partial<DesktopAgentProviderPreflight> = {}): DesktopAgentProviderPreflight {
  return {
    providerId, status, canStart: status === "ready", message: `${status} message`, detail: null,
    nextAction: null, version: null, mcpStatus: null, ...extra,
  };
}

const ALL: DesktopAgentProviderId[] = ["open-model", "codex", "antigravity", "claude-code", "cursor"];

interface Pending { id: DesktopAgentProviderId; resolve: (value: DesktopAgentProviderPreflight) => void }

function installBridge(options: { manual?: boolean; results?: Partial<Record<DesktopAgentProviderId, DesktopAgentProviderPreflight>> } = {}) {
  let push: ((update: DesktopProviderSignInUpdate) => void) | null = null;
  const calls: string[] = [];
  const pending: Pending[] = [];
  let running = 0;
  let maxRunning = 0;
  const results = { ...options.results };
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: {
        app: { openExternalUrl: async (url: string) => { calls.push(`open ${url}`); } },
        workers: {
          listAgentProviders: async () => ALL.map((id) => provider(id, id === "cursor" ? { runtimeInstallUrl: "https://cursor.com/cli" } : {})),
          runAgentProviderPreflight: (id: DesktopAgentProviderId) => {
            calls.push(`preflight ${id}`);
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            const done = (value: DesktopAgentProviderPreflight) => { running -= 1; return value; };
            if (options.manual) {
              return new Promise<DesktopAgentProviderPreflight>((resolve) => pending.push({ id, resolve: (value) => resolve(done(value)) }));
            }
            return Promise.resolve(done(results[id] ?? preflight(id, "ready")));
          },
          onProviderSignInUpdate: (callback: (update: DesktopProviderSignInUpdate) => void) => {
            push = callback;
            return () => { push = null; };
          },
          startProviderSignIn: async (id: DesktopAgentProviderId) => {
            calls.push(`start ${id}`);
            return { providerId: id, state: "waiting", url: `https://sign-in.example/${id}`, code: id === "codex" ? "AB-12" : null } satisfies DesktopProviderSignInUpdate;
          },
          submitProviderSignInCode: async (id: DesktopAgentProviderId, code: string) => {
            calls.push(`code ${id} ${code}`);
            return { providerId: id, state: "verifying" } satisfies DesktopProviderSignInUpdate;
          },
          cancelProviderSignIn: async (id: DesktopAgentProviderId) => { calls.push(`cancel ${id}`); },
        },
      },
    },
  });
  return {
    calls, pending, results,
    maxRunning: () => maxRunning,
    push: (update: DesktopProviderSignInUpdate) => push?.(update),
    subscribed: () => Boolean(push),
  };
}

function mount(active = ref(true)) {
  const scope = effectScope();
  const agents = scope.run(() => useOnboardingAgents({ active: () => active.value }))!;
  return { agents, scope, active };
}

test("preflight results map to the onboarding states", () => {
  assert.deepEqual(onboardingStateFromPreflight(preflight("codex", "ready")), { state: "ready", detail: "Signed in" });
  assert.deepEqual(onboardingStateFromPreflight(preflight("codex", "auth_required")), { state: "signin", detail: "Needs sign-in" });
  assert.deepEqual(onboardingStateFromPreflight(preflight("codex", "runtime_installed", { nextAction: "authenticate" })), { state: "signin", detail: "Needs sign-in" });
  assert.deepEqual(onboardingStateFromPreflight(preflight("cursor", "missing_runtime")), { state: "missing", detail: "Not installed" });
  assert.deepEqual(onboardingStateFromPreflight(preflight("cursor", "error", { nextAction: "install_external_runtime" })), { state: "missing", detail: "Not installed" });
  assert.deepEqual(
    onboardingStateFromPreflight(preflight("antigravity", "config_required", { message: "Update Antigravity to 1.5." })),
    { state: "unavailable", detail: "Update Antigravity to 1.5." },
  );
  // "ready" that still cannot start is not ready.
  assert.equal(onboardingStateFromPreflight(preflight("codex", "ready", { canStart: false })).state, "unavailable");
});

test("shows four providers in order, as checking first, then their states; ChatGPT names Codex", async () => {
  installBridge({ results: {
    codex: preflight("codex", "auth_required"),
    cursor: preflight("cursor", "missing_runtime"),
    antigravity: preflight("antigravity", "error", { message: "Antigravity crashed." }),
  } });
  const { agents, scope } = mount();
  assert.deepEqual(agents.providers.value.map((p) => p.state), ["checking", "checking", "checking", "checking"]);
  await settle();
  assert.deepEqual(agents.providers.value.map((p) => [p.id, p.name, p.state, p.detail]), [
    ["claude-code", "Claude Code", "ready", "Signed in"],
    ["codex", "ChatGPT", "signin", "Needs sign-in"],
    ["cursor", "Cursor", "missing", "Not installed"],
    ["antigravity", "Antigravity", "unavailable", "Antigravity crashed."],
  ]);
  assert.equal(agents.loading.value, false);
  scope.stop();
});

test("never runs more than two preflights at once, and never twice for one provider", async () => {
  const bridge = installBridge({ manual: true });
  const { agents, scope } = mount();
  await settle();
  assert.equal(bridge.pending.length, 2, "only two checks start");
  void agents.refresh();
  void agents.refresh();
  await settle();
  assert.equal(bridge.pending.length, 2, "a refresh while checks run starts nothing new");
  while (bridge.pending.length) {
    const next = bridge.pending.shift()!;
    next.resolve(preflight(next.id, "ready"));
    await settle();
  }
  assert.equal(bridge.maxRunning(), 2);
  const checks = bridge.calls.filter((call) => call.startsWith("preflight"));
  assert.deepEqual(checks, ["preflight claude-code", "preflight codex", "preflight cursor", "preflight antigravity"]);
  assert.ok(agents.providers.value.every((p) => p.state === "ready"));

  await agents.refresh();
  assert.equal(bridge.calls.filter((call) => call.startsWith("preflight")).length, 4, "a refresh within 10 s reuses results");
  const forced = agents.refresh(true);
  await settle();
  assert.equal(bridge.pending.length, 2, "a forced refresh checks again, still two at a time");
  while (bridge.pending.length) {
    const next = bridge.pending.shift()!;
    next.resolve(preflight(next.id, "ready"));
    await settle();
  }
  await forced;
  assert.equal(bridge.calls.filter((call) => call.startsWith("preflight")).length, 8);
  assert.equal(bridge.maxRunning(), 2);
  scope.stop();
});

test("one sign-in at a time; signed_in checks the provider again and makes it ready", async () => {
  const bridge = installBridge({ results: {
    codex: preflight("codex", "auth_required"),
    "claude-code": preflight("claude-code", "auth_required"),
  } });
  const { agents, scope } = mount();
  await settle();

  await agents.signIn("codex");
  const codex = () => agents.providers.value.find((p) => p.id === "codex")!;
  const claude = () => agents.providers.value.find((p) => p.id === "claude-code")!;
  assert.equal(codex().state, "signing-in");
  assert.deepEqual(codex().signIn, { url: "https://sign-in.example/codex", code: "AB-12", acceptsCode: false, inTerminal: false, verifying: false });

  await agents.signIn("claude-code");
  assert.deepEqual(bridge.calls.filter((call) => /^(start|cancel)/.test(call)), ["start codex", "cancel codex", "start claude-code"]);
  assert.equal(codex().state, "signin");
  assert.equal(codex().signIn, undefined);
  assert.equal(claude().state, "signing-in");

  bridge.push({ providerId: "codex", state: "signed_in" });
  assert.equal(codex().state, "signin", "an update for a cancelled sign-in is ignored");

  bridge.push({ providerId: "claude-code", state: "waiting", url: "https://claude.example/auth", acceptsCode: true });
  await agents.openSignInLink("claude-code");
  await agents.submitCode("claude-code", "  pasted#code ");
  assert.ok(bridge.calls.includes("open https://claude.example/auth"));
  assert.ok(bridge.calls.includes("code claude-code pasted#code"));
  assert.equal(claude().signIn?.verifying, true);

  bridge.results["claude-code"] = preflight("claude-code", "ready");
  const before = bridge.calls.filter((call) => call === "preflight claude-code").length;
  bridge.push({ providerId: "claude-code", state: "signed_in" });
  assert.equal(claude().signIn?.verifying, true, "verifying until the check answers");
  await settle();
  assert.equal(bridge.calls.filter((call) => call === "preflight claude-code").length, before + 1);
  assert.equal(claude().state, "ready");
  assert.equal(claude().signIn, undefined);
  scope.stop();
});

test("a failed sign-in returns to needs sign-in with a message", async () => {
  const bridge = installBridge({ results: { codex: preflight("codex", "auth_required") } });
  const { agents, scope } = mount();
  await settle();
  await agents.signIn("codex");
  bridge.push({ providerId: "codex", state: "failed", message: "The code expired." });
  assert.equal(agents.providers.value.find((p) => p.id === "codex")!.state, "signin");
  assert.equal(agents.signInError.value, "The code expired.");
  scope.stop();
});

test("does nothing while inactive; leaving the step ends a sign-in; dispose unsubscribes", async () => {
  const bridge = installBridge({ results: { codex: preflight("codex", "auth_required") } });
  const active = ref(false);
  const { agents, scope } = mount(active);
  await settle();
  assert.equal(bridge.calls.length, 0);
  await agents.refresh();
  assert.equal(bridge.calls.length, 0);

  active.value = true;
  await nextTick();
  await settle();
  assert.equal(bridge.calls.filter((call) => call.startsWith("preflight")).length, 4);

  await agents.openInstall("cursor");
  assert.ok(bridge.calls.includes("open https://cursor.com/cli"));

  await agents.signIn("codex");
  active.value = false;
  await nextTick();
  await settle();
  assert.ok(bridge.calls.includes("cancel codex"));
  bridge.push({ providerId: "codex", state: "waiting", url: "https://late.example" });
  assert.equal(agents.providers.value.find((p) => p.id === "codex")!.state, "signin");

  scope.stop();
  assert.equal(bridge.subscribed(), false);
});

test("three fast sign-in clicks leave one sign-in, and no row stuck on Signing in", async () => {
  const bridge = installBridge({ results: {
    "claude-code": preflight("claude-code", "auth_required"),
    codex: preflight("codex", "auth_required"),
    cursor: preflight("cursor", "auth_required"),
  } });
  const { agents, scope } = mount();
  await settle();
  await agents.signIn("claude-code");
  // B waits for A's cancel; C is clicked in that gap.
  const b = agents.signIn("codex");
  const c = agents.signIn("cursor");
  await Promise.all([b, c]);
  await settle();
  const states = Object.fromEntries(agents.providers.value.map((p) => [p.id, p.state]));
  assert.equal(states.cursor, "signing-in", "the last click owns the sign-in");
  assert.equal(states.codex, "signin");
  assert.equal(states["claude-code"], "signin");
  assert.equal(agents.providers.value.filter((p) => p.state === "signing-in").length, 1);
  assert.ok(!bridge.calls.includes("start codex"), "the overtaken click starts nothing");
  scope.stop();
});

test("an unavailable agent's note never names the agent twice", () => {
  assert.equal(onboardingUnavailableText("Claude Code", "Update it to 2.1."), "Claude Code can't start yet: Update it to 2.1.");
  assert.equal(onboardingUnavailableText("Claude Code", "Couldn't check Claude Code: timed out"), "Couldn't check Claude Code: timed out");
  assert.match(onboardingUnavailableText("Cursor", "Choose a local repository before starting Cursor."), /^Cursor works inside a project folder\./);
  assert.equal(onboardingUnavailableText("Cursor", "Cursor needs an update."), "Cursor needs an update.");
  assert.equal(onboardingUnavailableText("Cursor", ""), "Cursor can't start yet.");
});
