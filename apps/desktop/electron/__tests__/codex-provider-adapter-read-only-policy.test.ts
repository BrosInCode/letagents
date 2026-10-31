import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CodexProviderAdapter, CODEX_READ_ONLY_CONFIG_OVERRIDES, CODEX_READ_ONLY_ROOM_TOOLS } from "../main/agents/codex-provider-adapter.js";
import { codexReadOnlyProfileId } from "../main/agents/codex-agent-home.js";
import type { ProviderHandle, ProviderSpawnRequest } from "../main/agents/provider-adapter.js";
import {
  assertProviderHandle,
  FakeRpc,
  createHarness,
  spawnRequest,
  requestByMethod,
  flush,
  CODEX_READ_ONLY_POLICY,
  READ_ONLY_PROFILE,
  READ_ONLY_REPLY,
  NOT_READ_ONLY_REPLIES,
  STILL_READ_ONLY_REPLIES,
  foundAsReadOnly,
  foundAtOtherLevels,
  foundRunning,
  assertStoppedNotReadOnly,
  READ_ONLY_ROOM_TOOL_DECISIONS,
} from "./codex-provider-adapter.fixture.js";

test("Codex ask-before-write remains read-only at turn dispatch after reattachment", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const launchPolicy = {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
  const first = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox",
    permissionProfileId: "ask_before_write",
    configurationRevision: 1,
    launchPolicy,
  }));

  const params = requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>;
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.sandbox, "read-only");
  assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);

  const attachedAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await attachedAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection, launchPolicy });
  assertProviderHandle(attached);
  // Caller mutation and permissive user defaults cannot widen a captured launch contract.
  launchPolicy.sandboxPolicy.type = "dangerFullAccess";
  launchPolicy.approvalPolicy = "never";
  for (const [runtime, handle, client] of [[adapter, first, harness.clients[0]!], [attachedAdapter, attached, harness.clients[1]!]] as const) {
    await runtime.runRoomTurn(handle, { inboxItemId: "approval-retest", actionId: "approval-retest", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    const turn = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.equal(turn.approvalPolicy, "on-request");
    assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(Object.hasOwn(turn, "sandbox"), false, "turn/start uses its native sandboxPolicy shape");
  }

  const unknownAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const unknown = await unknownAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(unknown);
  let dispatched = false;
  await assert.rejects(unknownAdapter.runRoomTurn(unknown, {
    inboxItemId: "unknown-policy", actionId: "unknown-policy", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => { dispatched = true; } }), /exact applied permission policy/);
  assert.equal(dispatched, false, "an unverified attach remains observable but cannot start work");
  assert.equal(harness.clients[2]!.requests.some(request => request.method === "turn/start"), false);
  const verified = await unknownAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
    launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
  assert.equal(verified, unknown, "verified configuration binds to the already observed exact native process");
  await unknownAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
    launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } });
  await unknownAdapter.controlTurn(unknown, "Continue after permission recovery.");
  const recoveredTurn = requestByMethod(harness.clients[2]!, "turn/start").params as Record<string, unknown>;
  assert.equal(recoveredTurn.approvalPolicy, "on-request");
  assert.deepEqual(recoveredTurn.sandboxPolicy, { type: "readOnly", networkAccess: false },
    "the first verified contract remains immutable across subsequent attaches");
});

test("Codex Read-only names its permission profile and nobody to ask on every thread and turn, and never a sandbox", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const launchPolicy = structuredClone(CODEX_READ_ONLY_POLICY) as { approvalPolicy: string; sandboxPolicy: { type: string; networkAccess: boolean } };
  const request = spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId: "read_only", configurationRevision: 1, launchPolicy });
  const first = await adapter.spawn(request);

  // A new thread: the profile, the approval policy, and the host as the reviewer of record. Codex refuses a sandbox beside a profile.
  const started = requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>;
  assert.equal(started.approvalPolicy, "never");
  assert.equal(started.permissions, READ_ONLY_PROFILE);
  assert.equal(started.approvalsReviewer, "user");
  assert.equal(Object.hasOwn(started, "sandbox") || Object.hasOwn(started, "sandboxPolicy"), false, "thread/start names no sandbox");

  const attachedAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await attachedAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection, launchPolicy });
  assertProviderHandle(attached);
  // A later change by the caller cannot widen what the launch captured.
  launchPolicy.sandboxPolicy.type = "dangerFullAccess";
  launchPolicy.sandboxPolicy.networkAccess = true;
  launchPolicy.approvalPolicy = "on-request";
  for (const [runtime, handle, client] of [[adapter, first, harness.clients[0]!], [attachedAdapter, attached, harness.clients[1]!]] as const) {
    await runtime.runRoomTurn(handle, { inboxItemId: "read-only-turn", actionId: "read-only-turn", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    // Every turn restates the whole policy, with the profile again: a turn that named the sandbox would take the profile off the conversation.
    const turn = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.equal(turn.approvalPolicy, "never");
    assert.equal(turn.permissions, READ_ONLY_PROFILE);
    assert.equal(turn.approvalsReviewer, "user");
    assert.equal(Object.hasOwn(turn, "sandbox") || Object.hasOwn(turn, "sandboxPolicy"), false, "turn/start names no sandbox");
  }

  // A thread resumed after its process ended is given the same policy again.
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId, providerContinuationId: first.providerContinuationId!,
  }, { ...request, launchPolicy: structuredClone(CODEX_READ_ONLY_POLICY) });
  const resumed = requestByMethod(harness.clients.at(-1)!, "thread/resume").params as Record<string, unknown>;
  assert.equal(resumed.threadId, first.providerContinuationId);
  assert.equal(resumed.approvalPolicy, "never");
  assert.equal(resumed.permissions, READ_ONLY_PROFILE);
  assert.equal(resumed.approvalsReviewer, "user");
  assert.equal(Object.hasOwn(resumed, "sandbox") || Object.hasOwn(resumed, "sandboxPolicy"), false);
});

