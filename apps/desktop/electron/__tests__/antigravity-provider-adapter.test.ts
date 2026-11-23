import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { NO_REPLY_FAILURE } from "../../../../shared/room-turn-no-reply.mjs";
import { AntigravityProviderAdapter, type AntigravityChild, type AntigravityProviderAdapterDependencies } from "../main/agents/antigravity-provider-adapter.js";
import { classifyAntigravityTurn } from "../main/agents/antigravity/turn-results.js";
import { antigravityToolDisplay } from "../main/agents/antigravity/tool-display.js";
import { prepareAntigravityOwnerSetup } from "../main/agents/antigravity/owner-setup.js";
import { antigravityPermissionTool } from "../main/agents/antigravity/permissions.js";
import { antigravityWorkspaceCommandCustomizations, antigravityWorkspaceRefusal } from "../main/agents/antigravity/workspace-customizations.js";
import { antigravityAuthorityFromPolicy, antigravityAuthorityForProfile, antigravityVersionAtLeast, isRoomServerToolCall, parseAntigravityVersion } from "../main/agents/antigravity/launch.js";
import { parseAntigravityModelsOutput } from "../main/agents/managed-agent-models.js";
import { PROCESS_ENDED_DURING_TURN, ProviderContinuationMissingError, type ProviderRoomTurnResult, type ProviderSpawnRequest, type ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import type { ProviderProcessExit } from "../main/agents/provider-evidence.js";
import type { ClaudeNativePermissionRequest } from "../../shared/provider-permissions.js";

const BIRTH = "Mon Nov 23 17:00:00 2026";
type FailedResult = ProviderRoomTurnResult & { refusal?: true; error?: string };
type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** An in-process stand-in for `agy acp`: it answers ACP requests the way agy 1.5.15 did in the probe runs. */
class FakeAgy implements AntigravityChild {
  pid: number | null = 4242;
  exited: Promise<ProviderProcessExit>;
  received: Message[] = [];
  /** The client's answers to this agent's own requests, by request id. */
  answers = new Map<string | number, unknown>();
  modes = ["default", "accept-edits", "auto", "plan"];
  resumeError: { code: number; message: string } | null = null;
  printSignInLine = false;
  onPrompt: (agy: FakeAgy, message: Message) => void = (agy, message) => {
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "room." } });
    agy.reply(message, { stopReason: "end_turn", usage: { totalTokens: 10 } });
  };
  sessionId = "6f1c2d3e-0000-4000-8000-000000000001";
  /** Thinking levels per model family, as agy reports them in its `thought_level` option. */
  levels: Record<string, string[]> = { "gemini-4-neon": ["low", "medium", "high", "xhigh"], "gemini-3.8-flash": ["low", "medium", "high"] };
  currentModel = "gemini-4-neon";
  currentLevel = "high";
  configOptions(): unknown[] {
    return [
      { id: "model", category: "model", type: "select", currentValue: this.currentModel,
        options: Object.keys(this.levels).map((value) => ({ value, name: value })) },
      { id: "thought_level", category: "thought_level", type: "select", currentValue: this.currentLevel,
        options: (this.levels[this.currentModel] ?? []).map((value) => ({ value, name: value })) },
      { id: "mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
    ];
  }
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private finish!: (exit: ProviderProcessExit) => void;
  private nextRequestId = 1;
  private readonly waiters = new Map<string | number, (value: unknown) => void>();

  constructor() {
    this.exited = new Promise((resolve) => { this.finish = resolve; });
  }

  onLine(listener: (line: string) => void) { this.lineListeners.add(listener); return () => this.lineListeners.delete(listener); }
  onDisconnect(listener: () => void) { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  stderrTail() { return ""; }
  markIntentionalClose() {}

  writeLine(json: string): void {
    const message = JSON.parse(json) as Message;
    this.received.push(message);
    queueMicrotask(() => this.handle(message));
  }

  send(message: unknown): void {
    for (const listener of this.lineListeners) listener(JSON.stringify(message));
  }

  reply(request: Message, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  update(update: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
  }

  /** Ask the client for permission and resolve with its answer. */
  requestPermission(toolCall: Record<string, unknown>, options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ]): Promise<unknown> {
    const id = String(this.nextRequestId++);
    const answered = new Promise<unknown>((resolve) => this.waiters.set(id, resolve));
    this.send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: this.sessionId, toolCall, options } });
    return answered;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.finish({ type: "exit", code, signal });
  }

  methods(): string[] {
    return this.received.filter((message) => message.method).map((message) => message.method!);
  }

  private handle(message: Message): void {
    if (!message.method && message.id !== undefined) {
      this.answers.set(message.id, message.result ?? message.error);
      this.waiters.get(message.id)?.(message.result ?? message.error);
      return;
    }
    switch (message.method) {
      case "initialize":
        if (this.printSignInLine) for (const listener of this.lineListeners) listener("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?x=1");
        this.reply(message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} } },
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        });
        return;
      case "session/new":
        if (this.printSignInLine) {
          this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
          return;
        }
        this.reply(message, {
          sessionId: this.sessionId,
          modes: { currentModeId: "default", availableModes: this.modes.map((id) => ({ id, name: id })) },
          configOptions: this.configOptions(),
        });
        return;
      case "session/resume":
        if (this.resumeError) {
          this.send({ jsonrpc: "2.0", id: message.id, error: this.resumeError });
          return;
        }
        this.sessionId = String(message.params?.sessionId);
        this.reply(message, { modes: { currentModeId: "default", availableModes: this.modes.map((id) => ({ id, name: id })) }, configOptions: this.configOptions() });
        return;
      case "session/set_config_option": {
        const { configId, value } = message.params as { configId: string; value: string };
        if (configId === "model") {
          if (!this.levels[value]) { this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown model" } }); return; }
          this.currentModel = value;
          if (!this.levels[value]!.includes(this.currentLevel)) this.currentLevel = this.levels[value]!.at(-1)!;
        } else if (configId === "thought_level") this.currentLevel = value;
        this.reply(message, { configOptions: this.configOptions() });
        return;
      }
      case "session/set_mode":
      case "session/set_model":
        this.reply(message, {});
        return;
      case "session/prompt":
        this.onPrompt(this, message);
        return;
      case "session/cancel":
        return;
      default:
        if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } });
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const QUOTA_JSON = JSON.stringify({ status: "SUCCESS", response: "", command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [
    { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.1, reset_time: "2026-11-28T08:48:49Z" },
    { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.93, reset_time: "2026-11-23T20:48:49Z" },
  ] },
  { name: "Claude and GPT models", buckets: [
    { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-30T17:21:25Z" },
    { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-23T22:21:25Z" },
  ] },
] } } });

