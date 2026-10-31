import "./isolated-home.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION, CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import type { ProviderHandle, ProviderSpawnRequest } from "../main/agents/provider-adapter.js";
import {
  assertProviderHandle,
  createHarness,
  spawnRequest,
  approvalParams,
  mcpToolPermissionParams,
  FULL_ACCESS,
  OWN_SETUP_LAUNCH,
  REFUSAL,
  launchedThenRestarted,
  attachRequests,
  RELOADS,
  STORED_CODEX_OPTIONS,
  SANDBOXED_LAUNCH,
  turnOf,
  scratchCodexHome,
} from "./codex-provider-adapter.fixture.js";
import { OS_BIRTH } from "./platform.js";

test("managed launch receipt freezes the exact generated tool policy and is never invented on attach", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest({ deliveryMode: "daemon_inbox", supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "session_exact", apiUrl: "letagents-local://rooms", roomCursor: null } });
  const route = request.supervisorWorkerSession!.apiUrl!;
  const expected = await adapter.describeManagedLaunchContract({ apiUrl: route });
  assert.match(expected!, /^[a-f0-9]{64}$/);
  const launch = harness.dependencies.launchServer;
  harness.dependencies.launchServer = (...args) => {
    request.supervisorWorkerSession!.apiUrl = "https://changed.example";
    return launch(...args);
  };
  const exact = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await exact.spawn(request) as ProviderHandle & { managedLaunchContract?: string };
  assert.equal(handle.managedLaunchContract, expected);
  assert.ok(harness.launchOptions[0]!.options.configOverrides[0]!.includes(route));
  assert.notEqual(await adapter.describeManagedLaunchContract({ apiUrl: "https://changed.example" }), expected);
  assert.equal(await adapter.describeManagedLaunchContract({ apiUrl: route, devMcpServerEntryPath: "/mutable/source.js" }), null);
  const restored = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection,
  });
  assertProviderHandle(restored);
  assert.equal((restored as ProviderHandle & { managedLaunchContract?: string }).managedLaunchContract, undefined);
});

test("the owner's own Codex setup reaches the app-server launch only for an exact request, and never for a rental", async () => {
  const supervised = { deliveryMode: "daemon_inbox" as const, supervisorEntryId: "supervised_owner",
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS };
  const launchOptions = async (overrides: Partial<ProviderSpawnRequest>) => {
    const harness = createHarness();
    await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({ ...supervised, ...overrides }));
    return harness.launchOptions[0]!.options as Record<string, unknown>;
  };
  const off = await launchOptions({});
  assert.equal(Object.hasOwn(off, "homeHarness"), false, "an ordinary launch is handed exactly what it was before");
  for (const unclear of ["true", 1, false, null]) {
    assert.deepEqual(await launchOptions({ homeHarness: unclear as never }), off, String(unclear));
  }
  assert.deepEqual(await launchOptions({ homeHarness: true }), { ...off, homeHarness: true },
    "the room's own server, its environment and the working folder are the same either way");

  const rental = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: rental.dependencies }).spawn(spawnRequest({
    ...supervised, supervisorEntryId: "supervised_rental_0123", homeHarness: true,
  })), /a rented agent never uses its owner's own setup/);
  assert.equal(rental.launches.length, 0, "nothing starts");

  // An agent that collects its own room messages could not be held back once the setup is turned off, so it never has it.
  for (const deliveryMode of [undefined, "mcp_polling"] as const) {
    const polling = createHarness();
    await assert.rejects(new CodexProviderAdapter({ dependencies: polling.dependencies }).spawn(spawnRequest({
      ...supervised, ...(deliveryMode ? { deliveryMode } : { deliveryMode: undefined }), homeHarness: true,
    })), /an agent that collects its own room messages never uses its owner's own setup/, String(deliveryMode));
    assert.equal(polling.launches.length, 0, "nothing starts");
  }
  // Its environment is cleared of the room agent's coordinates, so the room's server must be the one given its own copy.
  const unsupervised = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: unsupervised.dependencies }).spawn(spawnRequest({ deliveryMode: "daemon_inbox", ...FULL_ACCESS, homeHarness: true })),
    /only as a daemon-supervised room agent/);
  assert.equal(unsupervised.launches.length, 0, "nothing starts");
  // Nor without a named access level: the launch is built from that level and from nothing else the policy holds.
  const unnamed = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: unnamed.dependencies }).spawn(spawnRequest({
    ...supervised, permissionProfileId: undefined, homeHarness: true,
  })), /an agent with its owner's own setup starts only under a named access level/);
  assert.equal(unnamed.launches.length, 0, "nothing starts");
});

