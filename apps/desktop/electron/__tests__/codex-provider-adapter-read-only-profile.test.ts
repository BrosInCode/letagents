import "./isolated-home.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION, CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import { codexReadOnlyProfileId } from "../main/agents/codex-agent-home.js";
import { CODEX_OWNER_FEATURE_OVERRIDES } from "../../../../shared/codex-owner-isolation.mjs";
import type { ProviderHandle, ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import {
  assertProviderHandle,
  FakeRpc,
  createHarness,
  spawnRequest,
  requestByMethod,
  flush,
  CODEX_READ_ONLY_POLICY,
  READ_ONLY_PROFILE,
  foundAsReadOnly,
  foundAtOtherLevels,
  foundRunning,
  assertStoppedNotReadOnly,
  codexDaemonFixture,
  answerOnReplacement,
  executionRecord,
  effortNotReported,
  SANDBOXED_LAUNCH,
  turnOf,
  scratchCodexHome,
  READ_ONLY_LAUNCH,
  givesAccess,
  namesASandbox,
  endedTurn,
  launchAskedFor,
  SIGN_IN_NOT_CONFIRMED,
  NOT_THE_PROFILE_REPLIES,
} from "./codex-provider-adapter.fixture.js";

test("Codex Read-only counts as a sandboxed access level wherever a saved command rule is looked for: the home at launch, each turn, and each conversation load", { timeout: 60_000 }, async (t) => {
  const run = (harness: ReturnType<typeof createHarness>, adapter: CodexProviderAdapter, handle: ProviderHandle, client: number, name: string) => adapter.runRoomTurn(handle, turnOf(name), {
    checkpointTurnStarted: async (turnId) => { harness.clients[client]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } }); },
  });
  const turnStarts = (harness: ReturnType<typeof createHarness>, client: number) => harness.clients[client]!.requests.filter((request) => request.method === "turn/start").length;
  const repair = (adapter: CodexProviderAdapter, handle: ProviderHandle, cwd = spawnRequest().cwd) => adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    cwd, launchPolicy: CODEX_READ_ONLY_POLICY, forceReplacement: true,
  }, { checkpointReplacement: async () => {} });
  const conversationCalls = (harness: ReturnType<typeof createHarness>, from: number) => harness.clients[0]!.requests.slice(from)
    .map((request) => request.method).filter((method) => /^thread\/(start|resume)$/.test(method));

  // The launch: Read-only asks the launcher for the agents' home, the one without the owner's saved rules. Full access does not.
  const given = await scratchCodexHome(t, false);
  const harness = createHarness({ exitOnSignal: true, reportedCodexHome: given, launchCodexHome: given });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest(READ_ONLY_LAUNCH));
  // What the launcher is asked: `sandboxed` is its word for "give this Codex the agents' home".
  const launchAsked = (launched: ReturnType<typeof createHarness>) => launched.launchOptions[0]!.options as { sandboxed?: boolean };
  assert.equal(launchAsked(harness).sandboxed, true, "a Read-only launch is given the agents' home");
  assert.equal((handle as unknown as { sandboxed(): boolean }).sandboxed(), true, "and its runtime is held to the rule checks");
  const fullAccess = createHarness();
  await new CodexProviderAdapter({ dependencies: fullAccess.dependencies }).spawn(spawnRequest({
    deliveryMode: "daemon_inbox", permissionProfileId: "full_access", configurationRevision: 1 }));
  assert.equal(Object.hasOwn(launchAsked(fullAccess), "sandboxed"), false, "Full access is the one level that is not");

  // It is refused under the same conditions as every sandboxed level: Codex must say that it runs with the home it was given.
  const other = await scratchCodexHome(t, false);
  for (const [name, options, reason] of [
    ["says nothing", { reportedCodexHome: null, launchCodexHome: given }, /^Error: Codex did not say which home folder it runs with/],
    ["says nothing, started with the owner's home", { reportedCodexHome: null }, /^Error: Codex did not say which home folder it runs with/],
    ["says another home", { reportedCodexHome: other, launchCodexHome: given }, /^Error: Codex did not start with the home folder LetAgents gave it for this access level/],
  ] as const) {
    const refused = createHarness({ exitOnSignal: true, ...options });
    await assert.rejects(new CodexProviderAdapter({ dependencies: refused.dependencies }).spawn(spawnRequest(READ_ONLY_LAUNCH)), reason, name);
    assert.deepEqual(refused.signals.map((signal) => signal.signal), ["SIGTERM"], name);
    assert.equal(refused.clients[0]!.requests.some((request) => request.method === "thread/start"), false, `${name}: no conversation was opened`);
  }

  // The turn gate: a home that gains a saved rule gives the agent no turn, started here or found running.
  await run(harness, adapter, handle, 0, "no-rule");
  assert.equal(turnStarts(harness, 0), 1);
  await mkdir(join(given, "rules"));
  await writeFile(join(given, "rules", "default.rules"), "saved\n");
  const HOLDS_RULES = /^Error: This agent's Codex runs with a home folder that holds saved command rules/;
  await assert.rejects(run(harness, adapter, handle, 0, "rule-saved"), HOLDS_RULES);
  assert.equal(turnStarts(harness, 0), 1, "Codex was sent no turn");
  const restarted = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await restarted.attach({ workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection, launchPolicy: CODEX_READ_ONLY_POLICY });
  assertProviderHandle(attached);
  await assert.rejects(run(harness, restarted, attached, 1, "found-running"), HOLDS_RULES);
  assert.equal(turnStarts(harness, 1), 0);
  await rm(join(given, "rules"), { recursive: true });
  await run(harness, adapter, handle, 0, "rule-removed");
  assert.equal(turnStarts(harness, 0), 2, "with the rule gone the same process works again");

  // The conversation-load check: before a conversation is started or loaded again Codex is asked, with the home it runs with.
  assert.equal((await repair(adapter, handle)).outcome, "replaced");
  assert.deepEqual(harness.ruleLoadChecks, [{ cwd: spawnRequest().cwd, codexHome: given }]);
  const REFUSAL = "Codex also reads command rules from /etc/codex/rules, a folder of this computer's own Codex settings.";
  harness.refuseRuleLoad(REFUSAL);
  const before = harness.clients[0]!.requests.length;
  await assert.rejects(repair(adapter, handle), (error: Error) => error.message === REFUSAL);
  assert.deepEqual(conversationCalls(harness, before), [], "no conversation is started or loaded");
  assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"], "and the agent is stopped");

  // A project with command rules of its own: no turn, and no conversation load, in that folder.
  const project = await mkdtemp(join(tmpdir(), "letagents-codex-adapter-read-only-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const cwd = await realpath(project);
  await mkdir(join(cwd, ".git"));
  const inProject = createHarness({ exitOnSignal: true, reportedCodexHome: given });
  const projectAdapter = new CodexProviderAdapter({ dependencies: inProject.dependencies });
  const projectHandle = await projectAdapter.spawn(spawnRequest({ ...READ_ONLY_LAUNCH, cwd }));
  await run(inProject, projectAdapter, projectHandle, 0, "before");
  await mkdir(join(cwd, ".codex", "rules"), { recursive: true });
  await writeFile(join(cwd, ".codex", "rules", "allow.rules"), "saved\n");
  const PROJECT_RULES = /^Error: Codex reads command rules from \.codex\/rules in this agent's work folder once it trusts the project, and that folder is not empty \(allow\.rules\)/;
  await assert.rejects(run(inProject, projectAdapter, projectHandle, 0, "turn"), PROJECT_RULES);
  assert.equal(turnStarts(inProject, 0), 1, "Codex was sent no turn");
  const beforeRepair = inProject.clients[0]!.requests.length;
  await assert.rejects(repair(projectAdapter, projectHandle, cwd), PROJECT_RULES);
  assert.deepEqual(conversationCalls(inProject, beforeRepair), []);
  assert.deepEqual(inProject.ruleLoadChecks, [], "the folder is enough: Codex is not asked whether it trusts the project");
});