function harness(over: { version?: string; agy?: FakeAgy; quota?: string; lastStepError?: string | null; backgroundQuietMs?: number; workspaceRefusal?: (cwd: string) => string | null } = {}) {
  const agy = over.agy ?? new FakeAgy();
  const launches: Array<{ agyBin: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
  const signals: Array<[number, NodeJS.Signals]> = [];
  let alive = true;
  const dataRoot = mkdtempSync(join(tmpdir(), "letagents-agy-test-"));
  roots.push(dataRoot);
  // The owner's own Antigravity home, with a LetAgents server that must never reach the agent.
  const ownerDir = join(dataRoot, "owner-gemini");
  mkdirSync(join(ownerDir, "config", "plugins", "notes"), { recursive: true });
  writeFileSync(join(ownerDir, "GEMINI.md"), "Owner rules.");
  writeFileSync(join(ownerDir, "config", "mcp_config.json"), JSON.stringify({ mcpServers: {
    "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    letagents: { command: "npx", args: ["-y", "letagents"], env: { LETAGENTS_TOKEN: "owner-token" } },
    "room-tools": { command: "node", args: ["/home/me/letagents/dist/mcp/server.js"] },
  } }));
  const dependencies: AntigravityProviderAdapterDependencies = {
    readVersion: async () => over.version ?? "1.5.15",
    readQuota: async () => over.quota ?? QUOTA_JSON,
    readLastStepError: async () => over.lastStepError ?? null,
    prepareOwnerSetup: (agentDir, enabled) => prepareAntigravityOwnerSetup(agentDir, enabled, ownerDir),
    workspaceRefusal: (cwd) => over.workspaceRefusal?.(cwd) ?? null,
    launchChild: (input) => { launches.push(input); return agy; },
    roomServer: (_req, env) => ({ name: "letagents", command: "/electron", args: ["/mcp/server.js"], env: Object.entries(env).map(([name, value]) => ({ name, value })) }),
    resolveCommitEnvironment: async () => ({ GIT_AUTHOR_NAME: "Agent" }),
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
      agy.exit(null, signal);
    },
    getProcessIdentity: () => (alive ? BIRTH : null),
    observeProcessExit: async () => ({ type: "exit", code: 0, signal: null }),
    now: () => new Date().toISOString(),
  };
  const adapter = new AntigravityProviderAdapter({ agyBin: "/bin/agy", dependencies, dataRoot, stopGraceMs: 20, turnControlTimeoutMs: 200, initTimeoutMs: 2_000,
    backgroundQuietMs: over.backgroundQuietMs ?? 30, backgroundReplyWaitMs: 500, backgroundCommandWaitLimitMs: 2_000 });
  return { adapter, agy, launches, signals, dataRoot, ownerDir };
}

function spawnRequest(profile: "read_only" | "auto_review" | "full_access" = "read_only", over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-agy-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "GlacierFinch",
    cwd: "/tmp/wa-agy-1",
    deliveryMode: "daemon_inbox",
    lifecycleAuthorityMode: "typed",
    permissionProfileId: profile,
    launchPolicy: { ...antigravityAuthorityForProfile(profile) },
    configurationRevision: 1,
    supervisorEntryId: "supervised_agy_1",
    supervisorSocketPath: "/tmp/fake-daemon.sock",
    supervisorExecutionGenerationId: "generation-1",
    supervisorWorkerSession: { agentSessionId: "agent_session_7", roomCursor: null, apiUrl: "https://letagents.chat" },
    ...over,
  };
}

const turnRequest = {
  roomId: "github.com/example/repo",
  inboxItemId: "inbox-1",
  actionId: "action-1",
  sourceMessage: { id: "msg_1", room_id: "github.com/example/repo", sender: "emmy", text: "Say hello" },
  activation: { kind: "mention" },
};

test("spawn starts agy acp in the agent's own data folder with the room's MCP server", async () => {
  const { adapter, agy, launches, dataRoot } = harness();
  const handle = await adapter.spawn(spawnRequest("read_only", { model: "gemini-3.8-flash-low" }));
  assert.equal(agy.currentModel, "gemini-3.8-flash", "a per-level id is split into its family");
  assert.equal(agy.currentLevel, "low", "and its thinking level");
  assert.equal(handle.providerContinuationId, agy.sessionId);
  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(handle.providerConnection, { kind: "antigravity_acp", pid: 4242, processIdentity: BIRTH });
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.args[0], "acp");
  assert.equal(launches[0]!.args[1], "--gemini-dir");
  assert.ok(launches[0]!.args[2]!.startsWith(dataRoot), "the data folder sits under the adapter's root");
  assert.ok(!launches[0]!.args.includes("--dangerously-skip-permissions"));
  assert.equal(launches[0]!.env.LETAGENTS_SUPERVISOR_PROVIDER, undefined, "agy's own environment carries no room authority");
  assert.equal(launches[0]!.env.GIT_AUTHOR_NAME, "Agent");
  assert.deepEqual(agy.methods(), ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/set_config_option"]);
  const sessionNew = agy.received.find((message) => message.method === "session/new")!;
  const servers = sessionNew.params!.mcpServers as Array<{ name: string; env: Array<{ name: string; value: string }> }>;
  assert.equal(servers.length, 1);
  assert.equal(servers[0]!.name, "letagents");
  assert.ok(servers[0]!.env.some((pair) => pair.name === "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID" && pair.value === "agent_session_7"));
  assert.ok(servers[0]!.env.some((pair) => pair.name === "LETAGENTS_SUPERVISOR_PROVIDER" && pair.value === "antigravity"), "the room's server alone gets it");
  assert.equal(agy.received.find((message) => message.method === "session/set_mode")!.params!.modeId, "default");
});