test("another MCP server's request for typed input or a sign-in is declined at once; approvals and the room's own server are left alone", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", supervisorEntryId: "supervised_owner",
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, homeHarness: true }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const method = "mcpServer/elicitation/request";
  const activity: string[] = [];
  // The background service keeps an agent's activity from its stream, so that is where each one must be.
  adapter.onStream(handle, (event) => { if (event.method === "mcpServer/elicitation/declined") activity.push(event.summary ?? ""); });
  const form = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser", _meta: null, message: "Which account?",
    requestedSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } }), 51, method);
  const signIn = client.askPermission({ threadId: "thread-1", turnId: "turn-thread-1", serverName: "owner_browser", mode: "url",
    url: "https://example.invalid/sign-in", elicitationId: "sign-in-1", message: "Sign in", _meta: null }, 52, method);
  // A tool approval from the owner's server waits for the owner, like the room's own.
  const ownerToolApproval = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser",
    message: 'Allow the owner_browser MCP server to run tool "owner_write"?' }), 53, method);
  const roomToolApproval = client.askPermission(mcpToolPermissionParams(), 54, method);
  // The room's server never asks for input; an unrecognised request of its own is not answered for it.
  const roomForm = client.askPermission(mcpToolPermissionParams({ _meta: {} }), 55, method);
  const command = client.askPermission(approvalParams(), 56);
  // A tool approval too large to show could never be answered either. From the owner's server it is turned down;
  // from the room's own it is left exactly as it always was.
  const oversized = { codex_approval_kind: "mcp_tool_call", persist: ["session"], tool_description: "Write", tool_params: { text: "x".repeat(30_000) } };
  const ownerOversized = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser", _meta: oversized }), 57, method);
  const roomOversized = client.askPermission(mcpToolPermissionParams({ _meta: oversized }), 58, method);
  assert.deepEqual(client.permissionResponses, [
    { request: form, result: { action: "decline", content: null, _meta: null } },
    { request: signIn, result: { action: "decline", content: null, _meta: null } },
    { request: ownerOversized, result: { action: "decline", content: null, _meta: null } },
  ]);
  assert.deepEqual(client.listPendingRequests(), [ownerToolApproval, roomToolApproval, roomForm, command, roomOversized]);
  // Each one is in the agent's activity, with whose request it was, and nothing else is reported as declined.
  assert.deepEqual(activity, [
    'Declined a request for typed input from your MCP server "owner_browser". LetAgents cannot show it.',
    'Declined a request for a sign-in from your MCP server "owner_browser". LetAgents cannot show it.',
    'Did not allow a tool of your MCP server "owner_browser". Its approval request was too large or malformed to show.',
  ]);
});

test("an agent that was re-attached still declines and reports an owner server's request nobody can answer", async () => {
  const harness = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
    deliveryMode: "daemon_inbox", supervisorEntryId: "supervised_owner", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, homeHarness: true,
  }));
  // A fresh adapter, as after the background service restarts: it is not told about the switch again.
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const client = harness.clients[1]!; client.turnStatus = "inProgress";
  const activity: string[] = [];
  adapter.onStream(attached, (event) => { if (event.method === "mcpServer/elicitation/declined") activity.push(event.summary ?? ""); });
  const form = client.askPermission(mcpToolPermissionParams({ serverName: "owner_browser", _meta: null, message: "Which account?",
    requestedSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } }), 71, "mcpServer/elicitation/request");
  assert.deepEqual(client.permissionResponses, [{ request: form, result: { action: "decline", content: null, _meta: null } }]);
  assert.deepEqual(activity, ['Declined a request for typed input from your MCP server "owner_browser". LetAgents cannot show it.']);
});