test("Codex Read-only starts nothing under another level's policy, or with a reviewer other than the host", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  for (const [launchPolicy, reason] of [
    [{ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }, /authority at 'sandboxPolicy'/],
    [{ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }, /authority at 'approvalPolicy'/],
    [{ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: true } }, /authority at 'sandboxPolicy'/],
    [{ ...CODEX_READ_ONLY_POLICY, approvalsReviewer: "auto_review" }, /authority at 'approvalsReviewer'/],
    [{}, /authority at 'approvalPolicy'/],
  ] as const) {
    await assert.rejects(adapter.spawn(spawnRequest({
      deliveryMode: "daemon_inbox", permissionProfileId: "read_only", configurationRevision: 1, launchPolicy,
    })), reason, JSON.stringify(launchPolicy));
  }
  assert.equal(harness.launches.length, 0, "no app-server is started for a refused launch");

  // The owner's own Codex settings name a reviewer and the app-server keeps it: the launch stops before any turn.
  const owned = createHarness({ reviewerFromOwnSettings: "auto_review" });
  await assert.rejects(new CodexProviderAdapter({ dependencies: owned.dependencies }).spawn(spawnRequest({
    deliveryMode: "daemon_inbox", permissionProfileId: "read_only", configurationRevision: 1, launchPolicy: CODEX_READ_ONLY_POLICY,
  })), /would review approvals itself instead of asking you/);
  assert.equal(owned.clients[0]!.requests.some(request => request.method === "turn/start"), false);
});

test("Codex Read-only starts no turn unless the new or resumed thread reports the read-only sandbox and nobody to ask", { timeout: 30_000 }, async () => {
  const request = () => spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId: "read_only", configurationRevision: 1,
    launchPolicy: structuredClone(CODEX_READ_ONLY_POLICY) });
  for (const [what, misreport] of NOT_READ_ONLY_REPLIES) {
    // A new thread.
    const fresh = createHarness();
    const createRpcClient = fresh.dependencies.createRpcClient;
    fresh.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; misreport(client); return client; };
    await assert.rejects(new CodexProviderAdapter({ dependencies: fresh.dependencies }).spawn(request()), /did not confirm Read-only access/, `thread/start: ${what}`);
    assert.equal(requestByMethod(fresh.clients[0]!, "thread/start").method, "thread/start", "the thread was asked for, and its reply was refused");
    assert.equal(fresh.clients[0]!.requests.some((call) => call.method === "turn/start"), false, `thread/start: ${what}`);
    assert.deepEqual(fresh.signals.map((signal) => signal.pid), [fresh.launches[0]!.pid], `the app-server started for it is stopped: ${what}`);

    // A thread resumed in a new process, after the first one ran as Read-only and ended.
    const resumed = createHarness();
    const first = await new CodexProviderAdapter({ dependencies: resumed.dependencies }).spawn(request());
    resumed.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
    await flush();
    const resumeRpcClient = resumed.dependencies.createRpcClient;
    resumed.dependencies.createRpcClient = (...args) => { const client = resumeRpcClient(...args) as FakeRpc; misreport(client); return client; };
    await assert.rejects(new CodexProviderAdapter({ dependencies: resumed.dependencies }).resume({
      workAttemptId: request().workAttemptId, providerContinuationId: first.providerContinuationId!,
    }, request()), /did not confirm Read-only access/, `thread/resume: ${what}`);
    assert.equal(requestByMethod(resumed.clients[1]!, "thread/resume").method, "thread/resume");
    assert.equal(resumed.clients[1]!.requests.some((call) => call.method === "turn/start"), false, `thread/resume: ${what}`);
    assert.deepEqual(resumed.signals.map((signal) => signal.pid), [resumed.launches[1]!.pid], `the app-server started for the resume is stopped: ${what}`);

    // A conversation repaired inside a running process: the same thread again (thread/resume) or a new one (thread/start).
    for (const forceReplacement of [false, true]) {
      const repaired = createHarness();
      const adapter = new CodexProviderAdapter({ dependencies: repaired.dependencies });
      const handle = await adapter.spawn(request());
      misreport(repaired.clients[0]!);
      let checkpointed = false;
      await assert.rejects(adapter.repairContinuation!(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
        forceReplacement, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
      }, { checkpointReplacement: async () => { checkpointed = true; } }), /did not confirm Read-only access/, `repair ${forceReplacement}: ${what}`);
      assert.equal(checkpointed, false, "a refused thread never becomes the agent's conversation");
      assert.equal(repaired.clients[0]!.requests.some((call) => call.method === "turn/start"), false, `repair ${forceReplacement}: ${what}`);
    }
  }
});