test("full access starts agy with every permission skipped; Auto asks for agy's own auto mode", async () => {
  const full = harness();
  await full.adapter.spawn(spawnRequest("full_access"));
  assert.ok(full.launches[0]!.args.includes("--dangerously-skip-permissions"));
  const auto = harness();
  await auto.adapter.spawn(spawnRequest("auto_review"));
  assert.ok(!auto.launches[0]!.args.includes("--dangerously-skip-permissions"));
  assert.equal(auto.agy.received.find((message) => message.method === "session/set_mode")!.params!.modeId, "auto");
});

test("Auto refuses to start when the account offers no auto mode", async () => {
  const agy = new FakeAgy();
  agy.modes = ["default", "plan"];
  const { adapter, signals } = harness({ agy });
  await assert.rejects(adapter.spawn(spawnRequest("auto_review")), /did not offer its Auto mode/);
  assert.equal(signals.length, 1, "the fresh process is stopped before the error is reported");
});

test("a launch refuses an old agy, a mixed policy and an owner-setup request", async () => {
  await assert.rejects(harness({ version: "1.4.9" }).adapter.spawn(spawnRequest()), /too old/);
  await assert.rejects(
    harness().adapter.spawn(spawnRequest("read_only", { launchPolicy: { ...antigravityAuthorityForProfile("read_only"), extra: true } })),
    /unsupported native option 'extra'/,
  );
  await assert.rejects(
    harness().adapter.spawn(spawnRequest("read_only", { launchPolicy: { ...antigravityAuthorityForProfile("full_access") } })),
    /permission-profile authority/,
  );

  for (const profile of ["read_only", "full_access"] as const) {
    await assert.rejects(harness().adapter.spawn(spawnRequest(profile, { supervisorEntryId: "supervised_rental_1" })), /does not run for a guest/);
  }
});

test("a missing sign-in fails the launch with the sign-in step", async () => {
  const agy = new FakeAgy();
  agy.printSignInLine = true;
  const { adapter } = harness({ agy });
  await assert.rejects(adapter.spawn(spawnRequest()), /not signed in/);
});

test("a room turn is one ACP prompt: the streamed text is the reply, with turn facts around it", async () => {
  const { adapter, agy } = harness();
  const handle = await adapter.spawn(spawnRequest());
  const events: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => events.push(event));
  const calls: string[] = [];
  const result = await adapter.runRoomTurn(handle, turnRequest, {
    beforeNativeDispatch: async () => { calls.push("dispatch"); },
    checkpointTurnStarted: async (turnId) => { calls.push(`started:${turnId.length}`); },
    checkpointTerminalResult: async (terminal) => { calls.push(`terminal:${terminal.outcome}`); },
  });
  assert.equal(result.outcome, "reply");
  assert.equal(result.text, "Hello room.");
  assert.deepEqual(calls, ["dispatch", "started:36", "terminal:reply"]);
  const prompt = agy.received.find((message) => message.method === "session/prompt")!;
  const blocks = prompt.params!.prompt as Array<{ type: string; text: string }>;
  assert.match(blocks[0]!.text, /Inbox item: inbox-1/);
  assert.match(blocks[0]!.text, /LETAGENTS_NO_ROOM_REPLY/);
  assert.match(blocks[0]!.text, /Your access level for this turn is Read-only/, "a Read-only agent is told that edits and commands are refused");
  assert.deepEqual(events.filter((event) => event.kind === "turn_lifecycle").map((event) => event.method), ["turn/started", "turn/completed"]);
  assert.equal(events.filter((event) => event.kind === "text_delta").length, 2);
  assert.equal(handle.observedState(), "idle");
});

test("the no-reply sentinel publishes nothing", async () => {
  const { adapter, agy } = harness();
  agy.onPrompt = (fake, message) => {
    fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LETAGENTS_NO_ROOM_REPLY" } });
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest());
  assert.equal((await adapter.runRoomTurn(handle, turnRequest)).outcome, "no_reply");
});

test("Read-only refuses commands and edits but always allows the room's own tools", async () => {
  const { adapter, agy } = harness();
  const answers: unknown[] = [];
  agy.onPrompt = async (fake, message) => {
    answers.push(await fake.requestPermission({ toolCallId: "call_1", name: "mcp_letagents_send_message", title: "Run mcp_letagents_send_message", kind: "other" }));
    answers.push(await fake.requestPermission({ toolCallId: "call_2", name: "run_command", title: "ls -la", kind: "execute" }));
    // agy ends a turn with no text right after a refused tool call.
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("read_only"));
  const result = await adapter.runRoomTurn(handle, turnRequest);
  assert.deepEqual(answers, [
    { outcome: { outcome: "selected", optionId: "allow" } },
    { outcome: { outcome: "selected", optionId: "deny" } },
  ]);
  assert.equal(result.outcome, "failed");
  assert.equal((result as { error?: string }).error, NO_REPLY_FAILURE.deniedTool);
});

test("Full access allows other tools; a fixed-choice question is never answered for a person", async () => {
  const { adapter, agy } = harness();
  const answers: unknown[] = [];
  agy.onPrompt = async (fake, message) => {
    answers.push(await fake.requestPermission({ toolCallId: "call_3", name: "write_file", title: "File out.txt", kind: "edit" }));
    answers.push(await fake.requestPermission({ toolCallId: "interaction_ab12", title: "Which plan?", kind: "other" },
      [{ optionId: "1", name: "A", kind: "allow_once" }, { optionId: "2", name: "B", kind: "allow_once" }]));
    fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("full_access"));
  const result = await adapter.runRoomTurn(handle, turnRequest);
  const promptText = (agy.received.find((message) => message.method === "session/prompt")!.params!.prompt as Array<{ text: string }>)[0]!.text;
  assert.match(promptText, /Your access level for this turn is Full access/, "each turn names its level, so an earlier Read-only turn in the history does not hold the agent back");
  assert.deepEqual(answers, [
    { outcome: { outcome: "selected", optionId: "allow" } },
    { outcome: { outcome: "cancelled" } },
  ]);
  assert.equal(result.outcome, "reply");
});