test("an agent that never had its owner's setup is re-attached exactly as before, whatever its process looks like, and nothing is read off the process", async () => {
  // What a re-attach asked a running app-server before the owner's setup existed.
  const BEFORE = ["mcpServerStatus/list", "thread/read", "thread/resume", "thread/read"];
  for (const [shape, spawn, harnessOptions] of [
    // Started by an older build: no override that turns the owner's extensions off is on its command line.
    ["no isolation overrides on its command line", OWN_SETUP_LAUNCH, {}],
    ["every isolation override on its command line", { deliveryMode: "daemon_inbox" as const }, {}],
    // Nothing about the process is asked, so a process that cannot be read is no obstacle either.
    ["a process that cannot be read", { deliveryMode: "daemon_inbox" as const }, { processUnreadable: true }],
  ] as const) {
    const { harness, ref, adapter } = await launchedThenRestarted(spawn, false, harnessOptions);
    harness.changeProject(REFUSAL);
    const attached = await adapter.attach(ref);
    assertProviderHandle(attached);
    assert.equal(attached.ownerSetup, false, shape);
    assert.deepEqual(attachRequests(harness), BEFORE, shape);
    assert.deepEqual(harness.commandLineReads, [], `${shape}: the process's command line is never read`);
    assert.deepEqual(harness.liveChecks, [], `${shape}: the project is never inspected`);
    assert.deepEqual(harness.signals, [], `${shape}: nothing is stopped`);
    // Nor later: its conversation is repaired with no check at all.
    await adapter.repairContinuation(attached, {
      workAttemptId: attached.workAttemptId, expectedProviderContinuationId: attached.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: spawnRequest().launchPolicy, forceReplacement: true,
    }, { checkpointReplacement: async () => {} });
    assert.deepEqual(harness.commandLineReads, [], shape);
    assert.deepEqual(harness.liveChecks, [], shape);
    assert.deepEqual(harness.signals, [], shape);
  }
});

test("re-attaching an agent the daemon started with its owner's setup never asks Codex to read the project again, and stops nothing", async () => {
  for (const [name, harnessOptions, projectChanged] of [
    ["the project is as it was", {}, false],
    ["the project changed since the agent started", {}, true],
    ["its command line cannot be read", { processUnreadable: true }, true],
    ["its command line claims it was started isolated", { commandLineClaimsIsolation: true }, true],
  ] as const) {
    const { harness, ref, adapter } = await launchedThenRestarted(OWN_SETUP_LAUNCH, true, harnessOptions);
    if (projectChanged) harness.changeProject(REFUSAL);
    const attached = await adapter.attach(ref);
    assertProviderHandle(attached);
    assert.equal(attached.ownerSetup, true, name);
    // The same re-attach as any agent's, without the one request that lists the MCP servers.
    assert.deepEqual(attachRequests(harness), ["thread/read", "thread/resume", "thread/read"], name);
    assert.deepEqual(attachRequests(harness).filter((method) => RELOADS.includes(method)), [], name);
    assert.deepEqual(harness.signals, [], `${name}: the agent keeps running, mid-turn or not`);
    assert.deepEqual(harness.commandLineReads, [], `${name}: no process is started to look at it`);
    assert.deepEqual(harness.liveChecks, [], name);
    assert.equal(harness.launches[0]!.alive, true, name);
  }
});

test("a process whose record cannot say how it was started is not asked to read its project again, and is otherwise an agent without the setup", async () => {
  for (const spawn of [OWN_SETUP_LAUNCH, { deliveryMode: "daemon_inbox" as const }]) {
    const { harness, ref, adapter } = await launchedThenRestarted(spawn, false, { processUnreadable: true });
    harness.changeProject(REFUSAL);
    const attached = await adapter.attach({ ...ref, ownerSetup: "unknown" });
    assertProviderHandle(attached);
    assert.deepEqual(attachRequests(harness), ["thread/read", "thread/resume", "thread/read"], "the list of MCP servers is left out");
    // Nothing else changes for it: it is not held to be an agent with the setup, and nothing is read or stopped.
    assert.equal(attached.ownerSetup, false);
    await adapter.repairContinuation(attached, {
      workAttemptId: attached.workAttemptId, expectedProviderContinuationId: attached.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: spawnRequest().launchPolicy, forceReplacement: true,
    }, { checkpointReplacement: async () => {} });
    assert.deepEqual([harness.commandLineReads, harness.liveChecks, harness.signals], [[], [], []]);
  }
});