test("only Read-only is held to the reported sandbox and approval policy: every other access level starts as it did", { timeout: 30_000 }, async () => {
  for (const [permissionProfileId, launchPolicy] of [
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }],
  ] as const) {
    for (const [what, misreport] of NOT_READ_ONLY_REPLIES) {
      const harness = createHarness();
      const createRpcClient = harness.dependencies.createRpcClient;
      harness.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; misreport(client); return client; };
      const handle = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
        deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy }));
      assert.equal(handle.observedState(), "idle", `${permissionProfileId}: ${what}`);
    }
  }
});

test("a newer Codex that adds parts to its read-only reply does not lock Read-only out, and a part that widens the sandbox still refuses", { timeout: 30_000 }, async () => {
  const request = () => spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId: "read_only", configurationRevision: 1,
    launchPolicy: structuredClone(CODEX_READ_ONLY_POLICY) });
  const turnOfName = (name: string) => ({ inboxItemId: name, actionId: name, sourceMessage: {}, activation: {} });
  for (const [what, sandbox] of STILL_READ_ONLY_REPLIES) {
    const harness = createHarness();
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; client.sandboxFromOwnSettings = sandbox; return client; };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    // The agent starts, takes a turn, and its conversation can be repaired and resumed: no step says "Update Codex".
    const handle = await adapter.spawn(request());
    assert.equal(handle.observedState(), "idle", what);
    assert.deepEqual(harness.signals, [], what);
    await adapter.runRoomTurn(handle, turnOfName("harmless"), {
      checkpointTurnStarted: async (turnId) => { harness.clients[0]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } }); },
    });
    assert.equal(harness.clients[0]!.requests.filter((call) => call.method === "turn/start").length, 1, what);
    assert.equal((await adapter.repairContinuation!(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
      forceReplacement: true, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
    }, { checkpointReplacement: async () => {} })).outcome, "replaced", what);
    harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
    await flush();
    const resumed = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume(
      { workAttemptId: request().workAttemptId, providerContinuationId: handle.providerContinuationId! }, request());
    assert.equal(resumed.observedState(), "idle", what);
  }
  // The same parts with a value that grants something are refused, each for itself: see NOT_READ_ONLY_REPLIES,
  // which the test above runs at a start, a resume and a repair. Here: one of each kind refuses a start.
  for (const sandbox of [
    { ...READ_ONLY_REPLY, writableRoots: ["/tmp"] }, { ...READ_ONLY_REPLY, allowedDomains: ["example.invalid"] },
    { ...READ_ONLY_REPLY, networkProxy: { port: 8080 } }, { ...READ_ONLY_REPLY, excludeSlashTmp: true }, { ...READ_ONLY_REPLY, escalation: { allowed: true } },
  ]) {
    const harness = createHarness();
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (...args) => { const client = createRpcClient(...args) as FakeRpc; client.sandboxFromOwnSettings = sandbox; return client; };
    await assert.rejects(new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request()), /did not confirm Read-only access/, JSON.stringify(sandbox));
    assert.equal(harness.clients[0]!.requests.some((call) => call.method === "turn/start"), false);
  }
});