test("stopping a turn sends session/cancel and waits for agy's cancelled result", async () => {
  const { adapter, agy } = harness();
  let promptMessage: Message | null = null;
  agy.onPrompt = (_fake, message) => { promptMessage = message; };
  const handle = await adapter.spawn(spawnRequest());
  const running = adapter.runRoomTurn(handle, turnRequest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handle.observedState(), "working");
  const originalWrite = agy.writeLine.bind(agy);
  agy.writeLine = (json: string) => {
    originalWrite(json);
    if (JSON.parse(json).method === "session/cancel") queueMicrotask(() => agy.reply(promptMessage!, { stopReason: "cancelled" }));
  };
  const control = await adapter.controlTurn!(handle, null);
  assert.deepEqual(control, { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" });
  const result = await running;
  assert.equal(result.outcome, "interrupted");
  assert.ok(agy.methods().includes("session/cancel"));
});

test("the live feed names agy's tools the way it names every provider's", () => {
  assert.deepEqual(antigravityToolDisplay({ name: "run_command", kind: "execute", rawInput: { CommandLine: "ls -la", WaitMsBeforeAsync: 5000 } }),
    { tool: "bash", input: { command: "ls -la" } });
  assert.deepEqual(antigravityToolDisplay({ name: "write_file", kind: "edit", rawInput: { Path: "/w/out.txt", Content: "x" } }),
    { tool: "writeToolCall", input: { path: "/w/out.txt", changes: [{ path: "/w/out.txt" }] } });
  assert.deepEqual(antigravityToolDisplay({ name: "read_file", kind: "read", rawInput: { Path: "/w/notes.txt" } }),
    { tool: "readToolCall", input: { path: "/w/notes.txt" } });
  assert.deepEqual(antigravityToolDisplay({ name: "mcp_letagents_get_board", kind: "other", rawInput: { status: "open", toolSummary: "Board" } }),
    { tool: "get_board", input: { status: "open" } });
});

test("a command stopped with its turn reads as interrupted, not failed", async () => {
  const { adapter, agy } = harness();
  let promptMessage: Message | null = null;
  agy.onPrompt = (fake, message) => {
    promptMessage = message;
    fake.update({ sessionUpdate: "tool_call", toolCallId: "call_sleep", name: "run_command", kind: "execute", status: "in_progress", title: "sleep 90", rawInput: { CommandLine: "sleep 90" } });
  };
  const handle = await adapter.spawn(spawnRequest("full_access"));
  const events: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => events.push(event));
  const running = adapter.runRoomTurn(handle, turnRequest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const originalWrite = agy.writeLine.bind(agy);
  agy.writeLine = (json: string) => {
    originalWrite(json);
    if (JSON.parse(json).method !== "session/cancel") return;
    queueMicrotask(() => {
      agy.update({ sessionUpdate: "tool_call_update", toolCallId: "call_sleep", name: "run_command", kind: "execute", status: "failed", title: "sleep 90" });
      agy.reply(promptMessage!, { stopReason: "cancelled" });
    });
  };
  await adapter.controlTurn!(handle, null);
  assert.equal((await running).outcome, "interrupted");
  const statuses = events.filter((event) => event.kind === "tool_lifecycle").map((event) => (event.payload as { status: string; tool: string }));
  assert.deepEqual(statuses.map((payload) => payload.status), ["running", "interrupted"]);
  assert.equal(statuses[0]!.tool, "bash");
});

test("a refusal stop reason and a failed prompt are settled failures", async () => {
  const refusal = classifyAntigravityTurn("t1", "s1", { stopReason: "refusal", text: "", refusedTool: false, error: null }) as FailedResult;
  assert.equal(refusal.outcome, "failed");
  assert.equal(refusal.refusal, true);
  const { adapter, agy } = harness();
  agy.onPrompt = (fake, message) => fake.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Error 429, Status: RESOURCE_EXHAUSTED" } });
  const handle = await adapter.spawn(spawnRequest());
  const result = await adapter.runRoomTurn(handle, turnRequest) as FailedResult;
  assert.equal(result.outcome, "failed");
  assert.match(result.error!, /RESOURCE_EXHAUSTED/);
});

test("a process that ends during a turn: the turn reads back as interrupted, and the exit is a crash", async () => {
  const { adapter, agy } = harness();
  agy.onPrompt = (fake) => { setTimeout(() => fake.exit(1), 5); };
  const handle = await adapter.spawn(spawnRequest());
  const exits: string[] = [];
  adapter.onExit(handle, (terminal) => exits.push(terminal.terminalCause));
  let turnId = "";
  await assert.rejects(adapter.runRoomTurn(handle, turnRequest, { checkpointTurnStarted: async (id) => { turnId = id; } }));
  assert.deepEqual(exits, ["crashed"]);
  const recovered = await adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-1", providerTurnId: turnId, originProcessEnded: true });
  assert.equal(recovered.outcome, "interrupted");
  assert.equal((recovered as { error?: string }).error, PROCESS_ENDED_DURING_TURN);
});

test("resume continues the saved session with session/resume; an unknown session is a missing continuation", async () => {
  const { adapter, agy } = harness();
  const ref = { workAttemptId: "wa-agy-1", providerContinuationId: "11111111-2222-4333-8444-555555555555" };
  const handle = await adapter.resume(ref, spawnRequest());
  assert.equal(handle.providerContinuationId, ref.providerContinuationId);
  assert.ok(agy.methods().includes("session/resume"));
  assert.ok(!agy.methods().includes("session/new"));
  const missing = new FakeAgy();
  missing.resumeError = { code: -32603, message: "conversation not found" };
  await assert.rejects(harness({ agy: missing }).adapter.resume(ref, spawnRequest()), (error) => error instanceof ProviderContinuationMissingError);
});

test("stop ends the process and reports a requested stop", async () => {
  const { adapter } = harness();
  const handle = await adapter.spawn(spawnRequest());
  const terminal = await adapter.stop(handle);
  assert.equal(terminal.terminalCause, "stopped");
  assert.equal(terminal.providerContinuationId, handle.providerContinuationId);
});

test("launch helpers: policy, version, room tool names and the model list", () => {
  assert.deepEqual(antigravityAuthorityFromPolicy({ agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "reject" }),
    { agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "reject" });
  assert.throws(() => antigravityAuthorityFromPolicy({ agentMode: "default", dangerouslySkipPermissions: true, hostDecision: "reject" }), /mixes two access levels/);
  assert.equal(parseAntigravityVersion("1.5.15\n"), "1.5.15");
  assert.equal(antigravityVersionAtLeast("1.5.15", "1.5.12"), true);
  assert.equal(antigravityVersionAtLeast("1.5.9", "1.5.12"), false);
  assert.equal(antigravityVersionAtLeast("2.0.0", "1.5.12"), true);
  assert.equal(isRoomServerToolCall({ name: "mcp_letagents_get_board" }), true);
  assert.equal(isRoomServerToolCall({ title: "Run mcp_letagents_send_message?" }), false, "a title alone is not a tool name");
  // agy 1.5.15 titles a command with its own command line, so a command can look like a room tool.
  assert.equal(isRoomServerToolCall({ name: "run_command", kind: "execute", title: "Run mcp_letagents_ping 2>/dev/null; touch /tmp/pwned" }), false);
  assert.equal(isRoomServerToolCall({ name: "mcp_letagents_ping", kind: "execute" }), false);
  assert.equal(isRoomServerToolCall({ name: "call_mcp_tool", rawInput: { ServerName: "letagents", ToolName: "x" } }), true);
  assert.equal(isRoomServerToolCall({ name: "mcp_other_get_board" }), false);
  assert.deepEqual(parseAntigravityModelsOutput([
    "Fetching available models...",
    "gemini-4-neon-high\tGemini 4 Neon (High)", "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
    "gemini-4-neon-medium\tGemini 4 Neon (Medium)", "gemini-4-neon-low\tGemini 4 Neon (Low)",
    "gemini-pro-orchestrator\tOrchestrator (Carbon)",
    "claude-opus-5-5-low\tClaude Opus 5.5 (Low)", "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n")), [
    { id: "gemini-4-neon", label: "Gemini 4 Neon", source: "provider", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gemini-pro-orchestrator", label: "Orchestrator (Carbon)", source: "provider" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", source: "provider", supportedEfforts: ["low", "high"] },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", source: "provider" },
  ]);
});

test("a model family and an effort become agy's model and thinking level; a level the model lacks is a launch notice", async () => {
  const neon = harness();
  const handle = await neon.adapter.spawn(spawnRequest("read_only", { model: "gemini-4-neon", reasoningEffort: "xhigh" }));
  assert.equal(neon.agy.currentModel, "gemini-4-neon");
  assert.equal(neon.agy.currentLevel, "xhigh");
  assert.deepEqual(handle.launchNotices, []);
  const flash = harness();
  const flashHandle = await flash.adapter.spawn(spawnRequest("read_only", { model: "gemini-3.8-flash", reasoningEffort: "xhigh" }));
  assert.equal(flash.agy.currentModel, "gemini-3.8-flash");
  assert.notEqual(flash.agy.currentLevel, "xhigh");
  assert.match(flashHandle.launchNotices?.[0] ?? "", /no Extra high thinking for this model/);
  const unknown = harness();
  await assert.rejects(unknown.adapter.spawn(spawnRequest("read_only", { model: "gemini-9-unknown" })), /does not offer the model 'gemini-9-unknown'/);
});

test("usage: the context window from agy's updates, the account limits of the agent's own model group", async () => {
  const { adapter, agy } = harness();
  agy.onPrompt = (fake, message) => {
    fake.update({ sessionUpdate: "usage_update", used: 52_000, size: 1_048_576 });
    fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("read_only", { model: "gemini-4-neon", reasoningEffort: "high" }));
  await adapter.runRoomTurn(handle, turnRequest);
  const usage = await adapter.readUsage(handle);
  assert.equal(usage?.context?.usedTokens, 52_000);
  assert.equal(usage?.context?.capacityTokens, 1_048_576);
  assert.equal(usage?.account.state, "available");
  assert.deepEqual(usage?.account.windows.map((window) => [window.label, window.usedPercent]), [["5 hours", 7], ["Weekly", 90]]);
});

test("Ask before writes: an edit waits for the owner's answer, as a Claude-shaped request the approval path serves", async () => {
  const { adapter, agy } = harness();
  const answers: unknown[] = [];
  let release!: () => void;
  const asked = new Promise<void>((resolve) => { release = resolve; });
  agy.onPrompt = async (fake, message) => {
    const pending = fake.requestPermission({ toolCallId: "call_ls", name: "run_command", kind: "execute", title: "ls -la", rawInput: { CommandLine: "ls -la", Cwd: "/w" } });
    release();
    answers.push(await pending);
    fake.update({ sessionUpdate: "tool_call_update", toolCallId: "call_ls", name: "run_command", kind: "execute", status: "completed" });
    answers.push(await fake.requestPermission({ toolCallId: "call_rm", name: "run_command", kind: "execute", title: "rm x", rawInput: { CommandLine: "rm x" } }));
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("ask_before_write" as never, { launchPolicy: { agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "ask" } }));
  const snapshots: unknown[] = [];
  const closed: unknown[] = [];
  const abort = new AbortController();
  void adapter.observePermissions(handle, (event) => {
    if (event.type === "snapshot") snapshots.push(event.requests);
    if (event.type === "request_closed") closed.push(event.request.request.tool_use_id);
  }, abort.signal);
  const running = adapter.runRoomTurn(handle, turnRequest);
  await asked;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const first = (snapshots.at(-1) as ClaudeNativePermissionRequest[])[0]!;
  assert.deepEqual(first.request, { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls -la", cwd: "/w" }, tool_use_id: "call_ls" });
  assert.equal((await adapter.correlatePermissionTurn(handle, first)).outcome, "correlated");
  await assert.rejects(adapter.replyPermission(handle, first, "once"), /no longer pending/, "a reply without the daemon's dispatch hook is refused");
  assert.deepEqual(await adapter.replyPermission(handle, first, "once", { beforeNativeDispatch: async () => {} }), { outcome: "sent", scope: "request" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = (snapshots.at(-1) as Array<{ id: string; request: { tool_use_id: string } }>)[0]!;
  assert.equal(second.request.tool_use_id, "call_rm");
  await adapter.replyPermission(handle, second as never, "reject", { beforeNativeDispatch: async () => {} });
  const result = await running;
  abort.abort();
  assert.deepEqual(answers, [
    { outcome: { outcome: "selected", optionId: "allow" } },
    { outcome: { outcome: "selected", optionId: "deny" } },
  ]);
  assert.deepEqual(closed, ["call_ls", "call_rm"], "each answered request closes when its tool ends or its turn ends");
  assert.equal(result.outcome, "failed", "agy ends a turn right after a refusal");
  const promptText = (agy.received.find((message) => message.method === "session/prompt")!.params!.prompt as Array<{ text: string }>)[0]!.text;
  assert.match(promptText, /Your access level for this turn is Ask before writes/);
});

test("stopping a turn answers a request still waiting with cancelled", async () => {
  const { adapter, agy } = harness();
  let answer: unknown = null;
  let promptMessage: Message | null = null;
  agy.onPrompt = async (fake, message) => {
    promptMessage = message;
    answer = await fake.requestPermission({ toolCallId: "call_w", name: "write_file", kind: "edit", title: "File a.txt", rawInput: { Path: "/w/a.txt", Content: "x" } });
    fake.reply(message, { stopReason: "cancelled" });
  };
  const handle = await adapter.spawn(spawnRequest("ask_before_write" as never, { launchPolicy: { agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "ask" } }));
  const running = adapter.runRoomTurn(handle, turnRequest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(promptMessage);
  const control = await adapter.controlTurn!(handle, null);
  assert.equal(control.interrupted, true);
  assert.deepEqual(answer, { outcome: { outcome: "cancelled" } });
  assert.equal((await running).outcome, "interrupted");
});

test("a command left running after end_turn keeps the turn open until agy's own reply to it", async () => {
  const { adapter, agy } = harness();
  agy.onPrompt = (fake, message) => {
    fake.update({ sessionUpdate: "tool_call", toolCallId: "call_build", name: "run_command", kind: "execute", status: "in_progress", title: "npm run build", rawInput: { CommandLine: "npm run build", WaitMsBeforeAsync: 5000 } });
    fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The build is running. " } });
    fake.reply(message, { stopReason: "end_turn" });
    setTimeout(() => {
      fake.update({ sessionUpdate: "tool_call_update", toolCallId: "call_build", name: "run_command", kind: "execute", status: "completed" });
      fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It passed." } });
      fake.update({ sessionUpdate: "usage_update", used: 9000, size: 1_048_576 });
    }, 60);
  };
  const handle = await adapter.spawn(spawnRequest("full_access"));
  const result = await adapter.runRoomTurn(handle, turnRequest);
  assert.equal(result.outcome, "reply");
  assert.equal(result.text, "The build is running. It passed.");
});

test("a turn whose last conversation step is an error ends as that failure, not as an answer", async () => {
  const { adapter, agy } = harness({ lastStepError: "Antigravity's usage limit for this model is reached. The turn ended without a reply." });
  agy.onPrompt = (fake, message) => {
    fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error 429" } });
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest());
  const result = await adapter.runRoomTurn(handle, turnRequest) as FailedResult;
  assert.equal(result.outcome, "failed");
  assert.match(result.error!, /usage limit/);
});

test("agy's error steps read back as the owner's reason, from a copy of the conversation database", async () => {
  const { antigravityStepErrorMessage, readAntigravityLastStepError } = await import("../main/agents/antigravity/turn-errors.js");
  assert.match(antigravityStepErrorMessage("Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED quotaResetTimeStamp\":\"2026-11-24T08:00:00Z"),
    /usage limit for this model is reached; it resets at 2026-11-24T08:00:00.000Z/);
  assert.match(antigravityStepErrorMessage("NOT_FOUND (code 404): model gemini-x is not available"), /request failed \(NOT_FOUND 404\): model gemini-x is not available/);
  const { DatabaseSync } = await import("node:sqlite");
  const folder = mkdtempSync(join(tmpdir(), "letagents-agy-db-"));
  roots.push(folder);
  const path = join(folder, "s.db");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, error_details blob, step_payload blob)");
  database.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(0, 14, null, Buffer.from("hello"));
  database.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(1, 15, null, Buffer.from("answer"));
  assert.equal(await readAntigravityLastStepError(path), null, "a turn that ended on the model's answer has no error");
  database.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(2, 17, Buffer.from("\x08\x02Error 429, Message: quota\x12 Status: RESOURCE_EXHAUSTED"), null);
  database.close();
  assert.match(await readAntigravityLastStepError(path) ?? "", /usage limit/);
  assert.equal(await readAntigravityLastStepError(join(folder, "missing.db")), null);
});

test("agy's quota answer becomes the agent's limit windows", async () => {
  const { parseAntigravityQuota } = await import("../main/agents/antigravity/usage.js");
  const at = "2026-11-23T18:00:00.000Z";
  assert.deepEqual(parseAntigravityQuota(QUOTA_JSON, "claude-opus-5-5", at)?.map((window) => [window.id, window.label, window.usedPercent]),
    [["antigravity:3p-5h", "5 hours", 0], ["antigravity:3p-weekly", "Weekly", 0]]);
  assert.deepEqual(parseAntigravityQuota(QUOTA_JSON, null, at)?.map((window) => window.label),
    ["Gemini · 5 hours", "Gemini · Weekly", "Claude & GPT · 5 hours", "Claude & GPT · Weekly"]);
  assert.equal(parseAntigravityQuota("not json", null, at), null);
});

test("own setup: the owner's rules, servers and plugins are placed in the agent's folder, without any LetAgents server", async () => {
  const { adapter, launches, dataRoot } = harness();
  const handle = await adapter.spawn(spawnRequest("full_access", { homeHarness: true, supervisorEntryId: "supervised_own_setup" }));
  assert.equal(handle.ownerSetup, true);
  const agentDir = launches[0]!.args[2]!;
  assert.ok(lstatSync(join(agentDir, "GEMINI.md")).isSymbolicLink());
  assert.ok(lstatSync(join(agentDir, "config", "plugins", "notes")).isSymbolicLink());
  const servers = Object.keys(JSON.parse(readFileSync(join(agentDir, "config", "mcp_config.json"), "utf8")).mcpServers);
  assert.deepEqual(servers, ["chrome-devtools"], "a LetAgents server by name or by what it runs is left out");
  assert.match(handle.launchNotices?.[0] ?? "", /left out because they run LetAgents or their MCP servers could not be read: letagents, room-tools/);
  await adapter.stop(handle);
  const again = harness();
  const off = await again.adapter.spawn(spawnRequest("full_access", { supervisorEntryId: "supervised_own_setup" }));
  assert.equal(off.ownerSetup, false);
  void dataRoot;
  // The same agent folder with the setup off holds none of it.
  const offDir = again.launches[0]!.args[2]!;
  prepareAntigravityOwnerSetup(agentDir, false);
  assert.equal(existsSync(join(agentDir, "GEMINI.md")), false);
  assert.equal(existsSync(join(agentDir, "config", "plugins")), false);
  assert.equal(existsSync(join(offDir, "GEMINI.md")), false);
  await assert.rejects(harness().adapter.spawn(spawnRequest("read_only", { homeHarness: true, supervisorEntryId: "supervised_rental_1" })), /does not run for a guest/);
});

test("the control probe: any JSON-RPC answer proves agy's loop is alive; a closed pipe is lost", async () => {
  const { adapter, agy } = harness();
  const handle = await adapter.spawn(spawnRequest());
  assert.deepEqual(await adapter.probeControl(handle), { state: "responsive" });
  assert.equal(adapter.capabilities().execution?.controlProbe, "rpc");
  agy.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "process_exit" });
});

test("a tool this host refused is a fact of denial before start, with no side effects", async () => {
  const { adapter, agy } = harness();
  agy.onPrompt = async (fake, message) => {
    await fake.requestPermission({ toolCallId: "call_rm", name: "run_command", kind: "execute", title: "rm -rf build", rawInput: { CommandLine: "rm -rf build" } });
    fake.update({ sessionUpdate: "tool_call_update", toolCallId: "call_rm", name: "run_command", kind: "execute", status: "failed" });
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("read_only"));
  const facts: Array<Record<string, unknown>> = [];
  const subscription = adapter.onExecution(handle, (event) => facts.push(event.fact as Record<string, unknown>));
  await adapter.runRoomTurn(handle, turnRequest);
  subscription.dispose();
  const completed = facts.find((fact) => fact.domain === "execution" && fact.kind === "completed");
  assert.equal(completed?.outcome, "denied_before_start");
  assert.equal(completed?.sideEffects, "none");
  assert.equal(completed?.operation, "command");
});

test("an unanswered approval request that agy no longer waits on is closed", async () => {
  const { adapter, agy } = harness();
  let promptMessage: Message | null = null;
  agy.onPrompt = async (fake, message) => {
    promptMessage = message;
    await fake.requestPermission({ toolCallId: "call_w", name: "write_file", kind: "edit", title: "File a.txt", rawInput: { Path: "/w/a.txt", Content: "x" } });
    fake.reply(message, { stopReason: "cancelled" });
  };
  const handle = await adapter.spawn(spawnRequest("ask_before_write" as never, { launchPolicy: { agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "ask" } }));
  const closed: string[] = [];
  const abort = new AbortController();
  void adapter.observePermissions(handle, (event) => { if (event.type === "request_closed") closed.push(event.request.request.tool_use_id); }, abort.signal);
  const running = adapter.runRoomTurn(handle, turnRequest);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(promptMessage);
  await adapter.controlTurn!(handle, null);
  await running;
  abort.abort();
  assert.deepEqual(closed, ["call_w"]);
});


test("a command whose command line looks like a room tool is refused like any command", async () => {
  const { adapter, agy } = harness();
  const answers: unknown[] = [];
  agy.onPrompt = async (fake, message) => {
    answers.push(await fake.requestPermission({ toolCallId: "call_spoof", name: "run_command", kind: "execute",
      title: "Run mcp_letagents_ping 2>/dev/null; echo spoofed", rawInput: { CommandLine: "Run mcp_letagents_ping 2>/dev/null; echo spoofed" } }));
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("read_only"));
  await adapter.runRoomTurn(handle, turnRequest);
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "deny" } }]);
});