test("repairing a conversation never lets a Codex that has its owner's setup reload a project that changed since it started", async () => {
  const repair = async (spawn: Partial<ProviderSpawnRequest>, change: boolean, harnessOptions: Parameters<typeof createHarness>[0] = {}, reattachedAs?: boolean) => {
    const harness = createHarness({ exitOnSignal: true, processIdentity: OS_BIRTH.first, ...harnessOptions });
    let adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest(spawn);
    let handle = await adapter.spawn(request);
    // A launch says on its handle whether the process has the owner's setup.
    assert.equal(handle.ownerSetup, spawn.homeHarness === true);
    if (reattachedAs !== undefined) {
      // After a restart of the background service the adapter knows only what the daemon's ref tells it.
      adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const attached = await adapter.attach({ workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection, ...(reattachedAs ? { ownerSetup: true as const } : {}) });
      assertProviderHandle(attached);
      handle = attached;
    }
    const client = harness.clients.at(-1)!;
    const before = client.requests.length;
    // What the daemon puts in the agent's activity, and how many stops had been sent when it was said.
    const told: Array<{ summary: string; stopsBefore: number }> = [];
    adapter.onStream(handle, (event) => {
      if (event.method === "ownerSetup/stopped") told.push({ summary: event.summary ?? "", stopsBefore: harness.signals.length });
    });
    if (change) harness.changeProject(REFUSAL);
    const outcome = await adapter.repairContinuation(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
      cwd: request.cwd, launchPolicy: request.launchPolicy, forceReplacement: true,
    }, { checkpointReplacement: async () => {} }).then(() => null, (error: Error) => error);
    return { harness, handle, outcome, told, after: client.requests.slice(before).map((entry) => entry.method) };
  };
  const threadCalls = (methods: string[]) => methods.filter((method) => method === "thread/start" || method === "thread/resume");
  const refused = (result: Awaited<ReturnType<typeof repair>>, reason: RegExp, name: string) => {
    assert.match(result.outcome?.message ?? "", reason, name);
    assert.deepEqual(threadCalls(result.after), [], `${name}: no thread was started or loaded`);
    assert.deepEqual(result.harness.signals.map((signal) => signal.pid), [4100], `${name}: the process is stopped`);
    assert.equal(result.handle.observedState() === "idle" || result.handle.observedState() === "working", false, name);
    // The owner is told why in the agent's activity, once, before the process goes.
    assert.equal(result.told.length, 1, name);
    assert.match(result.told[0]!.summary, /^Stopped this agent\. /, name);
    assert.match(result.told[0]!.summary, reason, name);
    assert.equal(result.told[0]!.stopsBefore, 0, name);
  };

  const changed = await repair(OWN_SETUP_LAUNCH, true);
  refused(changed, /changes your MCP server "owner_browser"/, "the refusal names what the project changed");

  // A command line that cannot be read, as when `ps` does not answer in time: the project is not loaded on a guess.
  const unreadable = await repair(OWN_SETUP_LAUNCH, false, { processUnreadable: true });
  refused(unreadable, /could not read how this agent's Codex was started, so it stopped the agent before Codex could load the project's configuration with your own setup/, "unreadable");
  assert.deepEqual(unreadable.harness.liveChecks, [], "there is nothing to compare the project with");

  // LetAgents started this process with the owner's setup. A command line that says it is isolated is not believed.
  const spoofed = await repair(OWN_SETUP_LAUNCH, false, { commandLineClaimsIsolation: true });
  refused(spoofed, /is not running the way LetAgents started it, so LetAgents stopped the agent/, "a command line that claims isolation");
  assert.deepEqual(spoofed.harness.liveChecks, []);

  const same = await repair(OWN_SETUP_LAUNCH, false);
  assert.equal(same.outcome, null);
  assert.equal(same.after.includes("thread/start"), true);
  assert.deepEqual(same.harness.liveChecks.map((check) => check.cwd), [spawnRequest().cwd], "the project is inspected in the agent's own folder");
  assert.equal(same.harness.liveChecks[0]!.commandLine.includes("--listen"), true, "against what the process was started with");
  assert.deepEqual(same.harness.signals, []);
  assert.deepEqual(same.told, []);

  // A re-attached agent is checked when the daemon's record says it has the setup, and only then.
  refused(await repair(OWN_SETUP_LAUNCH, true, {}, true), /changes your MCP server "owner_browser"/, "re-attached, recorded as started with the setup");
  const recordedWithout = await repair(OWN_SETUP_LAUNCH, true, { processUnreadable: true }, false);
  assert.equal(recordedWithout.outcome, null, "re-attached, never recorded as having the setup: repaired as before");
  assert.deepEqual(recordedWithout.harness.commandLineReads, []);

  const isolated = await repair({ deliveryMode: "daemon_inbox" }, true, { processUnreadable: true });
  assert.equal(isolated.outcome, null, "an agent without its owner's setup is repaired exactly as before");
  assert.deepEqual(isolated.harness.liveChecks, []);
  assert.deepEqual(isolated.harness.commandLineReads, [], "and its process is never read");
  assert.equal(isolated.after.includes("thread/start"), true);
  assert.deepEqual(isolated.told, []);
});

