import "./isolated-home.js";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { DesktopAgentProviderId, DesktopProviderSignInUpdate } from "../ipc-types.js";
import {
  parseSignInOutput,
  ProviderSignInService,
  resolveProviderSignInPlan,
  type ProviderSignInDependencies,
  type ProviderSignInPlan,
} from "../main/agents/provider-sign-in.js";
import { providerCli } from "../main/agents/provider-cli.js";
import { antigravityChildEnvironment } from "#provider-runtime/agents/antigravity/launch.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: string[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.written.push(String(chunk)));
  }

  print(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    this[stream].write(text);
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function plan(overrides: Partial<ProviderSignInPlan> = {}): ProviderSignInPlan {
  return {
    mode: "process",
    providerName: "Codex",
    command: "/fake/codex",
    args: ["login", "--device-auth"],
    env: {},
    verify: async () => true,
    ...overrides,
  };
}

function harness(options: { plan?: ProviderSignInPlan; deps?: Partial<ProviderSignInDependencies> } = {}) {
  const children: FakeChild[] = [];
  const stopped: FakeChild[] = [];
  const updates: DesktopProviderSignInUpdate[] = [];
  const order: string[] = [];
  const spawned: ProviderSignInPlan[] = [];
  const service = new ProviderSignInService({
    resolvePlan: () => options.plan ?? plan(),
    spawnProcess: (nextPlan) => {
      spawned.push(nextPlan);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    stopProcess: (child) => { stopped.push(child as unknown as FakeChild); },
    openTerminal: async () => { order.push("terminal"); },
    onSignedIn: () => { order.push("probe-cache-cleared"); },
    timeoutMs: 60_000,
    pollIntervalMs: 5,
    ...options.deps,
  });
  service.onUpdate((update) => {
    updates.push(update);
    order.push(update.state);
  });
  return { service, children, stopped, updates, order, spawned };
}

test("sign-in output parsing finds the link, the device code and the paste prompt through colours", () => {
  const codex = parseSignInOutput([
    "Welcome to Codex [v\u001b[90m0.171.0\u001b[0m]",
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "1. Open this link in your browser and sign in to your account",
    "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
    "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
    "   \u001b[94m37UV-E7QNH\u001b[0m",
  ].join("\n"));
  assert.equal(codex.url, "https://auth.openai.com/codex/device");
  assert.equal(codex.code, "37UV-E7QNH");
  assert.equal(codex.acceptsCode, false);

  // `codex login` (the browser sign-in the app runs): the local callback is
  // http, so the first https link is the sign-in page, and there is no code.
  const codexBrowser = parseSignInOutput([
    "Starting local login server on http://localhost:1455.",
    "If your browser did not open, navigate to this URL to authenticate:",
    "",
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=ABCD-EFGHI",
    "",
    "On a remote or headless machine? Use `codex login --device-auth` instead.",
  ].join("\n"));
  assert.match(codexBrowser.url ?? "", /^https:\/\/auth\.openai\.com\/oauth\/authorize\?response_type=code&/);
  assert.equal(codexBrowser.code, null);
  assert.equal(codexBrowser.acceptsCode, false);

  const claude = parseSignInOutput([
    "Opening browser to sign in…",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=ABCD-EFGHI&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
    "\u001b[1mPaste code here if prompted > \u001b[22m",
  ].join("\r\n"));
  assert.match(claude.url ?? "", /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=9d1c&state=ABCD-EFGHI&redirect_uri=/);
  assert.equal(claude.code, null, "a code-shaped value inside the link is not a device code");
  assert.equal(claude.acceptsCode, true);
  assert.match(claude.lastLine ?? "", /^If the browser didn't open/);

  const cursor = parseSignInOutput("Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=x1&uuid=7f2a.\nWaiting for browser login...");
  assert.equal(cursor.url, "https://cursor.com/loginDeepControl?challenge=x1&uuid=7f2a");
  assert.equal(cursor.code, null);
  assert.equal(cursor.lastLine, "Waiting for browser login...");

  assert.equal(parseSignInOutput("Signed in on 2026-1126 build 1234-56789").code, null, "digits only are not a code");
});

test("a login that exits 0 is verified, the probe memo is cleared, then it reports signed in", async () => {
  const { service, children, updates, order } = harness();
  const first = await service.start("codex");
  assert.equal(first.state, "starting");
  children[0]!.print("Open https://auth.openai.com/codex/device\n");
  children[0]!.print("Code: 37UV-E7QNH\n", "stderr");
  await settle();
  assert.deepEqual(
    { state: updates.at(-1)!.state, url: updates.at(-1)!.url, code: updates.at(-1)!.code },
    { state: "waiting", url: "https://auth.openai.com/codex/device", code: "37UV-E7QNH" },
  );
  children[0]!.exit(0);
  await settle();
  assert.deepEqual(order.filter((step) => step !== "waiting"), ["starting", "verifying", "probe-cache-cleared", "signed_in"]);
  assert.equal(updates.at(-1)!.message, "Signed in to Codex.");
  assert.equal(service.current("codex")?.state, "signed_in");
});

test("a login that exits non-zero fails with the provider's last useful line", async () => {
  const { service, children, updates, order } = harness();
  await service.start("codex");
  children[0]!.print("Error: login was cancelled in the browser\n", "stderr");
  await settle();
  children[0]!.exit(1);
  await settle();
  assert.equal(updates.at(-1)!.state, "failed");
  assert.equal(updates.at(-1)!.message, "Error: login was cancelled in the browser");
  assert.ok(!order.includes("probe-cache-cleared"));
});

test("a login that exits 0 but still reports signed out fails", async () => {
  const { service, children, updates, order } = harness({ plan: plan({ verify: async () => false }) });
  await service.start("codex");
  children[0]!.exit(0);
  await settle();
  assert.equal(updates.at(-1)!.state, "failed");
  assert.match(updates.at(-1)!.message ?? "", /still reports that it is signed out/);
  assert.ok(!order.includes("probe-cache-cleared"));
});

test("cancel ends the process tree and ignores its later exit", async () => {
  const { service, children, stopped, updates } = harness();
  await service.start("codex");
  service.cancel("codex");
  assert.deepEqual(stopped, [children[0]]);
  assert.equal(updates.at(-1)!.state, "cancelled");
  const count = updates.length;
  children[0]!.exit(0);
  await settle();
  assert.equal(updates.length, count, "no update after a cancel");
  assert.equal(children[0]!.stdin.writable, false, "stdin is closed");
});

test("a sign-in that runs past the time limit fails and is stopped", async () => {
  const { service, children, stopped, updates } = harness({ deps: { timeoutMs: 20 } });
  await service.start("codex");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(updates.at(-1)!.state, "failed");
  assert.match(updates.at(-1)!.message ?? "", /did not finish/);
  assert.deepEqual(stopped, [children[0]]);
});

test("a pasted code goes to the provider's stdin, and a new prompt asks again", async () => {
  const { service, children, updates } = harness({ plan: plan({ providerName: "Claude Code", args: ["auth", "login"] }) });
  assert.throws(() => service.submitCode("claude-code", "abc"), /No sign-in is waiting/);
  await service.start("claude-code");
  const child = children[0]!;
  child.print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?x=1\nPaste code here if prompted > ");
  await settle();
  assert.equal(updates.at(-1)!.acceptsCode, true);
  assert.throws(() => service.submitCode("claude-code", "two words"), /exactly as the browser shows/);
  const afterSubmit = service.submitCode("claude-code", "  code-123#state-456 ");
  await settle();
  assert.deepEqual(child.written, ["code-123#state-456\n"]);
  assert.deepEqual({ state: afterSubmit.state, acceptsCode: afterSubmit.acceptsCode }, { state: "verifying", acceptsCode: false });
  child.print("Invalid code.\nPaste code here if prompted > ");
  await settle();
  assert.deepEqual({ state: updates.at(-1)!.state, acceptsCode: updates.at(-1)!.acceptsCode }, { state: "waiting", acceptsCode: true });
  child.exit(0);
  await settle();
  assert.equal(updates.at(-1)!.state, "signed_in");
});

test("one sign-in runs per provider at a time", async () => {
  const { service, spawned } = harness();
  await service.start("codex");
  const again = await service.start("codex");
  assert.equal(again.state, "starting");
  assert.equal(spawned.length, 1);
});

test("a provider command that cannot start fails with its name", async () => {
  const { service, children, updates } = harness();
  await service.start("codex");
  children[0]!.emit("error", Object.assign(new Error("spawn /fake/codex ENOENT"), { code: "ENOENT" }));
  children[0]!.emit("close", null, null);
  await settle();
  assert.equal(updates.at(-1)!.state, "failed");
  assert.match(updates.at(-1)!.message ?? "", /could not find the Codex command \(\/fake\/codex\)/);
  assert.equal(updates.filter((update) => update.state === "failed").length, 1);
});

test("an unknown sign-in plan fails without spawning", async () => {
  const { service, spawned, updates } = harness({ deps: { resolvePlan: () => { throw new Error("Open Model has no sign-in that LetAgents can run."); } } });
  const result = await service.start("open-model");
  assert.equal(result.state, "failed");
  assert.equal(updates.at(-1)!.message, "Open Model has no sign-in that LetAgents can run.");
  assert.equal(spawned.length, 0);
});

test("a Terminal sign-in checks the provider until it is signed in", async () => {
  let checks = 0;
  const { service, updates, order, spawned } = harness({
    plan: plan({ mode: "terminal", providerName: "Antigravity", command: "/fake/agy", args: [], verify: async () => ++checks >= 2 }),
  });
  await service.start("antigravity");
  assert.equal(spawned.length, 0);
  assert.equal(updates.at(-1)!.state, "waiting");
  assert.equal(updates.at(-1)!.inTerminal, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(checks, 2);
  assert.deepEqual(order, ["starting", "terminal", "waiting", "probe-cache-cleared", "signed_in"]);
});

test("sign-in runs each provider's program in the environment its preflight uses", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/fake/bin:/usr/bin",
    HOME: "/preview/home",
    CODEX_HOME: "/preview/home/.codex",
    CLAUDE_CONFIG_DIR: "/preview/home/.claude",
    LETAGENTS_CODEX_BIN: "/fake/bin/codex",
    LETAGENTS_CLAUDE_CODE_BIN: "/fake/bin/claude",
    LETAGENTS_CURSOR_AGENT_BIN: "/fake/bin/cursor-agent",
    LETAGENTS_ANTIGRAVITY_BIN: "/fake/bin/agy",
    LETAGENTS_CURSOR_SOURCE_HOME: "/cursor/source-home",
    CURSOR_API_KEY: "must-not-pass",
  };
  const expected: Record<string, { args: string[] }> = {
    codex: { args: ["login"] },
    "claude-code": { args: ["auth", "login"] },
    cursor: { args: ["login"] },
  };
  for (const providerId of ["codex", "claude-code", "cursor"] as DesktopAgentProviderId[]) {
    const signIn = resolveProviderSignInPlan(providerId, { base });
    const preflight = providerCli(providerId, null, base);
    assert.equal(signIn.mode, "process");
    assert.equal(signIn.command, preflight.command, `${providerId} runs the preflight's program`);
    assert.deepEqual(signIn.args, expected[providerId]!.args);
    if (providerId === "cursor") {
      assert.equal(signIn.env.HOME, "/cursor/source-home", "Cursor signs in to the home its managed profiles copy");
      assert.equal(signIn.env.CURSOR_API_KEY, undefined);
      assert.equal(signIn.env.PATH, base.PATH);
    } else {
      assert.deepEqual(signIn.env, preflight.env, `${providerId} keeps the preflight's (Preview) homes`);
      assert.equal(signIn.env.CLAUDE_CONFIG_DIR, "/preview/home/.claude");
      assert.equal(signIn.env.CODEX_HOME, "/preview/home/.codex");
    }
  }
  assert.equal(providerCli("codex", null, base).command, "/fake/bin/codex");
  assert.equal(providerCli("claude-code", null, base).command, "/fake/bin/claude");
  assert.equal(providerCli("cursor", null, base).command, "/fake/bin/cursor-agent");

  const antigravity = resolveProviderSignInPlan("antigravity", { base, platform: "darwin" });
  assert.equal(antigravity.mode, "terminal");
  assert.equal(antigravity.command, "/fake/bin/agy");
  assert.deepEqual(antigravity.env, antigravityChildEnvironment(base));
  assert.throws(() => resolveProviderSignInPlan("antigravity", { base, platform: "linux" }), /Run `agy` in a terminal/);
  assert.throws(() => resolveProviderSignInPlan("open-model", { base }), /no sign-in that LetAgents can run/);
});

test("every provider preflight resolves its program through the shared provider command line", () => {
  const providers = readFileSync(fileURLToPath(new URL("../main/agents/providers.ts", import.meta.url)), "utf8");
  const cursor = readFileSync(fileURLToPath(new URL("../main/agents/cursor-provider-preflight.ts", import.meta.url)), "utf8");
  assert.equal(providers.match(/= providerCli\(provider\.id, provider\.runtimeCommand\);/g)?.length, 3, "Codex, Claude Code and Antigravity");
  assert.match(cursor, /providerCli\(provider\.id, provider\.runtimeCommand, runtimeEnv\)/);
  assert.doesNotMatch(providers, /resolveCodexExecutable|resolveClaudeCodeExecutable|resolveAntigravityExecutable/);
});