test("Codex Read-only starts with web search off, at launch and for every conversation, whatever a stored policy holds, and no other level changes", { timeout: 30_000 }, async () => {
  assert.deepEqual([...CODEX_READ_ONLY_CONFIG_OVERRIDES], ['web_search="disabled"']);
  const sent = (client: FakeRpc, method: string) => client.requests.filter((entry) => entry.method === method).map((entry) => entry.params as Record<string, unknown>);
  // A stored policy that tries to turn web search on for the conversation, in the new key and in the old one.
  const stored = { config: { web_search: "live", tools: { web_search: true }, model_provider: "elsewhere" } };
  const readOnly = (overrides: Partial<ProviderSpawnRequest> = {}) => spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId: "read_only", configurationRevision: 1,
    launchPolicy: { ...structuredClone(CODEX_READ_ONLY_POLICY), ...structuredClone(stored) }, ...overrides });

  // The launch: Codex is started with web search off, after every other override, so the owner's linked config cannot say otherwise.
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(readOnly());
  assert.deepEqual(harness.launchOptions[0]!.options.configOverrides.slice(-1), ['web_search="disabled"']);
  // The conversation: its config is the Read-only one whole. Nothing the stored policy holds is in it.
  assert.deepEqual(sent(harness.clients[0]!, "thread/start")[0]!.config, { web_search: "disabled" });

  // A repair on the same process: the probes of the conversation, and the one that replaces it.
  harness.clients[0]!.markThreadMissing(handle.providerContinuationId!);
  await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    cwd: spawnRequest().cwd, launchPolicy: readOnly().launchPolicy, model: "gpt-5.6-sol", reasoningEffort: "high",
  }, { checkpointReplacement: async () => {} });
  const probes = sent(harness.clients[0]!, "thread/resume");
  assert.equal(probes.length > 0, true);
  for (const probe of probes) assert.deepEqual(probe.config, { model_reasoning_effort: "high", web_search: "disabled" });
  assert.deepEqual(sent(harness.clients[0]!, "thread/start")[1]!.config, { model_reasoning_effort: "high", web_search: "disabled" });

  // A resume in another process: the launch override again, and the conversation's config again.
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume(
    { workAttemptId: readOnly().workAttemptId, providerContinuationId: handle.providerContinuationId! }, readOnly());
  assert.deepEqual(harness.launchOptions[1]!.options.configOverrides.slice(-1), ['web_search="disabled"']);
  assert.deepEqual(sent(harness.clients[1]!, "thread/resume")[0]!.config, { web_search: "disabled" });

  // A process found running, whose level is not named to the adapter: a conversation it starts in a repair gets the config too.
  const found = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: found.dependencies }).spawn(readOnly());
  const restarted = new CodexProviderAdapter({ dependencies: found.dependencies });
  const attached = await restarted.attach({ workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection, launchPolicy: CODEX_READ_ONLY_POLICY });
  assertProviderHandle(attached);
  await restarted.repairContinuation!(attached, {
    workAttemptId: attached.workAttemptId, expectedProviderContinuationId: attached.providerContinuationId!,
    forceReplacement: true, cwd: spawnRequest().cwd, launchPolicy: readOnly().launchPolicy, model: null, reasoningEffort: null,
  }, { checkpointReplacement: async () => {} });
  assert.deepEqual(sent(found.clients[1]!, "thread/start")[0]!.config, { web_search: "disabled" });

  // The polling kind of launch is not started at Read-only at all: see the test of the room tools.
  const polling = createHarness();
  await assert.rejects(new CodexProviderAdapter({ dependencies: polling.dependencies }).spawn(readOnly({
    pollingContract: "custodial_polling_v1", deliveryMode: "mcp_polling", supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact", supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_41", apiUrl: "https://letagents.chat" } })),
    /^Error: Read-only access is for a Codex agent that LetAgents delivers room messages to\./);
  assert.deepEqual(polling.launchOptions, [], "no Codex was started");

  // No other access level changes: no override, and a stored config reaches the conversation as it always did.
  for (const [permissionProfileId, launchPolicy] of [
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }],
    // A launch that names no level, with Read-only's own policy: it is not the level, and it is sent what it was before.
    [undefined, CODEX_READ_ONLY_POLICY],
  ] as const) {
    for (const withStoredConfig of [false, true]) {
      const other = createHarness();
      await new CodexProviderAdapter({ dependencies: other.dependencies }).spawn(spawnRequest({ deliveryMode: "daemon_inbox",
        ...(permissionProfileId ? { permissionProfileId, configurationRevision: 1 } : {}),
        launchPolicy: { ...structuredClone(launchPolicy), ...(withStoredConfig ? structuredClone(stored) : {}) } }));
      assert.equal(other.launchOptions[0]!.options.configOverrides.some((override) => /web_search/.test(override)), false, String(permissionProfileId));
      const started = sent(other.clients[0]!, "thread/start")[0]!;
      if (withStoredConfig) assert.deepEqual(started.config, stored.config, String(permissionProfileId));
      else assert.equal(Object.hasOwn(started, "config"), false, String(permissionProfileId));
    }
  }
});

test("a healthy Read-only Codex found running is attached as before, and so is every other level whatever its conversation reports", { timeout: 30_000 }, async () => {
  // The subscription names no policy, and the reply names the one the conversation has: a Read-only one is attached and takes a turn.
  const healthy = await foundRunning(foundAsReadOnly(), null);
  const attached = await healthy.attach();
  assertProviderHandle(attached);
  const subscribed = healthy.harness.clients[1]!.requests.find((call) => call.method === "thread/resume")!.params as Record<string, unknown>;
  assert.deepEqual(Object.keys(subscribed), ["threadId"], "the subscription asks for nothing but the conversation");
  assert.equal(healthy.harness.clients[1]!.requests.filter((call) => call.method === "thread/read").length, 2, "the snapshot is read again after the subscription, as before");
  await healthy.restarted.runRoomTurn(attached, { inboxItemId: "found", actionId: "found", sourceMessage: {}, activation: {} }, {
    checkpointTurnStarted: async (turnId) => { healthy.harness.clients[1]!.emit({ method: "turn/completed", params: { threadId: attached.providerContinuationId, turnId } }); },
  });
  assert.equal(healthy.harness.clients[1]!.requests.filter((call) => call.method === "turn/start").length, 1);
  assert.deepEqual(healthy.harness.signals, [], "a healthy process is not signalled");
  assert.equal(healthy.harness.launches.length, 1);
  assert.equal(await healthy.attach(), attached, "and it stays the one runtime of its agent");
  // A newer Codex's harmless extra part does not stop it either.
  const newer = await foundRunning(foundAsReadOnly(), (client) => { client.sandboxFromOwnSettings = { ...READ_ONLY_REPLY, readableRoots: ["/"] }; });
  assertProviderHandle(await newer.attach());
  assert.deepEqual(newer.harness.signals, []);

  // Every other level is attached whatever the reply says, as before, and so is a process whose policy is not known.
  for (const level of foundAtOtherLevels()) {
    for (const [what, misreport] of NOT_READ_ONLY_REPLIES) {
      const other = await foundRunning(level, misreport);
      assertProviderHandle(await other.attach());
      assert.deepEqual(other.harness.signals, [], `${level.permissionProfileId}: ${what}`);
    }
  }
  const unknown = await foundRunning(foundAsReadOnly(), (client) => { client.omitsThreadPolicy = true; }, false);
  assertProviderHandle(await unknown.attach());
  assert.deepEqual(unknown.harness.signals, []);
});