test("with the owner's own setup no stored Codex option reaches a conversation, at a start or a repair, and without it every one still does", async () => {
  const level = spawnRequest().launchPolicy as Record<string, unknown>;
  let agents = 0;
  const started = async (homeHarness: boolean, stored: Record<string, unknown>) => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    // Each start is another agent's first, so each is told what was left out.
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", supervisorEntryId: `supervised_stored_${agents += 1}`, supervisorSocketPath: "/tmp/daemon.sock",
      supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS, launchPolicy: { ...level, ...stored }, ...(homeHarness ? { homeHarness: true } : {}) }));
    const client = harness.clients[0]!;
    const start = client.requests.find((request) => request.method === "thread/start")!.params as Record<string, unknown>;
    // A repair starts a second conversation on the same process, from the policy as it is stored.
    const before = client.requests.length;
    await adapter.repairContinuation(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
      cwd: spawnRequest().cwd, launchPolicy: { ...level, ...stored }, forceReplacement: true,
    }, { checkpointReplacement: async () => {} });
    const repair = client.requests.slice(before).find((request) => request.method === "thread/start")!.params as Record<string, unknown>;
    return { start, repair, notices: handle.launchNotices ?? [] };
  };
  // What a conversation is given when nothing else is stored.
  const on = await started(true, {});
  const off = await started(false, {});
  assert.deepEqual(Object.keys(on.start).sort(), ["approvalPolicy", "approvalsReviewer", "historyMode", "sandbox"]);
  assert.deepEqual([on.start, on.repair, on.notices], [off.start, off.repair, []], "an agent with nothing else stored starts the same either way");
  for (const [option, value, what] of STORED_CODEX_OPTIONS) {
    const name = `${option} (${what})`;
    const withOption = await started(true, { [option]: value });
    assert.deepEqual(withOption.start, on.start, `${name}: not in the conversation the launch starts`);
    assert.deepEqual(withOption.repair, on.repair, `${name}: nor in one a repair starts`);
    assert.deepEqual(withOption.notices, [
      `With your own setup on, this agent starts with its access level's own Codex options only. These saved options were not used: ${JSON.stringify(option)}.`,
    ], name);
    // Without the owner's setup the option is passed on exactly as it always was.
    const passedOn = await started(false, { [option]: value });
    assert.deepEqual(passedOn.start, { ...off.start, [option]: value }, `${name}: unchanged without the owner's setup`);
    assert.deepEqual(passedOn.repair, { ...off.repair, [option]: value }, name);
    assert.deepEqual(passedOn.notices, [], name);
  }
});

test("a Codex agent is told which saved options were left out when they change, not at every start", async () => {
  const level = spawnRequest().launchPolicy as Record<string, unknown>;
  const told = async (agent: string, stored: Record<string, unknown>, own: Record<string, unknown> = OWN_SETUP_LAUNCH) => {
    const harness = createHarness({ exitOnSignal: true });
    const handle = await new CodexProviderAdapter({ dependencies: harness.dependencies })
      .spawn(spawnRequest({ ...own, supervisorEntryId: agent, launchPolicy: { ...level, ...stored } }));
    return handle.launchNotices ?? [];
  };
  const line = (...options: string[]) => [`With your own setup on, this agent starts with its access level's own Codex options only. These saved options were not used: ${options.map((option) => JSON.stringify(option)).join(", ")}.`];
  const secret = { mcp_servers: { evil: { command: "/repo/value-that-is-never-shown" } } };
  assert.deepEqual(await told("supervised_said_once", { config: secret }), line("config"), "its first start says it");
  assert.deepEqual(await told("supervised_said_once", { config: secret }), [], "the same again says nothing");
  assert.deepEqual(await told("supervised_said_once", { config: { other: true } }), [], "another value under the same name is not a change: names are all that is said");
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }), line("config", "personality"), "a change is said");
  assert.deepEqual(await told("supervised_said_once", {}), []);
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }), line("config", "personality"), "and so is the same set coming back");
  // A start without the owner's setup says nothing and is not counted as one that did.
  const { homeHarness: _on, ...without } = OWN_SETUP_LAUNCH;
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }, without), []);
  assert.deepEqual(await told("supervised_said_once", { config: secret, personality: "x" }), []);
  // What one agent was told says nothing about another.
  assert.deepEqual(await told("supervised_said_once_other", { config: secret, personality: "x" }), line("config", "personality"));
});