test("a Read-only conversation's reply is held to its policy and compared with its reasoning effort, and only the policy can refuse it", { timeout: 30_000 }, async () => {
  const request = () => spawnRequest({ ...READ_ONLY_LAUNCH, model: "gpt-5.6-sol", reasoningEffort: "high" });
  const misreporting = (options: Parameters<typeof createHarness>[0], misreport: (client: FakeRpc) => void) => {
    const harness = createHarness(options);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; misreport(client); return client; };
    return harness;
  };

  // One request names the policy and the effort; a reply that agrees with both starts the agent and says nothing.
  const agreeing = createHarness();
  const handle = await new CodexProviderAdapter({ dependencies: agreeing.dependencies }).spawn(request());
  const started = requestByMethod(agreeing.clients[0]!, "thread/start").params as Record<string, unknown>;
  assert.deepEqual({ approvalPolicy: started.approvalPolicy, permissions: started.permissions, sandbox: started.sandbox, approvalsReviewer: started.approvalsReviewer, config: started.config },
    { approvalPolicy: "never", permissions: READ_ONLY_PROFILE, sandbox: undefined, approvalsReviewer: "user", config: { model_reasoning_effort: "high", web_search: "disabled" } });
  assert.deepEqual(handle.launchNotices, []);
  assert.equal(handle.observedState(), "idle");

  // Another effort than the one given is told to the owner and stops nothing, as at every level: the policy is still the one asked for.
  const otherEffort = createHarness({ effortFromOwnSettings: "low" });
  const told = await new CodexProviderAdapter({ dependencies: otherEffort.dependencies }).spawn(request());
  assert.equal(told.observedState(), "idle");
  assert.deepEqual(told.launchNotices, [effortNotReported("high", "low")]);

  // Another sandbox is refused, whether the effort agrees or not. The effort line is no substitute for the policy check.
  for (const effortFromOwnSettings of [undefined, "low"] as const) {
    const refused = misreporting(effortFromOwnSettings ? { effortFromOwnSettings } : {}, (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; });
    await assert.rejects(new CodexProviderAdapter({ dependencies: refused.dependencies }).spawn(request()), /did not confirm Read-only access/, String(effortFromOwnSettings));
    assert.equal(refused.clients[0]!.requests.some((call) => call.method === "turn/start"), false);
  }

  // The same at a resume in another process: the reply names the effort the resume gave, and is refused for its policy alone.
  agreeing.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  const resumed = await new CodexProviderAdapter({ dependencies: agreeing.dependencies }).resume(
    { workAttemptId: request().workAttemptId, providerContinuationId: handle.providerContinuationId! }, { ...request(), reasoningEffort: "low" });
  const resume = requestByMethod(agreeing.clients[1]!, "thread/resume").params as Record<string, unknown>;
  assert.deepEqual({ approvalPolicy: resume.approvalPolicy, permissions: resume.permissions, sandbox: resume.sandbox, config: resume.config },
    { approvalPolicy: "never", permissions: READ_ONLY_PROFILE, sandbox: undefined, config: { model_reasoning_effort: "low", web_search: "disabled" } });
  assert.deepEqual(resumed.launchNotices, []);
  agreeing.launches[1]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  const createRpcClient = agreeing.dependencies.createRpcClient;
  agreeing.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; client.approvalPolicyFromOwnSettings = "on-request"; return client; };
  await assert.rejects(new CodexProviderAdapter({ dependencies: agreeing.dependencies }).resume(
    { workAttemptId: request().workAttemptId, providerContinuationId: handle.providerContinuationId! }, request()), /did not confirm Read-only access/);
});