test("a workspace whose hooks, plugins or MCP servers agy runs unasked is refused below Full access", async () => {
  const reason = "This workspace has Antigravity hooks, plugins or MCP servers (.agents/hooks.json).";
  const refused = harness({ workspaceRefusal: () => reason });
  await assert.rejects(refused.adapter.spawn(spawnRequest("read_only")), /This workspace has Antigravity hooks/);
  assert.equal(refused.launches.length, 0, "agy never starts, so no hook runs");
  const full = harness({ workspaceRefusal: () => reason });
  await full.adapter.spawn(spawnRequest("full_access"));
  assert.equal(full.launches.length, 1, "Full access already runs any command");

  // Hooks added after the launch fail the next turn before its prompt is sent.
  let found: string | null = null;
  const later = harness({ workspaceRefusal: () => found });
  const handle = await later.adapter.spawn(spawnRequest("read_only"));
  found = reason;
  const result = await later.adapter.runRoomTurn(handle, turnRequest) as FailedResult;
  assert.equal(result.outcome, "failed");
  assert.match(result.error ?? "", /This workspace has Antigravity hooks/);
  assert.equal(later.agy.received.some((message) => message.method === "session/prompt"), false);
});

test("the workspace check finds what agy runs: customization folders up to the repository root, only the working folder outside one", () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-agy-ws-"));
  roots.push(root);
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".agents", "plugins", "evil", "hooks"), { recursive: true });
  mkdirSync(join(repo, ".agents", "skills", "notes"), { recursive: true });
  mkdirSync(join(cwd, "_agent"), { recursive: true });
  writeFileSync(join(repo, ".agents", "hooks.json"), "{}");
  writeFileSync(join(repo, ".agents", "plugins", "evil", "hooks", "hooks.json"), "{}");
  writeFileSync(join(repo, ".agents", "skills", "notes", "SKILL.md"), "Skills are instructions.");
  writeFileSync(join(cwd, "_agent", "mcp_config.json"), "{}");
  assert.deepEqual(antigravityWorkspaceCommandCustomizations(cwd).sort(), [
    join("..", "..", ".agents", "hooks.json"),
    join("..", "..", ".agents", "plugins", "evil", "hooks", "hooks.json"),
    join("_agent", "mcp_config.json"),
  ].sort());
  assert.match(antigravityWorkspaceRefusal(cwd) ?? "", /give the agent Full access/);

  // Outside a repository, agy loads the working folder's own customizations and no parent's.
  const loose = join(root, "loose");
  mkdirSync(join(loose, ".agents"), { recursive: true });
  mkdirSync(join(loose, "ws", ".agents", "rules"), { recursive: true });
  writeFileSync(join(loose, ".agents", "hooks.json"), "{}");
  writeFileSync(join(loose, "ws", ".agents", "rules", "style.md"), "Rules are instructions.");
  assert.deepEqual(antigravityWorkspaceCommandCustomizations(join(loose, "ws")), []);
  assert.equal(antigravityWorkspaceRefusal(join(loose, "ws")), null);
});