test("without the owner's setup nothing the room's server asks is declined, whatever its size or shape", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const method = "mcpServer/elicitation/request";
  const activity: string[] = [];
  // The background service keeps an agent's activity from its stream, so that is where each one must be.
  adapter.onStream(handle, (event) => { if (event.method === "mcpServer/elicitation/declined") activity.push(event.summary ?? ""); });
  const pending = [
    client.askPermission(mcpToolPermissionParams(), 61, method),
    client.askPermission(mcpToolPermissionParams({ _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { text: "x".repeat(30_000) } } }), 62, method),
    client.askPermission(mcpToolPermissionParams({ _meta: null, requestedSchema: { type: "object", properties: { a: { type: "string" } } } }), 63, method),
    client.askPermission(mcpToolPermissionParams({ mode: "url", url: "https://example.invalid", _meta: null }), 64, method),
    client.askPermission(approvalParams(), 65),
  ];
  assert.deepEqual(client.permissionResponses, []);
  assert.deepEqual(client.listPendingRequests(), pending);
  assert.deepEqual(activity, []);
});

test("at a sandboxed access level a Codex that does not say its home, or says another one, is stopped at once", async (t) => {
  const given = await scratchCodexHome(t, false);
  const other = await scratchCodexHome(t, false);
  const cases: Array<{ name: string; harness: Parameters<typeof createHarness>[0]; refused: RegExp | null }> = [
    { name: "says nothing", harness: { reportedCodexHome: null, launchCodexHome: given },
      refused: /^Error: Codex did not say which home folder it runs with, so LetAgents cannot tell that your saved command rules stay away from this agent, and stopped it\. Update Codex, then start the agent again\.$/ },
    // The owner's home was the one to use, because it holds no rule: Codex must still say so.
    { name: "says nothing, started with the owner's home", harness: { reportedCodexHome: null }, refused: /^Error: Codex did not say which home folder it runs with/ },
    { name: "says another home", harness: { reportedCodexHome: other, launchCodexHome: given },
      refused: /^Error: Codex did not start with the home folder LetAgents gave it for this access level, so LetAgents stopped it\. Check that nothing sets CODEX_HOME for the codex command \(a wrapper script or a shell alias\), update Codex, then start the agent again\.$/ },
    { name: "says the home it was given", harness: { reportedCodexHome: given, launchCodexHome: given }, refused: null },
  ];
  for (const testCase of cases) {
    const harness = createHarness({ exitOnSignal: true, ...testCase.harness });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    if (testCase.refused) {
      await assert.rejects(adapter.spawn(spawnRequest(SANDBOXED_LAUNCH)), testCase.refused, testCase.name);
      assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"], testCase.name);
      assert.equal(harness.clients[0]!.requests.some((request) => request.method === "thread/start"), false, `${testCase.name}: no conversation was opened`);
    } else {
      await adapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
      assert.deepEqual(harness.signals, [], testCase.name);
    }
  }
  // Full access has no sandbox for a rule to open, so nothing depends on the answer.
  const fullAccess = createHarness({ reportedCodexHome: null });
  await new CodexProviderAdapter({ dependencies: fullAccess.dependencies }).spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  assert.deepEqual(fullAccess.signals, []);
});