test("before a sandboxed Codex without its owner's setup starts or loads a conversation, what it would turn off now is compared with what it was started with", async (t) => {
  const home = await scratchCodexHome(t, false);
  const repair = (adapter: CodexProviderAdapter, handle: ProviderHandle, launchPolicy: unknown) => adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    cwd: spawnRequest().cwd, launchPolicy, forceReplacement: true,
  }, { checkpointReplacement: async () => {} });
  const conversationCallsAfter = (harness: ReturnType<typeof createHarness>, from: number) =>
    harness.clients[0]!.requests.slice(from).map((request) => request.method).filter((method) => /^thread\/(start|resume)$/.test(method));

  // Nothing changed: the repair goes on. Codex was asked with the process's own command line, the agent's folder and the home it runs with.
  const clean = createHarness({ exitOnSignal: true, reportedCodexHome: home });
  const cleanAdapter = new CodexProviderAdapter({ dependencies: clean.dependencies });
  const repaired = await cleanAdapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
  assert.equal((await repair(cleanAdapter, repaired, SANDBOXED_LAUNCH.launchPolicy)).outcome, "replaced");
  assert.equal(clean.isolationChecks.length, 1);
  assert.deepEqual({ cwd: clean.isolationChecks[0]!.cwd, codexHome: clean.isolationChecks[0]!.codexHome }, { cwd: spawnRequest().cwd, codexHome: home });
  for (const override of CODEX_OWNER_FEATURE_OVERRIDES) assert.ok(clean.isolationChecks[0]!.commandLine.includes(override), override);
  // And with its launch's own overrides, which set the room's server: Codex is asked to list its servers as that launch asked.
  assert.equal(clean.launchOptions[0]!.options.configOverrides.some((override) => override.startsWith("mcp_servers.letagents")), true);
  assert.deepEqual(clean.isolationChecks[0]!.launchOverrides, clean.launchOptions[0]!.options.configOverrides);
  assert.deepEqual(clean.signals, []);

  // A process that another service instance started and this one found running: its launch's overrides are not known, and the check is told so.
  const found = createHarness({ exitOnSignal: true, reportedCodexHome: home });
  const started = await new CodexProviderAdapter({ dependencies: found.dependencies }).spawn(spawnRequest(SANDBOXED_LAUNCH));
  const finder = new CodexProviderAdapter({ dependencies: found.dependencies });
  const attached = await finder.attach({ workAttemptId: started.workAttemptId, providerContinuationId: started.providerContinuationId!,
    providerConnection: started.providerConnection, launchPolicy: SANDBOXED_LAUNCH.launchPolicy });
  assertProviderHandle(attached);
  assert.equal((await repair(finder, attached, SANDBOXED_LAUNCH.launchPolicy)).outcome, "replaced");
  assert.deepEqual(found.isolationChecks.map((check) => check.launchOverrides), [null]);

  // A project the owner trusts gained an MCP server since the launch: no conversation is started, and the agent is stopped and says why.
  const CHANGED = "This project's Codex config, or your own, now has an MCP server or a skill that was not there when this agent started, "
    + "so LetAgents stopped the agent before Codex could load it. It starts again with it turned off, unless you paused it.";
  const harness = createHarness({ exitOnSignal: true, reportedCodexHome: home });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
  const said: string[] = [];
  adapter.onStream(handle, (event) => { if (event.method === "sandboxRules/stopped") said.push(event.summary ?? ""); });
  const before = harness.clients[0]!.requests.length;
  harness.changeIsolation(CHANGED);
  await assert.rejects(repair(adapter, handle, SANDBOXED_LAUNCH.launchPolicy), (error: Error) => error.message === CHANGED);
  assert.deepEqual(conversationCallsAfter(harness, before), []);
  assert.deepEqual(said, [`Stopped this agent. ${CHANGED}`]);
  assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"]);

  // A process whose command line cannot be read is not taken as unchanged.
  const unreadable = createHarness({ exitOnSignal: true, reportedCodexHome: home, processUnreadable: true });
  const unreadableAdapter = new CodexProviderAdapter({ dependencies: unreadable.dependencies });
  const unread = await unreadableAdapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
  await assert.rejects(repair(unreadableAdapter, unread, SANDBOXED_LAUNCH.launchPolicy),
    /^Error: LetAgents could not read how this agent's Codex was started, so it stopped the agent before Codex could load a project's MCP servers\. It starts again by itself, unless you paused it\.$/);
  assert.deepEqual(unreadable.isolationChecks, []);
  assert.deepEqual(unreadable.signals.map((signal) => signal.signal), ["SIGTERM"]);

  // At Full access nothing is asked, as before: there is no sandbox for a new server to start outside of.
  const fullAccess = createHarness({ reportedCodexHome: home });
  const fullAccessAdapter = new CodexProviderAdapter({ dependencies: fullAccess.dependencies });
  const unsandboxed = await fullAccessAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  fullAccess.changeIsolation(CHANGED);
  assert.equal((await repair(fullAccessAdapter, unsandboxed, spawnRequest().launchPolicy)).outcome, "replaced");
  assert.deepEqual([fullAccess.isolationChecks, fullAccess.commandLineReads], [[], []]);
});

test("a launch and a load say whether the sandbox lets a command write the project, so the folders the Codex config adds to it are looked at only then", async (t) => {
  const home = await scratchCodexHome(t, false);
  const AUTO = { deliveryMode: "daemon_inbox" as const, permissionProfileId: "auto_review" as const, configurationRevision: 1,
    launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" } };
  for (const [name, launch, writes] of [["Auto", AUTO, true], ["Ask before writes", SANDBOXED_LAUNCH, false], ["Read-only", READ_ONLY_LAUNCH, false]] as const) {
    const harness = createHarness({ reportedCodexHome: home });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest(launch));
    const options = harness.launchOptions[0]!.options as { sandboxed?: boolean; writableSandbox?: boolean };
    assert.deepEqual([options.sandboxed, options.writableSandbox === true], [true, writes], name);
    await adapter.repairContinuation(handle, { workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: launch.launchPolicy, forceReplacement: true }, { checkpointReplacement: async () => {} });
    assert.deepEqual(harness.writableSandboxAsked, [writes], name);
  }
});

test("the folders the Codex config lets a command write are looked at again before every turn, as they were named at the launch and then at the last load", async (t) => {
  const home = await scratchCodexHome(t, false);
  const AUTO = { deliveryMode: "daemon_inbox" as const, permissionProfileId: "auto_review" as const, configurationRevision: 1,
    launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" } };
  const harness = createHarness({ reportedCodexHome: home });
  // What the launch's look and the load's look answer when they are asked again. A launch gives one only for a sandbox that writes.
  const answers: { launch: string | null | Error; load: string | null } = { launch: null, load: null };
  const asked: string[] = [];
  const launchServer = harness.dependencies.launchServer;
  harness.dependencies.launchServer = async (...args) => ({ ...(await launchServer(...args)), writableFoldersCheck: () => {
    asked.push("launch");
    if (answers.launch instanceof Error) throw answers.launch;
    return answers.launch;
  } });
  const sandboxedLoadRefusal = harness.dependencies.sandboxedLoadRefusal;
  harness.dependencies.sandboxedLoadRefusal = async (codexBin, live, keep) => {
    const refusal = await sandboxedLoadRefusal(codexBin, live);
    keep?.(() => { asked.push("load"); return answers.load; });
    return refusal;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest(AUTO));
  const turnsStarted = () => harness.clients[0]!.requests.filter((call) => call.method === "turn/start").length;
  const turn = (name: string) => adapter.runRoomTurn(handle, turnOf(name), {
    checkpointTurnStarted: async (turnId) => { harness.clients[0]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } }); },
  });

  // Nothing has changed: the turn starts, and the folders were looked at for it.
  await turn("first");
  assert.deepEqual([turnsStarted(), asked.includes("launch")], [1, true]);
  // A named folder now leads into a home: the turn is not started, in the look's own words.
  const INTO_A_HOME = "Your Codex config lets a sandboxed command write a folder that is now the Codex home LetAgents keeps for sandboxed agents.";
  answers.launch = INTO_A_HOME;
  await assert.rejects(turn("second"), (error: Error) => error.message === INTO_A_HOME);
  assert.equal(turnsStarted(), 1);
  // A look that fails is not taken as safe.
  answers.launch = new Error("EACCES: permission denied\nmore");
  await assert.rejects(turn("third"),
    /^Error: LetAgents could not look at the folders your Codex config lets a sandboxed command write \(EACCES: permission denied\), so it gives this agent no work\. Pause the agent and resume it\.$/);
  assert.equal(turnsStarted(), 1);

  // A load names the folders anew: from then on its look is the one asked, and the launch's is not.
  answers.launch = null;
  await adapter.repairContinuation(handle, { workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    cwd: spawnRequest().cwd, launchPolicy: AUTO.launchPolicy, forceReplacement: true }, { checkpointReplacement: async () => {} });
  answers.launch = INTO_A_HOME;
  asked.length = 0;
  await turn("fourth");
  assert.deepEqual([turnsStarted(), [...new Set(asked)]], [2, ["load"]]);
  answers.load = "The folder named at the load now leads into a home.";
  await assert.rejects(turn("fifth"), (error: Error) => error.message === answers.load);
  assert.equal(turnsStarted(), 2);
});