test("Read-only lets agy read the files the room message carried, and nothing else outside the workspace", async () => {
  const { adapter, agy } = harness();
  const answers: unknown[] = [];
  const staged = "/home/me/.letagents/room-turn-attachments/turn-1/notes.txt";
  agy.onPrompt = async (fake, message) => {
    answers.push(await fake.requestPermission({ toolCallId: "call_read", name: "read_file", kind: "read", title: "File notes.txt",
      locations: [{ path: staged }], rawInput: { Path: staged } }));
    answers.push(await fake.requestPermission({ toolCallId: "call_ssh", name: "read_file", kind: "read", title: "File id_rsa",
      locations: [{ path: "/home/me/.ssh/id_rsa" }], rawInput: { Path: "/home/me/.ssh/id_rsa" } }));
    fake.reply(message, { stopReason: "end_turn" });
  };
  const handle = await adapter.spawn(spawnRequest("read_only"));
  await adapter.runRoomTurn(handle, { ...turnRequest, attachments: [
    { index: 1, fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 12, status: "file", category: "file", file: { path: staged, kind: "text" } },
  ] } as never);
  assert.deepEqual(answers, [
    { outcome: { outcome: "selected", optionId: "allow" } },
    { outcome: { outcome: "selected", optionId: "deny" } },
  ]);
});