test("a Read-only Codex found running with a conversation that reports another policy is stopped, its owner is told, and the next launch is a fresh Read-only start", { timeout: 30_000 }, async () => {
  const lines = new Map<string, string>();
  for (const [what, misreport] of NOT_READ_ONLY_REPLIES) {
    const scene = await foundRunning(foundAsReadOnly(), misreport);
    // The attach does not fail and does not leave the process running: it answers with the proof that the process is gone.
    lines.set(what, assertStoppedNotReadOnly(await scene.attach(), scene, what));
    assert.equal(scene.harness.clients[1]!.requests.filter((call) => call.method === "thread/read").length, 1, `${what}: a runtime about to be stopped is asked nothing more`);

    // Nothing of it is kept: the daemon's next launch is a new process, and its conversation is asked for with the Read-only policy.
    scene.tellTheTruth();
    const next = await scene.restarted.resume({ workAttemptId: scene.ref.workAttemptId, providerContinuationId: scene.ref.providerContinuationId }, spawnRequest(scene.level));
    assert.equal(scene.harness.launches.length, 2, what);
    assert.notEqual(next.pid, scene.harness.launches[0]!.pid, what);
    assert.deepEqual(scene.harness.launchOptions[1]!.options.configOverrides.slice(-1), ['web_search="disabled"'], what);
    const resumed = requestByMethod(scene.harness.clients.at(-1)!, "thread/resume").params as Record<string, unknown>;
    assert.deepEqual({ approvalPolicy: resumed.approvalPolicy, permissions: resumed.permissions, sandbox: resumed.sandbox, approvalsReviewer: resumed.approvalsReviewer, config: resumed.config },
      { approvalPolicy: "never", permissions: codexReadOnlyProfileId(scene.ref.workAttemptId), sandbox: undefined, approvalsReviewer: "user", config: { web_search: "disabled" } }, what);
    assert.equal(next.observedState(), "idle", what);
    assert.deepEqual(scene.harness.signals.map((signal) => signal.pid), [scene.harness.launches[0]!.pid], `${what}: the new process is not signalled`);
  }
  // The line says what Codex reported, in Codex's own names.
  const said = (what: string) => lines.get(what)!.replace(/ for this agent's conversation\..*$/, "");
  assert.equal(said("a full-access sandbox"), 'Codex reported approval policy "never" and sandbox "dangerFullAccess"');
  assert.equal(said("a sandbox that allows writes"), 'Codex reported approval policy "never" and sandbox "workspaceWrite"');
  assert.equal(said("a read-only sandbox with network access"), 'Codex reported approval policy "never" and sandbox "readOnly" with network access');
  assert.equal(said("a read-only sandbox that does not say its network access"), 'Codex reported approval policy "never" and sandbox "readOnly" with no word on its network access');
  assert.equal(said("a read-only sandbox with a writable folder"), 'Codex reported approval policy "never" and sandbox "readOnly" with a part that widens it');
  assert.equal(said("an approval policy that asks"), 'Codex reported approval policy "on-request" and sandbox "readOnly"');
  assert.equal(said("no word on the sandbox or the approval policy"), "Codex reported approval policy none and sandbox none");

  // A process that cannot be proved gone is the one case that still fails the attach: a second writer must not start.
  const stuck = await foundRunning(foundAsReadOnly(), (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; });
  const getProcessIdentity = stuck.harness.dependencies.getProcessIdentity;
  // Its birth can be read until the conversation has answered, and not after.
  stuck.harness.dependencies.getProcessIdentity = (pid) =>
    stuck.harness.clients[1]?.requests.some((call) => call.method === "thread/resume") ? undefined : getProcessIdentity(pid);
  await assert.rejects(new CodexProviderAdapter({ dependencies: stuck.harness.dependencies }).attach({ ...stuck.ref, launchPolicy: stuck.level.launchPolicy }),
    /attach is ambiguous; refusing to launch a second writer: Codex reported approval policy "never" and sandbox "dangerFullAccess" for this agent's conversation\. That is not Read-only access, and LetAgents could not stop the agent: /);
  assert.deepEqual(stuck.harness.signals, [], "a process whose birth cannot be verified is not signalled");
  assert.equal(stuck.harness.launches[0]!.alive, true);

  // So is a stop that ends on a lost connection and not on the process's own exit: that is no proof that it is gone.
  const lost = await foundRunning(foundAsReadOnly(), (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; });
  lost.harness.dependencies.signalProcess = (pid, signal) => {
    lost.harness.signals.push({ pid, signal });
    lost.harness.launches[0]!.resolveExit({ type: "error", error: new Error("connection lost") });
    lost.harness.launches[0]!.alive = true;
  };
  await assert.rejects(new CodexProviderAdapter({ dependencies: lost.harness.dependencies }).attach({ ...lost.ref, launchPolicy: lost.level.launchPolicy }),
    /attach is ambiguous; refusing to launch a second writer: Codex reported .* That is not Read-only access, and LetAgents could not stop the agent: its process could not be proved gone$/);
  assert.equal(lost.harness.launches.length, 1);
});

test("a Read-only Codex found before the daemon supplied its policy is held to it when the policy is bound", { timeout: 30_000 }, async () => {
  const sent = (client: FakeRpc, method: string) => client.requests.filter((entry) => entry.method === method).map((entry) => entry.params as Record<string, unknown>);
  // A stored policy that tries to turn web search on for the conversation.
  const stored = { config: { web_search: "live" } };

  // Found without a policy: it is attached, with nothing to hold its conversation to yet. It takes no turn.
  const healthy = await foundRunning(foundAsReadOnly(), null, false);
  const found = await healthy.attach();
  assertProviderHandle(found);
  await assert.rejects(healthy.restarted.runRoomTurn(found, { inboxItemId: "early", actionId: "early", sourceMessage: {}, activation: {} }, { checkpointTurnStarted: async () => {} }),
    /cannot start a turn without its exact applied permission policy/);
  // The policy is bound by a later attach. The same runtime is the answer, and it is Read-only's from then on:
  assert.equal(await healthy.attach(true), found);
  assert.deepEqual(healthy.harness.signals, []);
  // a repair gives the conversation the Read-only config, whole, whatever a stored policy holds,
  healthy.harness.clients[1]!.markThreadMissing(found.providerContinuationId!);
  await healthy.restarted.repairContinuation!(found, {
    workAttemptId: found.workAttemptId, expectedProviderContinuationId: found.providerContinuationId!,
    cwd: spawnRequest().cwd, launchPolicy: { ...foundAsReadOnly().launchPolicy, ...stored }, model: null, reasoningEffort: null,
  }, { checkpointReplacement: async () => {} });
  const probes = sent(healthy.harness.clients[1]!, "thread/resume").filter((params) => Object.hasOwn(params, "approvalPolicy"));
  assert.equal(probes.length > 0, true);
  for (const probe of probes) assert.deepEqual(probe.config, { web_search: "disabled" });
  assert.deepEqual(sent(healthy.harness.clients[1]!, "thread/start")[0]!.config, { web_search: "disabled" });
  // and the reply of the repair is held to Read-only.
  healthy.harness.clients[1]!.sandboxFromOwnSettings = { type: "dangerFullAccess" };
  await assert.rejects(healthy.restarted.repairContinuation!(found, {
    workAttemptId: found.workAttemptId, expectedProviderContinuationId: found.providerContinuationId!,
    forceReplacement: true, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
  }, { checkpointReplacement: async () => {} }), /did not confirm Read-only access/);

  // The check that an attach with the policy makes runs when the policy is bound: what the conversation
  // reported when it was found is held to it then. One that reported another policy is stopped.
  for (const [what, misreport] of NOT_READ_ONLY_REPLIES) {
    const scene = await foundRunning(foundAsReadOnly(), misreport, false);
    const early = await scene.attach();
    assertProviderHandle(early);
    assert.deepEqual(scene.harness.signals, [], `${what}: nothing is stopped while no policy says what the conversation must be`);
    // Two callers bind at once: both get the one answer, and the process is signalled once.
    const [answer, again] = await Promise.all([scene.attach(true), scene.attach(true)]);
    assertStoppedNotReadOnly(answer, scene, what);
    assert.equal(again, answer, what);
    assert.equal(early.observedState(), "stopped", what);
    await assert.rejects(scene.restarted.runRoomTurn(early, { inboxItemId: "late", actionId: "late", sourceMessage: {}, activation: {} }, { checkpointTurnStarted: async () => {} }), /./, what);
  }

  // A runtime whose stop fails is not handed out as a healthy one: the bind fails for every caller, and the runtime takes no turn.
  const stuck = await foundRunning(foundAsReadOnly(), (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; }, false);
  let unreadable = false;
  const getProcessIdentity = stuck.harness.dependencies.getProcessIdentity;
  stuck.harness.dependencies.getProcessIdentity = (pid) => unreadable ? undefined : getProcessIdentity(pid);
  const holding = new CodexProviderAdapter({ dependencies: stuck.harness.dependencies });
  const kept = await holding.attach(stuck.ref);
  assertProviderHandle(kept);
  unreadable = true;
  const couldNotStop = /That is not Read-only access, and LetAgents could not stop the agent: Cannot stop the Codex app-server because its exact process birth cannot be verified\.$/;
  await assert.rejects(holding.attach({ ...stuck.ref, launchPolicy: stuck.level.launchPolicy }), couldNotStop);
  await assert.rejects(holding.attach({ ...stuck.ref, launchPolicy: stuck.level.launchPolicy }), couldNotStop);
  unreadable = false;
  await assert.rejects(holding.runRoomTurn(kept, { inboxItemId: "kept", actionId: "kept", sourceMessage: {}, activation: {} }, { checkpointTurnStarted: async () => {} }),
    /^Error: Codex reported approval policy "never" and sandbox "dangerFullAccess" for this agent's conversation\. That is not Read-only access\. Restart the agent\.$/);
  assert.equal(stuck.harness.clients[1]!.requests.some((call) => call.method === "turn/start"), false);
  assert.deepEqual(stuck.harness.signals, []);

  // Every other level bound later is the same runtime as before, whatever its conversation reported.
  for (const level of foundAtOtherLevels()) {
    const other = await foundRunning(level, (client) => { client.sandboxFromOwnSettings = { type: "dangerFullAccess" }; }, false);
    const early = await other.attach();
    assert.equal(await other.attach(true), early, level.permissionProfileId);
    assert.deepEqual(other.harness.signals, [], level.permissionProfileId);
    // Its repair sends what it sent before: no Read-only config.
    await other.restarted.repairContinuation!(early as ProviderHandle, {
      workAttemptId: other.ref.workAttemptId, expectedProviderContinuationId: other.ref.providerContinuationId,
      forceReplacement: true, cwd: spawnRequest().cwd, launchPolicy: { ...level.launchPolicy, ...stored }, model: null, reasoningEffort: null,
    }, { checkpointReplacement: async () => {} });
    assert.deepEqual(sent(other.harness.clients[1]!, "thread/start")[0]!.config, stored.config, level.permissionProfileId);
  }
});

test("a Read-only Codex agent's room tools are an exact named list, and every other room tool is refused", { timeout: 30_000 }, async () => {
  const { letAgentsRuntimeContract } = await import(new URL("../../../../src/mcp/server/runtime-contract.ts", import.meta.url).href);
  const { SUPERVISED_READ_ONLY_TOOLS } = await import(new URL("../../../../shared/supervised-read-tools.mjs", import.meta.url).href);
  const hosted = "https://letagents.chat", local = "letagents-local://rooms";
  const offered = (apiUrl: string): string[] => letAgentsRuntimeContract(apiUrl).profiles.cursor_supervised_room_turn.tools
    .filter((name: string) => name !== "complete_room_turn");
  const decided = Object.keys(READ_ONLY_ROOM_TOOL_DECISIONS).sort();
  const approved = decided.filter((name) => READ_ONLY_ROOM_TOOL_DECISIONS[name] === "approved");

  // Every tool the room server registers has a decision, and no decision is for a tool that is gone.
  assert.deepEqual([...offered(hosted)].sort(), decided,
    "a room tool was added or removed: decide whether a Read-only agent may use it, in READ_ONLY_ROOM_TOOL_DECISIONS");
  assert.deepEqual(offered(local).filter((name) => !decided.includes(name)), [], "a local room offers no tool a hosted room does not");
  // The adapter's list is exactly the approved decisions.
  assert.deepEqual([...CODEX_READ_ONLY_ROOM_TOOLS].sort(), approved);
  assert.deepEqual(approved, [
    "expand_room_history_summary", "get_board", "get_board_settings", "get_current_room", "get_human_requests", "get_room_artifacts",
    "get_room_events", "get_room_guidelines", "get_room_history_summary", "get_room_memory", "list_board_intents", "list_wake_rules",
    "post_reasoning", "post_status",
    "react_to_message", "read_messages", "request_human_input", "search_gifs", "send_message", "send_thread_message", "set_reply_gif", "set_reply_thread",
  ]);
  // An approved tool that is not chat or status is one the room server itself classes as a read,
  // and none of the three that touch this Mac's repository or another service is approved.
  const speaks = ["send_message", "send_thread_message", "post_status", "post_reasoning", "request_human_input", "set_reply_thread", "set_reply_gif", "react_to_message"];
  assert.deepEqual(approved.filter((name) => !speaks.includes(name) && !SUPERVISED_READ_ONLY_TOOLS.has(name)), []);
  for (const name of ["check_repo", "check_repo_visibility", "initialize_repo"]) assert.equal(READ_ONLY_ROOM_TOOL_DECISIONS[name], "refused", name);

  const supervised = { supervisorEntryId: "manifest_exact", supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact", configurationRevision: 1 };
  const launchOf = async (request: Partial<ProviderSpawnRequest>, apiUrl = hosted) => {
    const harness = createHarness();
    harness.dependencies.readMcpRuntimeContract = async (_entryPath, route) => letAgentsRuntimeContract(route ?? apiUrl);
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", ...supervised,
      supervisorWorkerSession: { agentSessionId: "agent_session_exact", apiUrl, roomCursor: null }, ...request,
    })) as ProviderHandle & { managedLaunchContract?: string };
    const [override = "", ...otherOverrides] = harness.launchOptions[0]!.options.configOverrides;
    assert.equal(override.startsWith("mcp_servers.letagents={ "), true, "the first override configures the room's server");
    const tools: string[] = JSON.parse(/enabled_tools = (\[[^\]]*\]), disabled_tools = \[\]/.exec(override)?.[1] ?? "[]");
    return {
      override, otherOverrides, tools,
      // Each listed tool's own approval mode, read from the override Codex is given.
      modes: Object.fromEntries(tools.map((name) => [name, override.split(`${JSON.stringify(name)} = { approval_mode = "`)[1]?.split('"')[0] ?? "missing"])),
      defaultMode: override.split('default_tools_approval_mode = "')[1]?.split('"')[0] ?? "missing",
      contract: handle.managedLaunchContract,
      described: await adapter.describeManagedLaunchContract({ apiUrl }),
    };
  };
  const readOnlyLevel = { permissionProfileId: "read_only", launchPolicy: CODEX_READ_ONLY_POLICY };

  // A Read-only launch: the named tools run without asking, and every other one needs an approval that nobody can give.
  for (const apiUrl of [hosted, local]) {
    const readOnly = await launchOf(readOnlyLevel, apiUrl);
    assert.deepEqual(readOnly.tools, offered(apiUrl), "the tools offered do not change with the access level");
    assert.deepEqual(readOnly.modes, Object.fromEntries(offered(apiUrl).map((name) => [name, approved.includes(name) ? "approve" : "prompt"])), apiUrl);
    assert.equal(readOnly.defaultMode, "prompt", "a tool with no line of its own is refused too");
    assert.deepEqual(readOnly.otherOverrides, [...CODEX_READ_ONLY_CONFIG_OVERRIDES]);
  }
  const readOnly = await launchOf(readOnlyLevel);
  // The same with the owner's own setup on: the room's server is still the sealed one.
  assert.deepEqual((await launchOf({ ...readOnlyLevel, homeHarness: true })).modes, readOnly.modes);

  // Every other level keeps the room tools it had: only reply routing is approved in advance.
  const unchanged = Object.fromEntries(offered(hosted).map((name) => [name, name === "set_reply_thread" ? "approve" : "writes"]));
  const others = [
    await launchOf({ permissionProfileId: "full_access", launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } }),
    await launchOf({ permissionProfileId: "ask_before_write", launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } }),
    await launchOf({ permissionProfileId: "auto_review", launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" } }),
  ];
  for (const other of others) {
    assert.deepEqual(other.modes, unchanged);
    assert.equal(other.defaultMode, "writes");
    assert.deepEqual(other.otherOverrides, [], "no other access level's launch gains an override");
    assert.equal(other.override === others[0]!.override, true, "the room server's configuration does not depend on these levels");
  }
  // Apart from the approval modes, a Read-only launch configures the room's server exactly as the others do.
  const withoutModes = (override: string) => override.replace(/approval_mode = "[a-z]+"/g, "approval_mode = *");
  assert.equal(withoutModes(readOnly.override) === withoutModes(others[0]!.override), true, "only approval modes differ for Read-only");

  // The level decides, not the shape of a policy: a launch that names no access level gets no tool approved in advance.
  const unnamed = await launchOf({ launchPolicy: CODEX_READ_ONLY_POLICY });
  assert.deepEqual(unnamed.modes, unchanged);
  assert.equal(unnamed.defaultMode, "writes");
  assert.deepEqual(unnamed.otherOverrides, []);

  // The background service holds that list only where it runs the room tools itself. An agent that
  // collects its own messages calls the room server directly, and only Codex would hold the list there.
  // So that kind of launch is not started at Read-only, and its owner is told what to do.
  const polling = { pollingContract: "custodial_polling_v1" as const, deliveryMode: "mcp_polling" as const };
  const NOT_FOR_POLLING = "Read-only access is for a Codex agent that LetAgents delivers room messages to. This agent collects its own room messages, "
    + "so LetAgents cannot hold it to the room tools that Read-only allows, and did not start it. Choose another access level for this agent.";
  await assert.rejects(launchOf({ ...polling, ...readOnlyLevel }), (error: Error) => error.message === NOT_FOR_POLLING);
  // A launch that does not say how its messages arrive is taken as that kind too.
  await assert.rejects(new CodexProviderAdapter({ dependencies: createHarness().dependencies }).spawn(spawnRequest({ ...readOnlyLevel, configurationRevision: 1 })),
    (error: Error) => error.message === NOT_FOR_POLLING);
  const pollingFullAccess = await launchOf({ ...polling, permissionProfileId: "full_access", launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } });
  assert.equal(pollingFullAccess.tools.includes("wait_for_messages"), true, "every other level starts that kind of launch as before");

  // The daemon compares one launch contract for a room server: a Read-only agent records the one it expects,
  // so it is not replaced again and again as out of date.
  assert.match(readOnly.contract ?? "", /^[a-f0-9]{64}$/);
  assert.equal(readOnly.contract, readOnly.described);
  assert.equal(readOnly.contract, others[0]!.contract);
});