test("a Read-only Codex whose stop failed when its policy was bound is stopped at the next attach, not left running until its owner restarts it", { timeout: 30_000 }, async () => {
  const scene = await foundRunning(foundAsReadOnly(), (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; }, false);
  // Found before the daemon supplied its policy: attached as it is.
  assertProviderHandle(await scene.attach());
  // The policy is bound, and the stop cannot be made: the process's birth cannot be read for now.
  scene.harness.setIdentityObservable(false);
  const NOT_STOPPED = /^Error: Codex reported approval policy "never" and sandbox "dangerFullAccess" for this agent's conversation\. That is not Read-only access, and LetAgents could not stop the agent: /;
  await assert.rejects(Promise.resolve(scene.attach(true)), NOT_STOPPED);
  // Each attach tries again, and while it cannot be stopped the runtime takes no turn.
  await assert.rejects(Promise.resolve(scene.attach(true)), NOT_STOPPED);
  assert.deepEqual(scene.harness.signals, []);
  assert.equal(scene.harness.launches[0]!.alive, true);
  // Its birth can be read again: the next attach stops it and answers with the proof.
  scene.harness.setIdentityObservable(true);
  assertStoppedNotReadOnly(await scene.attach(true), scene, "after the stop could be made");
  // One stop serves every later caller.
  assert.equal((await scene.attach(true) as { state?: string }).state, "terminal");
  assert.equal(scene.harness.signals.length, 1);
});

test("a Read-only Codex found with no loaded conversation is held to what the conversation reports when it is first subscribed to", { timeout: 30_000 }, async () => {
  for (const misreports of [true, false]) {
    const harness = createHarness({ exitOnSignal: true });
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest(READ_ONLY_LAUNCH));
    const createRpcClient = harness.dependencies.createRpcClient;
    let materialized = false;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown) => {
        // The conversation has had no message yet, so it cannot be read with its turns, and nothing is loaded to subscribe to.
        if (method === "thread/read" && !materialized && (params as { includeTurns?: boolean }).includeTurns) {
          throw new Error(`thread ${first.providerContinuationId} is not materialized yet; includeTurns is unavailable before first user message`);
        }
        if (method === "turn/start") { materialized = true; client.turnStatus = "inProgress"; }
        // The first reply that names what the conversation got.
        if (method === "thread/resume") { if (misreports) client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; client.turnStatus = "completed"; }
        return request<T>(method, params);
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({ workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection, launchPolicy: READ_ONLY_LAUNCH.launchPolicy });
    assertProviderHandle(attached);
    assert.equal(harness.clients[1]!.requests.some((call) => call.method === "thread/resume"), false, "nothing was loaded to subscribe to when it was found");
    const turn = adapter.runRoomTurn(attached, turnOf("first-turn"), { checkpointTurnStarted: async () => {} });
    if (!misreports) {
      await turn;
      assert.deepEqual(harness.signals, []);
      continue;
    }
    await assert.rejects(turn, /^Error: Codex reported approval policy "never" and sandbox "dangerFullAccess" for this agent's conversation\. That is not Read-only access, so LetAgents stopped the agent\. It starts again by itself, unless you paused it\.$/);
    assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"], "its process is stopped: the turn must not go on");
    // And it takes no other turn.
    await assert.rejects(adapter.runRoomTurn(attached, turnOf("second-turn"), { checkpointTurnStarted: async () => {} }), /That is not Read-only access/);
    assert.equal(harness.clients[1]!.requests.filter((call) => call.method === "turn/start").length, 1);
  }
});