test("approval cards show agy's reads and its edits with their change", () => {
  const path = "/w/sample.txt";
  // The shape agy 1.5.15 sends for `edit_file`.
  assert.deepEqual(antigravityPermissionTool({ toolCallId: "call_e", name: "edit_file", kind: "edit", title: "File sample.txt",
    locations: [{ path }], rawInput: { Path: path, Target: "hello world", Replacement: "goodbye world" },
    content: [{ type: "diff", path, oldText: "hello world", newText: "goodbye world" }] }),
  { tool_name: "Edit", input: { file_path: path, old_string: "hello world", new_string: "goodbye world" } });
  assert.deepEqual(antigravityPermissionTool({ toolCallId: "call_e2", name: "edit_file", kind: "edit", locations: [{ path }],
    content: [{ type: "diff", path, oldText: "a", newText: "b" }] }),
  { tool_name: "Edit", input: { file_path: path, old_string: "a", new_string: "b" } }, "the diff block alone is enough");
  assert.deepEqual(antigravityPermissionTool({ toolCallId: "call_r", name: "read_file", kind: "read", rawInput: { Path: "/outside/note.txt" } }),
    { tool_name: "Read", input: { file_path: "/outside/note.txt" } });
});

test("a model id that names its thinking level wins over a saved effort", async () => {
  const { adapter, agy } = harness();
  await adapter.spawn(spawnRequest("read_only", { model: "gemini-4-neon-low", reasoningEffort: "xhigh" }));
  assert.equal(agy.currentModel, "gemini-4-neon");
  assert.equal(agy.currentLevel, "low");
});

