import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { AntigravityChild } from "#provider-runtime/agents/antigravity/child-process.js";
import type { ProviderProcessExit } from "#provider-runtime/agents/provider-evidence.js";
import {
  AntigravityModelsSignInError,
  antigravitySessionModelRows,
  readAntigravityModelsOverAcp,
  type AntigravityModelListDependencies,
} from "../main/agents/antigravity-model-list.js";

type Message = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> };

/** The two entries per model that agy 1.5.16 sent in `session/new` on 2026-11-26 (27 in all). */
const AVAILABLE_MODELS = [
  { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
  { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
  { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
];

/** An in-process stand-in for `agy acp` that answers the way agy 1.5.16 did. */
class FakeAgy implements AntigravityChild {
  pid: number | null = 4343;
  exited: Promise<ProviderProcessExit>;
  received: Message[] = [];
  terminated = 0;
  sessionNew: "models" | "empty" | "sign-in" | "silent" = "models";
  signInLine = false;
  exitAfterSignInLine = false;
  private finish!: (exit: ProviderProcessExit) => void;
  private readonly lineListeners = new Set<(line: string) => void>();

  constructor() {
    this.exited = new Promise((resolve) => { this.finish = resolve; });
  }

  onLine(listener: (line: string) => void) { this.lineListeners.add(listener); return () => this.lineListeners.delete(listener); }
  onDisconnect() { return () => {}; }
  stderrTail() { return ""; }
  markIntentionalClose() {}
  async terminate() { this.terminated += 1; this.finish({ type: "exit", code: 0, signal: null }); return true; }

  methods(): string[] {
    return this.received.map((message) => message.method!).filter(Boolean);
  }

  writeLine(json: string): void {
    const message = JSON.parse(json) as Message;
    this.received.push(message);
    queueMicrotask(() => this.handle(message));
  }

  private send(message: unknown) {
    for (const listener of this.lineListeners) listener(typeof message === "string" ? message : JSON.stringify(message));
  }

  private handle(message: Message) {
    if (message.method === "initialize") {
      if (this.signInLine) this.send("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?x=1");
      if (this.exitAfterSignInLine) { this.finish({ type: "exit", code: 1, signal: null }); return; }
      this.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });
    } else if (message.method === "session/new") {
      if (this.sessionNew === "silent") return;
      if (this.sessionNew === "sign-in") {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      this.send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "6f1c2d3e-0000-4000-8000-0000000000aa",
        models: { currentModelId: "gemini-4-neon-high", availableModels: this.sessionNew === "models" ? AVAILABLE_MODELS : [] },
        configOptions: [],
      } });
    } else if (message.method === "session/close") {
      this.send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } });
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(agy = new FakeAgy(), over: Partial<AntigravityModelListDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agy-model-list-"));
  roots.push(root);
  const folder = join(root, "model-list");
  const launches: Array<{ agyBin: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
  const shared: string[] = [];
  const deps: AntigravityModelListDependencies = {
    launchChild: (input) => { launches.push(input); return agy; },
    shareSignIn: (dir) => { shared.push(dir); },
    workspaceRefusal: () => null,
    folder,
    timeoutMs: 5_000,
    ...over,
  };
  return { agy, deps, folder, launches, shared };
}

test("the model list comes from session/new over ACP, and nothing else is asked of agy", async () => {
  const { agy, deps, folder, launches, shared } = harness();
  // What an earlier read left behind, which this read clears.
  for (const name of ["conversations", "brain", "implicit", "log"]) {
    mkdirSync(join(folder, "antigravity-cli", name), { recursive: true });
    writeFileSync(join(folder, "antigravity-cli", name, "old"), "x");
  }
  writeFileSync(join(folder, "antigravity-cli", "installation_id"), "kept");

  const rows = await readAntigravityModelsOverAcp("/bin/agy", deps);

  assert.deepEqual(rows, [
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  ]);
  assert.deepEqual(launches, [{ agyBin: "/bin/agy", args: ["acp", "--gemini-dir", folder], cwd: folder, env: {} }]);
  assert.deepEqual(shared, [folder]);
  assert.deepEqual(agy.methods(), ["initialize", "session/new", "session/close"]);
  const init = agy.received[0]!.params!;
  assert.deepEqual(init.clientInfo, { name: "letagents", title: "LetAgents", version: "1" });
  assert.deepEqual(agy.received[1]!.params, { cwd: folder, mcpServers: [] });
  assert.deepEqual(agy.received[2]!.params, { sessionId: "6f1c2d3e-0000-4000-8000-0000000000aa" });
  assert.equal(agy.terminated, 1);
  for (const name of ["conversations", "brain", "implicit", "log"]) {
    assert.equal(existsSync(join(folder, "antigravity-cli", name)), false, `${name} is cleared`);
  }
  assert.equal(existsSync(join(folder, "antigravity-cli", "installation_id")), true, "agy's own setup stays for the next read");
});

test("no sign-in is a sign-in error, from the ACP error or from agy's sign-in line", async () => {
  const errorCase = harness();
  errorCase.agy.sessionNew = "sign-in";
  await assert.rejects(readAntigravityModelsOverAcp("/bin/agy", errorCase.deps), AntigravityModelsSignInError);
  assert.equal(errorCase.agy.terminated, 1);

  const lineCase = harness();
  lineCase.agy.signInLine = true;
  lineCase.agy.exitAfterSignInLine = true;
  await assert.rejects(readAntigravityModelsOverAcp("/bin/agy", lineCase.deps), AntigravityModelsSignInError);

  // agy prints the link and waits for a browser: the read ends at once, not at its time limit.
  const waiting = harness(new FakeAgy(), { timeoutMs: 60_000 });
  waiting.agy.signInLine = true;
  waiting.agy.sessionNew = "silent";
  const started = Date.now();
  await assert.rejects(readAntigravityModelsOverAcp("/bin/agy", waiting.deps), AntigravityModelsSignInError);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(waiting.agy.terminated, 1);
});

test("a folder with workspace hooks is refused before agy starts", async () => {
  const { deps, launches } = harness(new FakeAgy(), { workspaceRefusal: () => "This workspace has Antigravity hooks" });
  await assert.rejects(readAntigravityModelsOverAcp("/bin/agy", deps), /Antigravity hooks/);
  assert.equal(launches.length, 0);
});

test("an empty list and a silent agy are errors, and agy is still stopped", async () => {
  const empty = harness();
  empty.agy.sessionNew = "empty";
  await assert.rejects(readAntigravityModelsOverAcp("/bin/agy", empty.deps), /did not return any models/);
  assert.deepEqual(empty.agy.methods(), ["initialize", "session/new", "session/close"]);
  assert.equal(empty.agy.terminated, 1);

  const silent = harness(new FakeAgy(), { timeoutMs: 50 });
  silent.agy.sessionNew = "silent";
  await assert.rejects(readAntigravityModelsOverAcp("/bin/agy", silent.deps), /did not list its models within/);
  assert.equal(silent.agy.methods().includes("session/close"), false, "there is no session to close");
  assert.equal(silent.agy.terminated, 1);
});

test("session rows skip entries without an id and repeats", () => {
  assert.deepEqual(antigravitySessionModelRows({ models: { availableModels: [
    { modelId: "a-high", name: "A (High)" }, { name: "no id" }, { modelId: "a-high", name: "again" }, { modelId: "b" },
  ] } }), [{ id: "a-high", label: "A (High)" }, { id: "b", label: "b" }]);
  assert.deepEqual(antigravitySessionModelRows(null), []);
});