test("a turn that is running when a Read-only Codex is stopped at reattach ends as a failed room item that says so, is not run again, and the next message runs on the fresh start", { timeout: 60_000 }, async () => {
  const agent = await codexDaemonFixture();
  const snap = async () => { const current = await agent.view(); return `agent is ${current.observed_state}/${current.condition} (${current.last_error}); launches ${agent.harness.launches.length}; signals ${JSON.stringify(agent.harness.signals)}`; };
  try {
    // The owner saves Read-only, and the daemon starts the agent again at that level by itself.
    const configuration = (await agent.request("supervisor.get_agent_configuration", { entry_id: agent.id, daemon_generation: agent.daemonGeneration() })).result;
    const saved = await agent.request("supervisor.update_agent_configuration", { entry_id: agent.id, daemon_generation: agent.daemonGeneration(),
      expected_revision: configuration.config_revision, configuration: { model: configuration.model, reasoning_effort: configuration.reasoning_effort ?? null,
        charter: configuration.charter, permission_profile_id: "read_only" } });
    assert.equal(saved.result?.outcome, "updated", saved.error ?? JSON.stringify(saved.result));
    await agent.eventually(() => agent.harness.launches.length === 2 && agent.harness.clients.length === 2, "the Read-only runtime is started")
      .catch(async (error) => { throw new Error(`${(error as Error).message}: ${await snap()}`); });
    agent.serveThread(agent.harness.clients[1]!);
    const readOnlyRuntime = agent.harness.launches[1]!;

    // A room message starts its turn on it, and the turn is still running when the daemon ends.
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    agent.harness.clients.at(-1)!.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
    assert.equal((await agent.receipt("msg_1"))?.state, "dispatching");

    // The new daemon finds the runtime, and its conversation reports a sandbox that is not Read-only.
    agent.whenNextConnects((server) => { server.sandboxFromOwnSettings = { type: "dangerFullAccess" }; });
    await agent.restartDaemon();

    // The runtime is stopped, and the agent starts again as a new Read-only process.
    await agent.eventually(() => agent.harness.launches.length === 3 && agent.harness.clients.length === 4, "the agent starts again")
      .catch(async (error) => { throw new Error(`${(error as Error).message}: ${await snap()}`); });
    assert.deepEqual(agent.harness.signals.filter((signal) => signal.pid === readOnlyRuntime.pid), [{ pid: readOnlyRuntime.pid, signal: "SIGTERM" }]);
    assert.equal(readOnlyRuntime.alive, false);
    assert.deepEqual(agent.harness.launchOptions[2]!.options.configOverrides.slice(-1), ['web_search="disabled"']);
    assert.ok((await executionRecord(agent).notices()).includes('Codex reported approval policy "never" and sandbox "dangerFullAccess" for this agent\'s conversation. '
      + "That is not Read-only access, so LetAgents stopped the agent. It starts again by itself, unless you paused it."), "the owner is told why");

    // The room item of the stopped turn: failed, with the reason, after one attempt. Its turn is not started again on the new process.
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "the item of the stopped turn is failed")
      .catch(async (error) => { throw new Error(`${(error as Error).message}: ${JSON.stringify(await agent.receipt("msg_1"))}`); });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const failed = (await agent.receipt("msg_1"))! as unknown as { state: string; attempt_count: number; last_error: string | null; next_attempt_at_ms: number | null };
    assert.deepEqual({ state: failed.state, attempts: failed.attempt_count, error: failed.last_error, retry: failed.next_attempt_at_ms }, { state: "acknowledged_failed", attempts: 1,
      error: "The agent's process ended during this turn, and the turn's result could not be recovered. The message was not run again.", retry: null });
    assert.equal(agent.turns.length, 1, "the stopped turn is not started again");

    // The agent is not left stuck behind it: the next message runs on the new process and is answered.
    await answerOnReplacement(agent, 2);
    assert.equal(agent.turns.length, 2);
    assert.equal((await agent.receipt("msg_1"))?.state, "acknowledged_failed");
  } finally {
    await agent.cleanup();
  }
});

test("no request of a Read-only runtime names a sandbox, and every one that gives a conversation or a turn its access names the permission profile", { timeout: 60_000 }, async () => {
  const harness = createHarness({ exitOnSignal: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  // The launch is told the profile it must define, with the owner's sign-in file denied. It is the profile of this work attempt and of no other.
  const first = await adapter.spawn(spawnRequest(READ_ONLY_LAUNCH));
  assert.equal(launchAskedFor(harness).hideSignInProfile, READ_ONLY_PROFILE);
  assert.equal(launchAskedFor(harness).sandboxed, true);
  assert.match(READ_ONLY_PROFILE, /^letagents_read_only_[0-9a-f]{24}$/);
  assert.notEqual(codexReadOnlyProfileId("another-work-attempt"), READ_ONLY_PROFILE);

  // Every way this runtime gives a conversation or a turn its access: a room turn, a turn that redirects it,
  await endedTurn(adapter, first, harness.clients[0]!, "room-turn");
  await adapter.controlTurn(first, "Go on with this instead.");
  // a repair that loads the same conversation again, and one that starts another,
  const repair = (forceReplacement: boolean) => adapter.repairContinuation!(first, {
    workAttemptId: first.workAttemptId, expectedProviderContinuationId: first.providerContinuationId!,
    forceReplacement, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
  }, { checkpointReplacement: async () => {} });
  assert.equal((await repair(false)).outcome, "rematerialized");
  assert.equal((await repair(true)).outcome, "replaced");
  // a daemon that finds the process running, with its policy and without it,
  const ref = { workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection };
  const finder = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const found = await finder.attach({ ...ref, launchPolicy: READ_ONLY_LAUNCH.launchPolicy });
  assertProviderHandle(found);
  await endedTurn(finder, found, harness.clients[1]!, "turn-after-reattach");
  const lateFinder = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const foundEarly = await lateFinder.attach(ref);
  assertProviderHandle(foundEarly);
  assert.equal(await lateFinder.attach({ ...ref, launchPolicy: READ_ONLY_LAUNCH.launchPolicy }), foundEarly);
  await endedTurn(lateFinder, foundEarly, harness.clients[2]!, "turn-after-late-policy");
  // and a new process that loads the conversation after the first one ended.
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  const resumed = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume(
    { workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId! }, spawnRequest(READ_ONLY_LAUNCH));
  assert.equal(resumed.observedState(), "idle");
  assert.equal(launchAskedFor(harness, 1).hideSignInProfile, READ_ONLY_PROFILE, "the new process defines the profile too");

  const sent = harness.clients.flatMap((client) => client.requests);
  assert.deepEqual(sent.filter(namesASandbox).map((call) => call.method), [], "no request names a sandbox: Codex refuses one beside a profile, and one alone takes the profile away");
  const access = sent.filter(givesAccess);
  assert.deepEqual(access.filter((call) => (call.params as { permissions?: unknown }).permissions !== READ_ONLY_PROFILE).map((call) => call.method), [], "each of them names the profile");
  assert.deepEqual(access.filter((call) => (call.params as { approvalPolicy?: unknown }).approvalPolicy !== "never").map((call) => call.method), [], "and nobody to ask");
  // Each kind was sent, so none of them went unlooked at.
  const count = (method: string) => access.filter((call) => call.method === method).length;
  assert.deepEqual({ starts: count("thread/start"), loads: count("thread/resume"), turns: count("turn/start") }, { starts: 2, loads: 2, turns: 4 });
  // A subscription to a conversation that is already loaded asks for nothing: its reply is what the conversation has.
  const subscriptions = sent.filter((call) => call.method === "thread/resume" && !givesAccess(call));
  assert.equal(subscriptions.length >= 2, true);
  for (const subscription of subscriptions) assert.deepEqual(Object.keys(subscription.params as object), ["threadId"]);

  // Every other access level is as it was: a sandbox by name, no profile, and a launch that defines none.
  for (const level of foundAtOtherLevels()) {
    const other = createHarness();
    const otherAdapter = new CodexProviderAdapter({ dependencies: other.dependencies });
    const handle = await otherAdapter.spawn(spawnRequest(level));
    await endedTurn(otherAdapter, handle, other.clients[0]!, "other-level");
    assert.equal(Object.hasOwn(launchAskedFor(other), "hideSignInProfile"), false, level.permissionProfileId);
    const others = other.clients[0]!.requests.filter(givesAccess);
    assert.deepEqual(others.map((call) => call.method), ["thread/start", "turn/start"], level.permissionProfileId);
    assert.deepEqual(others.map(namesASandbox), [true, true], level.permissionProfileId);
    assert.deepEqual(others.map((call) => Object.hasOwn(call.params as object, "permissions")), [false, false], level.permissionProfileId);
  }
});

test("a stored policy cannot name another permission profile for a Read-only conversation", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ ...READ_ONLY_LAUNCH, launchPolicy: { ...CODEX_READ_ONLY_POLICY, permissions: ":danger-full-access" } }));
  await endedTurn(adapter, handle, harness.clients[0]!, "stored-profile");
  for (const call of harness.clients[0]!.requests.filter(givesAccess)) assert.equal((call.params as { permissions?: unknown }).permissions, READ_ONLY_PROFILE, call.method);
});