test("a sandboxed Codex takes no turn while the home it runs with holds a saved rule, whether LetAgents started it or found it running", async (t) => {
  const home = await scratchCodexHome(t, false);
  const harness = createHarness({ reportedCodexHome: home });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const first = await adapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
  const turnStarts = (client: number) => harness.clients[client]!.requests.filter((request) => request.method === "turn/start").length;
  const run = (runtime: CodexProviderAdapter, handle: ProviderHandle, client: number, name: string) => runtime.runRoomTurn(handle, turnOf(name), {
    checkpointTurnStarted: async (turnId) => { harness.clients[client]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } }); },
  });
  await run(adapter, first, 0, "no-rule");
  assert.equal(turnStarts(0), 1, "a home with no saved rule is as good as the agents' own");

  // The owner saves a rule after the agent started with their home.
  await mkdir(join(home, "rules"));
  await writeFile(join(home, "rules", "default.rules"), "saved\n");
  const REFUSED = /^Error: This agent's Codex runs with a home folder that holds saved command rules, and a command that matches one runs outside its sandbox\. So LetAgents gives it no work\. Pause the agent and resume it: it then starts with a home folder without those rules\.$/;
  await assert.rejects(run(adapter, first, 0, "rule-saved"), REFUSED);
  assert.equal(turnStarts(0), 1, "Codex was sent no turn");

  // A daemon that starts again finds the process running: it is attached, never used as it is.
  const restarted = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const ref = { workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection, launchPolicy: SANDBOXED_LAUNCH.launchPolicy };
  const attached = await restarted.attach(ref);
  assertProviderHandle(attached);
  await assert.rejects(run(restarted, attached, 1, "found-running"), REFUSED);
  assert.equal(turnStarts(1), 0);
  assert.deepEqual(harness.signals, [], "a turn that may be running is never interrupted");

  // One that does not say its home is not used either.
  harness.setReportedCodexHome(null);
  const silent = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach(ref);
  assertProviderHandle(silent);
  await assert.rejects(new Promise((resolve, reject) => { try { resolve((silent as unknown as { requireTurnPolicy(): unknown }).requireTurnPolicy()); } catch (error) { reject(error); } }),
    /^Error: Codex did not say which home folder it runs with, so LetAgents cannot tell that saved command rules stay away from this agent, and gives it no work\. Update Codex, then pause the agent and resume it\.$/);

  // With the rule gone the same process works again, and at Full access a saved rule changes nothing.
  await rm(join(home, "rules"), { recursive: true });
  await run(adapter, first, 0, "rule-removed");
  assert.equal(turnStarts(0), 2);
  const withRule = await scratchCodexHome(t, true);
  const fullAccess = createHarness({ reportedCodexHome: withRule });
  const fullAccessAdapter = new CodexProviderAdapter({ dependencies: fullAccess.dependencies });
  const unsandboxed = await fullAccessAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  await fullAccessAdapter.runRoomTurn(unsandboxed, turnOf("full-access"), {
    checkpointTurnStarted: async (turnId) => { fullAccess.clients[0]!.emit({ method: "turn/completed", params: { threadId: unsandboxed.providerContinuationId, turnId } }); },
  });
});

test("before a sandboxed Codex starts or loads a conversation again it is asked about command rules, and it is stopped when one would be read", async (t) => {
  const home = await scratchCodexHome(t, false);
  const repair = (adapter: CodexProviderAdapter, handle: ProviderHandle, launchPolicy: unknown) => adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    cwd: spawnRequest().cwd, launchPolicy, forceReplacement: true,
  }, { checkpointReplacement: async () => {} });

  // Nothing would be read: the repair goes on, and Codex was asked with the home it runs with and the agent's folder.
  const clean = createHarness({ exitOnSignal: true, reportedCodexHome: home });
  const cleanAdapter = new CodexProviderAdapter({ dependencies: clean.dependencies });
  const repaired = await cleanAdapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
  assert.equal((await repair(cleanAdapter, repaired, SANDBOXED_LAUNCH.launchPolicy)).outcome, "replaced");
  assert.deepEqual(clean.ruleLoadChecks, [{ cwd: spawnRequest().cwd, codexHome: home }]);
  assert.deepEqual(clean.signals, []);

  // The project gained a rules folder since the launch: no conversation is started, and the agent is stopped and says why.
  const REFUSAL = "Codex also reads command rules from /etc/codex/rules, a folder of this computer's own Codex settings.";
  const harness = createHarness({ exitOnSignal: true, reportedCodexHome: home });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest(SANDBOXED_LAUNCH));
  const said: string[] = [];
  adapter.onStream(handle, (event) => { if (event.method === "sandboxRules/stopped") said.push(event.summary ?? ""); });
  const before = harness.clients[0]!.requests.length;
  harness.refuseRuleLoad(REFUSAL);
  await assert.rejects(repair(adapter, handle, SANDBOXED_LAUNCH.launchPolicy), (error: Error) => error.message === REFUSAL);
  assert.deepEqual(harness.clients[0]!.requests.slice(before).map((request) => request.method).filter((method) => /^thread\/(start|resume)$/.test(method)), []);
  assert.deepEqual(said, [`Stopped this agent. ${REFUSAL}`]);
  assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"]);

  // At Full access nothing is asked: there is no sandbox for a rule to open.
  const fullAccess = createHarness({ reportedCodexHome: home });
  const fullAccessAdapter = new CodexProviderAdapter({ dependencies: fullAccess.dependencies });
  const unsandboxed = await fullAccessAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  fullAccess.refuseRuleLoad(REFUSAL);
  assert.equal((await repair(fullAccessAdapter, unsandboxed, spawnRequest().launchPolicy)).outcome, "replaced");
  assert.deepEqual(fullAccess.ruleLoadChecks, []);
});

test("the managed launch contract is version 2 or later, so a Codex started before agents had a home without saved rules is replaced", () => {
  assert.ok(CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION >= 2);
});