test("own setup leaves out plugins the owner turned off and plugins whose servers cannot be read", () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-agy-owner-"));
  roots.push(root);
  const ownerDir = join(root, "owner");
  const agentDir = join(root, "agent");
  for (const plugin of ["kept", "off", "broken"]) mkdirSync(join(ownerDir, "config", "plugins", plugin), { recursive: true });
  writeFileSync(join(ownerDir, "config", "config.json"), JSON.stringify({ plugins: { off: { enabled: false }, kept: { enabled: true } } }));
  writeFileSync(join(ownerDir, "config", "plugins", "broken", "mcp_config.json"), "{ not json");
  const { notices } = prepareAntigravityOwnerSetup(agentDir, true, ownerDir);
  assert.ok(lstatSync(join(agentDir, "config", "plugins", "kept")).isSymbolicLink());
  assert.equal(existsSync(join(agentDir, "config", "plugins", "off")), false, "a plugin the owner turned off stays off");
  assert.equal(existsSync(join(agentDir, "config", "plugins", "broken")), false, "a server list that cannot be read is not trusted");
  assert.match(notices[0] ?? "", /the broken plugin/);
});

test("own setup that failed halfway is still taken out when it is turned off", () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-agy-owner-"));
  roots.push(root);
  const ownerDir = join(root, "owner");
  const agentDir = join(root, "agent");
  mkdirSync(join(ownerDir, "config"), { recursive: true });
  writeFileSync(join(ownerDir, "GEMINI.md"), "Owner rules.");
  // A plugins "folder" that is a file makes the setup fail after the rules are linked.
  writeFileSync(join(ownerDir, "config", "plugins"), "not a folder");
  assert.throws(() => prepareAntigravityOwnerSetup(agentDir, true, ownerDir));
  assert.ok(lstatSync(join(agentDir, "GEMINI.md")).isSymbolicLink());
  prepareAntigravityOwnerSetup(agentDir, false, ownerDir);
  assert.equal(existsSync(join(agentDir, "GEMINI.md")), false);
});