test("a Read-only conversation that does not report the profile of its work attempt is not used: at a start, a resume and a repair", { timeout: 30_000 }, async () => {
  const request = () => spawnRequest(READ_ONLY_LAUNCH);
  for (const [what, misreport] of NOT_THE_PROFILE_REPLIES) {
    // A new thread.
    const fresh = createHarness();
    const createRpcClient = fresh.dependencies.createRpcClient;
    fresh.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; misreport(client); return client; };
    await assert.rejects(new CodexProviderAdapter({ dependencies: fresh.dependencies }).spawn(request()), SIGN_IN_NOT_CONFIRMED, `thread/start: ${what}`);
    assert.equal(fresh.clients[0]!.requests.some((call) => call.method === "turn/start"), false, `thread/start: ${what}`);
    assert.deepEqual(fresh.signals.map((signal) => signal.pid), [fresh.launches[0]!.pid], `the app-server started for it is stopped: ${what}`);

    // A thread resumed in a new process.
    const resumed = createHarness();
    const first = await new CodexProviderAdapter({ dependencies: resumed.dependencies }).spawn(request());
    resumed.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
    await flush();
    const resumeRpcClient = resumed.dependencies.createRpcClient;
    resumed.dependencies.createRpcClient = (...args) => { const client = resumeRpcClient(...args) as FakeRpc; misreport(client); return client; };
    await assert.rejects(new CodexProviderAdapter({ dependencies: resumed.dependencies }).resume({
      workAttemptId: request().workAttemptId, providerContinuationId: first.providerContinuationId!,
    }, request()), SIGN_IN_NOT_CONFIRMED, `thread/resume: ${what}`);
    assert.equal(resumed.clients[1]!.requests.some((call) => call.method === "turn/start"), false, `thread/resume: ${what}`);
    assert.deepEqual(resumed.signals.map((signal) => signal.pid), [resumed.launches[1]!.pid], `the app-server started for the resume is stopped: ${what}`);

    // A conversation repaired inside a running process: the same thread again, or a new one.
    for (const forceReplacement of [false, true]) {
      const repaired = createHarness();
      const adapter = new CodexProviderAdapter({ dependencies: repaired.dependencies });
      const handle = await adapter.spawn(request());
      misreport(repaired.clients[0]!);
      let checkpointed = false;
      await assert.rejects(adapter.repairContinuation!(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
        forceReplacement, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
      }, { checkpointReplacement: async () => { checkpointed = true; } }), SIGN_IN_NOT_CONFIRMED, `repair ${forceReplacement}: ${what}`);
      assert.equal(checkpointed, false, "a refused thread never becomes the agent's conversation");
    }
  }
  // A reply that fails for its sandbox says so, as before: the two refusals are told apart.
  const widened = createHarness();
  const createRpcClient = widened.dependencies.createRpcClient;
  widened.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; return client; };
  await assert.rejects(new CodexProviderAdapter({ dependencies: widened.dependencies }).spawn(request()), /did not confirm Read-only access/);
  // No other access level is held to a profile: Codex reports none for a conversation that names a sandbox.
  for (const level of foundAtOtherLevels()) {
    const other = createHarness();
    assert.equal((await new CodexProviderAdapter({ dependencies: other.dependencies }).spawn(spawnRequest(level))).observedState(), "idle", level.permissionProfileId);
  }
});