test("a sandboxed Codex takes no turn and loads no conversation in a project that has command rules of its own, at launch, when found running, and at every turn", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "letagents-codex-adapter-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const top = await realpath(project);
  const cwd = join(top, "packages", "app");
  await mkdir(cwd, { recursive: true });
  // A folder Codex takes as the top of a repository: its .git holds HEAD. An empty .git folder is not one.
  await mkdir(join(top, ".git"));
  await writeFile(join(top, ".git", "HEAD"), "ref: refs/heads/main\n");
  const home = await scratchCodexHome(t, false);
  // The rules are at the top of the repository, two folders above the one the agent works in.
  const addRules = async () => { await mkdir(join(top, ".codex", "rules"), { recursive: true }); await writeFile(join(top, ".codex", "rules", "allow.rules"), "saved\n"); };
  const REFUSED = "Codex reads command rules from .codex/rules in this agent's work folder once it trusts the project, and that folder is not empty (allow.rules). "
    + "LetAgents does not read the files in it. If one of them allows a command, a sandboxed Codex agent runs that command with no sandbox and no approval. "
    + "So LetAgents does not start Codex here, or give it work, at this access level. "
    + "Remove or rename .codex/rules in the agent's work folder, which can differ from your own copy of the project, or give this agent Full access if you accept that.";
  const refused = (error: Error) => { assert.equal(error.message, REFUSED); return true; };
  const run = (harness: ReturnType<typeof createHarness>, adapter: CodexProviderAdapter, handle: ProviderHandle, client: number, name: string) => adapter.runRoomTurn(handle, turnOf(name), {
    checkpointTurnStarted: async (turnId) => { harness.clients[client]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } }); },
  });
  const turnStarts = (harness: ReturnType<typeof createHarness>, client: number) => harness.clients[client]!.requests.filter((request) => request.method === "turn/start").length;
  const repair = (adapter: CodexProviderAdapter, handle: ProviderHandle, launchPolicy: unknown) => adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!, cwd, launchPolicy, forceReplacement: true,
  }, { checkpointReplacement: async () => {} });

  // A client that says its home, as the real one does, and a stand-in that does not: the folder is looked in for both.
  for (const reportedCodexHome of [home, undefined]) {
    const harness = createHarness({ exitOnSignal: true, ...(reportedCodexHome ? { reportedCodexHome } : {}) });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ ...SANDBOXED_LAUNCH, cwd }));
    // An empty rules folder holds no rule.
    await mkdir(join(top, ".codex", "rules"), { recursive: true });
    await run(harness, adapter, handle, 0, "before");
    assert.equal(turnStarts(harness, 0), 1);

    // The folder gains an entry between two turns, for example through the owner's pull.
    await addRules();
    await assert.rejects(run(harness, adapter, handle, 0, "turn"), refused);
    assert.equal(turnStarts(harness, 0), 1, "Codex was sent no turn");
    assert.equal(harness.signals.length, 0, "a turn is refused; nothing that runs is stopped");

    // A daemon that starts again finds the process running, and reads the folder from the conversation.
    const restarted = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await restarted.attach({ workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
      providerConnection: handle.providerConnection, launchPolicy: SANDBOXED_LAUNCH.launchPolicy });
    assertProviderHandle(attached);
    await assert.rejects(run(harness, restarted, attached, 1, "found-running"), refused);
    assert.equal(turnStarts(harness, 1), 0);

    // No conversation is started or loaded either: the agent is stopped before Codex could read the rules.
    const before = harness.clients[0]!.requests.length;
    await assert.rejects(repair(adapter, handle, SANDBOXED_LAUNCH.launchPolicy), refused);
    assert.deepEqual(harness.clients[0]!.requests.slice(before).map((request) => request.method).filter((method) => /^thread\/(start|resume)$/.test(method)), []);
    assert.deepEqual(harness.ruleLoadChecks, [], "Codex is not asked whether it trusts the project");
    assert.deepEqual(harness.signals.map((signal) => signal.signal), ["SIGTERM"]);
    await rm(join(top, ".codex"), { recursive: true });
  }

  // At Full access a project's rules change nothing: there is no sandbox for them to open.
  await addRules();
  const fullAccess = createHarness({ reportedCodexHome: home });
  const fullAccessAdapter = new CodexProviderAdapter({ dependencies: fullAccess.dependencies });
  const unsandboxed = await fullAccessAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd }));
  await run(fullAccess, fullAccessAdapter, unsandboxed, 0, "full-access");
  assert.equal((await repair(fullAccessAdapter, unsandboxed, spawnRequest().launchPolicy)).outcome, "replaced");
  assert.deepEqual(fullAccess.signals, []);
});