test("a Read-only Codex found running whose conversation does not report the profile is stopped and its owner is told, as a process started before the profile existed is", { timeout: 30_000 }, async () => {
  const lines = new Map<string, string>();
  for (const [what, misreport] of NOT_THE_PROFILE_REPLIES) {
    // Found with its policy: the reply of the subscription is held to the profile.
    const scene = await foundRunning(foundAsReadOnly(), misreport);
    lines.set(what, assertStoppedNotReadOnly(await scene.attach(), scene, what));
    // Found before the daemon supplied its policy: held to the profile when the policy is bound.
    const late = await foundRunning(foundAsReadOnly(), misreport, false);
    const early = await late.attach();
    assertProviderHandle(early);
    assert.deepEqual(late.harness.signals, [], `${what}: nothing is stopped while no policy says what the conversation must be`);
    assertStoppedNotReadOnly(await late.attach(true), late, `${what}, bound later`);
  }
  assert.equal(lines.get("no permission profile"),
    "Codex reported no permission profile for this agent's conversation, so nothing says that your Codex sign-in file is kept from its commands. "
    + "That is not Read-only access, so LetAgents stopped the agent. It starts again by itself, unless you paused it.");
  assert.match(lines.get("a profile of the owner's")!, /^Codex reported another permission profile than the one LetAgents gave it for this agent's conversation, /);
  assert.equal(lines.get("a profile of the owner's")!.includes("owner_profile"), false, "a name Codex reports is not repeated to the room");

  // A process that an earlier build started: its conversation was given the read-only sandbox by name, and Codex reports no profile for it.
  const old = await foundRunning(foundAsReadOnly(), null);
  old.harness.clients[0]!.threadPolicies.set(old.ref.providerContinuationId, { approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null });
  assertStoppedNotReadOnly(await old.attach(), old, "started before the profile");
  // The daemon's next launch is a new process that defines the profile, and its conversation is loaded with it.
  const next = await old.restarted.resume({ workAttemptId: old.ref.workAttemptId, providerContinuationId: old.ref.providerContinuationId }, spawnRequest(old.level));
  assert.equal(next.observedState(), "idle");
  assert.equal(launchAskedFor(old.harness, 1).hideSignInProfile, READ_ONLY_PROFILE);
  assert.equal((requestByMethod(old.harness.clients.at(-1)!, "thread/resume").params as { permissions?: unknown }).permissions, READ_ONLY_PROFILE);

  // Every other level is attached whatever profile its conversation reports.
  for (const level of foundAtOtherLevels()) {
    for (const [what, misreport] of NOT_THE_PROFILE_REPLIES) {
      const other = await foundRunning(level, misreport);
      assertProviderHandle(await other.attach());
      assert.deepEqual(other.harness.signals, [], `${level.permissionProfileId}: ${what}`);
    }
  }
});

test("a Read-only Codex found with no loaded conversation is held to the profile when the conversation is first subscribed to", { timeout: 30_000 }, async () => {
  const harness = createHarness({ exitOnSignal: true });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest(READ_ONLY_LAUNCH));
  const createRpcClient = harness.dependencies.createRpcClient;
  let materialized = false;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      // The conversation has had no message yet, so it cannot be read with its turns, and nothing is loaded to subscribe to.
      if (method === "thread/read" && !materialized && (params as { includeTurns?: boolean }).includeTurns) {
        throw new Error(`thread ${first.providerContinuationId} is not materialized yet; includeTurns is unavailable before first user message`);
      }
      if (method === "turn/start") { materialized = true; client.turnStatus = "inProgress"; }
      // The first reply that names what the conversation got: the sandbox it should have, and no profile.
      if (method === "thread/resume") { client.profileFromOwnSettings = null; client.turnStatus = "completed"; }
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection, launchPolicy: READ_ONLY_LAUNCH.launchPolicy });
  assertProviderHandle(attached);
  await assert.rejects(adapter.runRoomTurn(attached, turnOf("first-turn"), { checkpointTurnStarted: async () => {} }),
    /^Error: Codex reported no permission profile for this agent's conversation, so nothing says that your Codex sign-in file is kept from its commands\. That is not Read-only access, so LetAgents stopped the agent\. It starts again by itself, unless you paused it\.$/);
  assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"], "its process is stopped: the turn must not go on");
  await assert.rejects(adapter.runRoomTurn(attached, turnOf("second-turn"), { checkpointTurnStarted: async () => {} }), /That is not Read-only access/);
  assert.equal(harness.clients[1]!.requests.filter((call) => call.method === "turn/start").length, 1);
});

test("when Codex says that a Read-only conversation's settings changed, they are held to Read-only: another profile, none, or another sandbox stops the runtime and its owner is told", { timeout: 30_000 }, async () => {
  const profile = { id: READ_ONLY_PROFILE, extends: ":read-only" };
  const readOnlySettings = { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false }, activePermissionProfile: profile, model: "gpt-5.6-sol" };
  const started = async (level: Record<string, unknown> = READ_ONLY_LAUNCH) => {
    const harness = createHarness({ exitOnSignal: true });
    const stream: ProviderStreamEvent[] = [];
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
    const handle = await adapter.spawn(spawnRequest(level));
    const changed = (threadSettings: unknown, threadId = handle.providerContinuationId) => harness.clients[0]!.emit({ method: "thread/settings/updated", params: { threadId, threadSettings } });
    return { harness, adapter, handle, changed, said: () => stream.filter((event) => event.method === "readOnly/stopped").map((event) => event.summary) };
  };

  // Settings that are still Read-only's stop nothing: the same profile again, a change of model, a notice with no settings, another conversation's.
  const healthy = await started();
  healthy.changed(readOnlySettings);
  healthy.changed({ ...readOnlySettings, model: "another-model", effort: "high" });
  healthy.harness.clients[0]!.emit({ method: "thread/settings/updated", params: { threadId: healthy.handle.providerContinuationId } });
  healthy.changed({ ...readOnlySettings, activePermissionProfile: null }, "another-conversation");
  await flush();
  assert.deepEqual([healthy.harness.signals, healthy.said()], [[], []]);
  await endedTurn(healthy.adapter, healthy.handle, healthy.harness.clients[0]!, "still-read-only");

  const changes: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
    // What Codex 0.153.4 reports once a request named a sandbox: the sandbox it should have, and no profile.
    ["no profile", { ...readOnlySettings, activePermissionProfile: null }, /^Stopped this agent\. Codex reported no permission profile for this agent's conversation, so nothing says that your Codex sign-in file is kept from its commands\. That is not Read-only access\. It starts again by itself, unless you paused it\.$/],
    ["another profile", { ...readOnlySettings, activePermissionProfile: { id: "owner_profile", extends: ":read-only" } }, /^Stopped this agent\. Codex reported another permission profile than the one LetAgents gave it /],
    ["a sandbox that writes", { ...readOnlySettings, sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/"], networkAccess: true } }, /^Stopped this agent\. Codex reported approval policy "never" and sandbox "workspaceWrite" with network access /],
    ["someone to ask", { ...readOnlySettings, approvalPolicy: "on-request" }, /^Stopped this agent\. Codex reported approval policy "on-request" and sandbox "readOnly" /],
  ];
  for (const [what, settings, line] of changes) {
    const scene = await started();
    scene.changed(settings);
    // A second notice while the first stop runs starts no second stop and says nothing more.
    scene.changed(settings);
    await flush();
    await flush();
    assert.deepEqual(scene.harness.signals, [{ pid: scene.harness.launches[0]!.pid, signal: "SIGTERM" }], what);
    assert.equal(scene.said().length, 1, what);
    assert.match(scene.said()[0]!, line, what);
    await assert.rejects(scene.adapter.runRoomTurn(scene.handle, turnOf("after-the-change"), { checkpointTurnStarted: async () => {} }), /./, what);
    assert.equal(scene.harness.clients[0]!.requests.some((call) => call.method === "turn/start"), false, `${what}: it takes no turn`);
  }

  // No other access level is held to its settings this way.
  for (const level of foundAtOtherLevels()) {
    const other = await started(level);
    other.changed({ ...readOnlySettings, activePermissionProfile: null, sandboxPolicy: { type: "dangerFullAccess" } });
    await flush();
    assert.deepEqual([other.harness.signals, other.said()], [[], []], level.permissionProfileId);
  }
});

test("a launch that has the Read-only policy and names no access level is told to the launch as such, which starts nothing for it; behind a stand-in for the launch that refuses nothing, it names the sandbox as before", async () => {
  // The product's launch refuses this caller: see the launch's own tests. The stand-in launch of this file refuses
  // nothing, so what the adapter does past the launch is seen here.
  const harness = createHarness({ exitOnSignal: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", launchPolicy: structuredClone(CODEX_READ_ONLY_POLICY) }));
  // What the launch is told: the policy is Read-only's, and there is no profile for it. That pair is what it refuses.
  assert.deepEqual([launchAskedFor(harness).sandboxed, launchAskedFor(harness).readOnlySandbox, Object.hasOwn(launchAskedFor(harness), "hideSignInProfile")], [true, true, false]);
  await endedTurn(adapter, handle, harness.clients[0]!, "no-level");
  const [started, turn] = harness.clients[0]!.requests.filter(givesAccess).map((call) => call.params as Record<string, unknown>);
  assert.deepEqual([started!.sandbox, started!.permissions], ["read-only", undefined]);
  assert.deepEqual([turn!.sandboxPolicy, turn!.permissions], [{ type: "readOnly", networkAccess: false }, undefined]);
  // Its reply is still held to the sandbox and the approval policy, as before.
  const widened = createHarness();
  const createRpcClient = widened.dependencies.createRpcClient;
  widened.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; return client; };
  await assert.rejects(new CodexProviderAdapter({ dependencies: widened.dependencies }).spawn(spawnRequest({ deliveryMode: "daemon_inbox", launchPolicy: structuredClone(CODEX_READ_ONLY_POLICY) })),
    /did not confirm Read-only access/);

  // A process found running names no level, so its policy says what it is: this one has Read-only's policy and no profile, and is stopped.
  const finder = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const answer = await finder.attach({ workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection, launchPolicy: structuredClone(CODEX_READ_ONLY_POLICY) }) as { state?: string; notices?: string[] };
  assert.equal(answer.state, "terminal");
  assert.match(answer.notices![0]!, /^Codex reported no permission profile for this agent's conversation, /);

  // A launch that names the Read-only level is told the same policy, and its profile with it. No other level is told that policy.
  const named = createHarness();
  await new CodexProviderAdapter({ dependencies: named.dependencies }).spawn(spawnRequest(READ_ONLY_LAUNCH));
  assert.deepEqual([launchAskedFor(named).readOnlySandbox, launchAskedFor(named).hideSignInProfile], [true, READ_ONLY_PROFILE]);
  for (const level of foundAtOtherLevels()) {
    const other = createHarness();
    await new CodexProviderAdapter({ dependencies: other.dependencies }).spawn(spawnRequest(level));
    assert.equal(Object.hasOwn(launchAskedFor(other), "readOnlySandbox"), false, level.permissionProfileId);
  }
});

test("a Read-only process started before conversations named a permission profile is replaced when it is idle", () => {
  // The daemon compares this number with the one a running process was started under.
  assert.ok(CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION >= 3);
});

test("inspector reads idle Codex account limits without opening Live and fences delayed responses", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let reads = 0;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "account/rateLimits/read") { reads++; return { rateLimits: { primary: { usedPercent: 32, windowDurationMins: 300 } } } as T; }
    return original<T>(method, params);
  };
  client.emit({ method: "thread/tokenUsage/updated", params: { threadId: handle.providerContinuationId,
    tokenUsage: { last: { totalTokens: 31000 }, total: { totalTokens: 930000 }, modelContextWindow: 200000 } } });
  const [a, b] = await Promise.all([adapter.readUsage(handle), adapter.readUsage(handle)]);
  assert.equal(a?.account.windows[0]?.usedPercent, 32);
  assert.equal(b?.context?.usedTokens, 31000);
  assert.equal(reads, 1, "coalesces concurrent inspector reads");
  await adapter.readUsage(handle); assert.equal(reads, 1, "throttles account reads while context remains live");
  (handle as { providerContinuationId: string }).providerContinuationId = "replacement";
  let finish!: (value: unknown) => void;
  client.request = <T>(method: string, params?: unknown): Promise<T> => method === "account/rateLimits/read"
    ? new Promise(resolve => { finish = value => resolve(value as T); }) : original<T>(method, params);
  const pending = adapter.readUsage(handle);
  await flush();
  client.connectionEpoch = "reconnected";
  finish({ rateLimits: { primary: { usedPercent: 99 } } });
  assert.equal(await pending, null, "old connection response is never presented as current");
});

test("bounded Codex context reuse resets on exact compaction, failure and reconnect", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client); let turn = 0; let compact = false; let fail = false;
  const prompts: string[] = [];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      prompts.push((params as { input: Array<{ text: string }> }).input[0]!.text);
      turn++;
      if (fail) throw new Error("ambiguous native dispatch");
      if (compact) client.emit({ method: "item/started", params: { threadId: handle.providerContinuationId,
        turnId: `turn-cache-${turn}`, item: { type: "contextCompaction", id: "compact" } } });
      client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: `turn-cache-${turn}` } });
      return { turn: { id: `turn-cache-${turn}` } } as T;
    }
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{
      id: `turn-cache-${turn}`, status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY" }],
    }] } } as T;
    return originalRequest<T>(method, params);
  };
  const request = { roomId: "focus_95", inboxItemId: "cache-inbox", actionId: "cache-action", activation: {},
    sourceMessage: { id: "msg_20", source: "browser", text: "Thanks" },
    observedContext: Array.from({ length: 8 }, (_, i) => ({ id: `msg_${i + 1}`, source: "agent", text: `Perspective ${i}` })),
  };
  const run = () => adapter.runRoomTurn(handle, request);
  await run(); assert.doesNotMatch(prompts.at(-1)!, /previously_supplied/);
  await run(); assert.match(prompts.at(-1)!, /previously_supplied/);
  client.emit({ method: "thread/compacted", params: { threadId: "unrelated-thread" } });
  await run(); assert.match(prompts.at(-1)!, /previously_supplied/);
  compact = true; await run(); compact = false;
  await run(); assert.doesNotMatch(prompts.at(-1)!, /previously_supplied/, "mid-turn compaction invalidates even a successful pending commit");
  await run(); assert.match(prompts.at(-1)!, /previously_supplied/);
  fail = true; await assert.rejects(run(), /ambiguous native dispatch/); fail = false;
  await run(); assert.doesNotMatch(prompts.at(-1)!, /previously_supplied/);
  await run(); assert.match(prompts.at(-1)!, /previously_supplied/);
  client.disconnect();
  await run(); assert.doesNotMatch(prompts.at(-1)!, /previously_supplied/);
});
