import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CodexProviderAdapter, type CodexPermissionObservation } from "../main/agents/codex-provider-adapter.js";
import type {
  ProviderActivityEvent,
  ProviderConnectionRef,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import {
  providerStreamLifecycle,
  assertProviderHandle,
  type FakeCodexModel,
  FakeRpc,
  createHarness,
  spawnRequest,
  requestByMethod,
  flush,
  approvalParams,
  effortNotGiven,
  effortNotReported,
  recordedByDaemon,
  effortReportedAsNone,
  FULL_ACCESS,
} from "./codex-provider-adapter.fixture.js";

test("Codex resume reopens the exact native thread and preserves the same launch policy", async () => {
  const harness = createHarness();
  const activity: ProviderActivityEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  const request = spawnRequest({
    supervisorWorkerSession: {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2819",
    },
  });
  const first = await adapter.spawn(request);
  const continuation = first.providerContinuationId!;
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  const resumedAdapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  assert.equal(resumedAdapter.capabilities().resume, true);
  const resumed = await resumedAdapter.resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: continuation,
  }, request);

  assert.equal(resumed.providerContinuationId, continuation);
  const resume = harness.clients[1]!.requests.find((entry) =>
    entry.method === "thread/resume"
      && (entry.params as { threadId?: string }).threadId === continuation);
  assert.ok(resume, "expected exact durable continuation resume request");
  const params = resume.params as Record<string, unknown>;
  assert.equal(params.threadId, continuation);
  assert.equal(params.sandbox, "danger-full-access");
  assert.equal(
    harness.clients[1]!.requests.filter((entry) => entry.method === "thread/start").length,
    0,
    "resume must not mint a fresh provider thread",
  );
  const readIndex = harness.clients[1]!.requests.findIndex((entry) => entry.method === "thread/read");
  const turnIndex = harness.clients[1]!.requests.findIndex((entry) => entry.method === "turn/start");
  assert.ok(readIndex >= 0 && readIndex < turnIndex, "prior transcript is read before the next turn");
  const turn = harness.clients[1]!.requests[turnIndex]!.params as { input: Array<{ text: string }> };
  assert.match(turn.input[0]!.text, /agent_session_exact/);
  assert.match(turn.input[0]!.text, /msg_2819/);
  assert.match(turn.input[0]!.text, /Do not call register_agent_session/);
  assert.doesNotMatch(turn.input[0]!.text, /Suggested codename|Call set_agent_name/);
  assert.ok(activity.some((event) =>
    event.providerContinuationId === continuation
      && event.source === "transcript_tail"
      && event.summary === "Transcript checkpoint persisted."));
});

test("Codex is given a thread's reasoning effort as the config override it takes, at a start, a repair and a resume", async () => {
  const harness = createHarness();
  const request = spawnRequest({ deliveryMode: "daemon_inbox", model: "gpt-5.6-sol", reasoningEffort: "high" });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(request);
  const sent = (client: FakeRpc, method: string) => client.requests
    .filter((entry) => entry.method === method).map((entry) => entry.params as Record<string, unknown>);
  const effort = { model_reasoning_effort: "high" };

  const client = harness.clients[0]!;
  const [started] = sent(client, "thread/start");
  assert.deepEqual(started!.config, effort);
  assert.equal(started!.model, "gpt-5.6-sol");
  // Codex has no such parameter: it ignores one and keeps the effort of its owner's settings.
  assert.equal(Object.hasOwn(started!, "reasoningEffort"), false);
  assert.deepEqual(sent(client, "model/list"), [{ includeHidden: true }], "Codex is asked once which efforts its models take");
  // The question has a time limit of its own: an app-server that does not answer it must not hold the launch.
  assert.deepEqual(client.requestTimeouts.filter((entry) => entry.method === "model/list"), [{ method: "model/list", timeoutMs: 5_000 }]);
  assert.deepEqual(handle.launchNotices, []);

  // A repair probes the conversation, then starts another one on the same process.
  client.markThreadMissing("thread-1");
  await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1", cwd: request.cwd,
    launchPolicy: request.launchPolicy, model: "gpt-5.6-sol", reasoningEffort: "high",
  }, { checkpointReplacement: async () => {} });
  const probes = sent(client, "thread/resume");
  assert.equal(probes.length, 4);
  for (const probe of probes) {
    assert.deepEqual(probe.config, effort);
    assert.equal(Object.hasOwn(probe, "reasoningEffort"), false);
  }
  const replacement = sent(client, "thread/start")[1]!;
  assert.deepEqual(replacement.config, effort);
  assert.equal(Object.hasOwn(replacement, "reasoningEffort"), false);

  // A resume is another process. An effort the owner has changed since reaches the thread there.
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  const resumed = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume(
    { workAttemptId: request.workAttemptId, providerContinuationId: handle.providerContinuationId! },
    { ...request, reasoningEffort: "low" },
  );
  const [resume] = sent(harness.clients[1]!, "thread/resume");
  assert.deepEqual(resume!.config, { model_reasoning_effort: "low" });
  assert.equal(Object.hasOwn(resume!, "reasoningEffort"), false);
  assert.deepEqual(resumed.launchNotices, []);
});

test("Codex is not given a reasoning effort that the thread's model can refuse, and the owner is told", async () => {
  const level = spawnRequest().launchPolicy as Record<string, unknown>;
  const started = async (overrides: Partial<ProviderSpawnRequest>, options: Parameters<typeof createHarness>[0] = {}) => {
    const harness = createHarness(options);
    // The agent still starts, whatever becomes of its effort.
    const handle = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({ deliveryMode: "daemon_inbox", ...overrides }));
    const client = harness.clients[0]!;
    const start = requestByMethod(client, "thread/start").params as Record<string, unknown>;
    assert.equal(Object.hasOwn(start, "reasoningEffort"), false);
    return { config: start.config, notices: handle.launchNotices ?? [], asked: client.requests.filter((entry) => entry.method === "model/list").length };
  };
  const leftOut = (effort: string, reason: string, choose: string | null) => ({
    config: undefined,
    notices: [`This agent's reasoning effort "${effort}" was not given to Codex, because ${reason}. The agent runs with the effort Codex gives it.`
      + (choose ? ` Choose ${choose} in the agent's settings.` : "")],
    asked: 1,
  });
  const given = (effort: string) => ({ config: { model_reasoning_effort: effort }, notices: [], asked: 1 });
  const unchecked = (why: string) => `${why}, so the effort could not be checked`;

  // No effort was chosen: Codex is asked nothing more.
  assert.deepEqual(await started({ model: "gpt-5.5" }), { config: undefined, notices: [], asked: 0 });
  // The agent's model takes the effort.
  assert.deepEqual(await started({ model: "gpt-5.6-sol", reasoningEffort: "max" }), given("max"));
  // It does not: real Codex starts such a thread and then fails every turn of it.
  assert.deepEqual(await started({ model: "gpt-5.5", reasoningEffort: "max" }),
    leftOut("max", 'the model "gpt-5.5" does not take it', "another effort"));
  // An agent with no model of its own runs a model that is not known here, so every listed model must take its effort.
  assert.deepEqual(await started({ reasoningEffort: "xhigh" }), given("xhigh"));
  assert.deepEqual(await started({ model: null, reasoningEffort: "max" }),
    leftOut("max", "not every Codex model takes it and this agent has no model of its own", "a model or another effort"));

  // An effort that cannot be checked is not sent, and the line says what could not be done.
  assert.deepEqual(await started({ model: "a-model-of-my-own", reasoningEffort: "high" }),
    leftOut("high", unchecked('Codex does not list the model "a-model-of-my-own"'), null));
  assert.deepEqual(await started({ reasoningEffort: "high" }, { models: [] }), leftOut("high", unchecked("Codex listed no models"), null));
  // Codex gave no list: an error, or no answer within the time limit. That is not a list without the agent's model.
  for (const models of [null, "timeout"] as const) {
    for (const model of ["gpt-5.6-sol", null]) {
      assert.deepEqual(await started({ model, reasoningEffort: "high" }, { models }),
        leftOut("high", unchecked("Codex did not say which efforts its models take"), null), `${models} ${model}`);
    }
  }

  // Only the first page of the list is read. With more pages, "every listed model" is not known,
  // and a model that is not on the first page is not found: both leave the effort out.
  const morePages = { moreModelPages: true };
  assert.deepEqual(await started({ reasoningEffort: "high" }, morePages), leftOut("high", unchecked("Codex did not list all its models"), null));
  assert.deepEqual(await started({ model: "a-model-on-a-later-page", reasoningEffort: "high" }, morePages),
    leftOut("high", unchecked("Codex did not list all its models"), null));
  // A model on the first page is checked against its own entry, whatever the other pages hold.
  assert.deepEqual(await started({ model: "gpt-5.6-sol", reasoningEffort: "max" }, morePages), given("max"));
  assert.deepEqual(await started({ model: "gpt-5.5", reasoningEffort: "max" }, morePages),
    leftOut("max", 'the model "gpt-5.5" does not take it', "another effort"));

  // A thread is started with an entry's `model`. An `id` that reads the same names another entry.
  const models: FakeCodexModel[] = [
    { id: "preset-a", model: "gpt-new", efforts: ["low", "max"] },
    { id: "gpt-new", model: "gpt-old", efforts: ["low"] },
  ];
  assert.deepEqual(await started({ model: "gpt-new", reasoningEffort: "max" }, { models }), given("max"));
  assert.deepEqual(await started({ model: "preset-a", reasoningEffort: "low" }, { models }),
    leftOut("low", unchecked('Codex does not list the model "preset-a"'), null));

  // A stored `config` option keeps its other keys, and the agent's own effort wins over one stored there.
  assert.deepEqual((await started({
    model: "gpt-5.6-sol", reasoningEffort: "low",
    launchPolicy: { ...level, config: { model_verbosity: "low", model_reasoning_effort: "xhigh" } },
  })).config, { model_verbosity: "low", model_reasoning_effort: "low" });
});

test("the owner is told when Codex reports another reasoning effort than the one it was given, and the agent still starts", async () => {
  const request = spawnRequest({ deliveryMode: "daemon_inbox", model: "gpt-5.6-sol", reasoningEffort: "low" });

  // Codex reports the effort it was given: there is nothing to say.
  const taking = createHarness();
  assert.deepEqual((await new CodexProviderAdapter({ dependencies: taking.dependencies }).spawn(request)).launchNotices, []);
  // An app-server whose reply has no effort field does not report the effort: that says nothing either way.
  const silent = createHarness({ effortFromOwnSettings: null });
  assert.deepEqual((await new CodexProviderAdapter({ dependencies: silent.dependencies }).spawn(request)).launchNotices, []);

  // At a start: Codex ignores the effort and reports its owner's. This is how the effort was once lost with no word.
  const ignoring = createHarness({ effortFromOwnSettings: "xhigh" });
  const handle = await new CodexProviderAdapter({ dependencies: ignoring.dependencies }).spawn(request);
  assert.deepEqual((requestByMethod(ignoring.clients[0]!, "thread/start").params as Record<string, unknown>).config, { model_reasoning_effort: "low" });
  assert.deepEqual(handle.launchNotices, [effortNotReported("low", "xhigh")]);
  assert.equal(handle.observedState(), "idle");

  // At a resume, in another process.
  ignoring.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  const resumed = await new CodexProviderAdapter({ dependencies: ignoring.dependencies }).resume(
    { workAttemptId: request.workAttemptId, providerContinuationId: handle.providerContinuationId! },
    { ...request, reasoningEffort: "high" },
  );
  assert.deepEqual((requestByMethod(ignoring.clients[1]!, "thread/resume").params as Record<string, unknown>).config, { model_reasoning_effort: "high" });
  assert.deepEqual(resumed.launchNotices, [effortNotReported("high", "xhigh")]);
  assert.equal(resumed.observedState(), "idle");
});

test("a Codex repair returns what its launch did not say about the reasoning effort, and returns it once", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest({ deliveryMode: "daemon_inbox", model: "gpt-5.6-sol", reasoningEffort: "low" });
  const handle = await adapter.spawn(request);
  assert.deepEqual(handle.launchNotices, []);
  const client = harness.clients[0]!;
  // The daemon drops a line that is streamed while a repair replaces the conversation, so a repair streams none.
  const streamed: string[] = [];
  adapter.onStream(handle, (event) => { if (/reasoning effort/.test(event.summary ?? "")) streamed.push(event.method); });
  const repair = async (overrides: { model?: string; reasoningEffort: "low" | "high" | "max"; replace?: boolean }) => {
    // A repair that must replace the conversation probes the missing one four times, then starts another.
    if (overrides.replace) client.markThreadMissing(handle.providerContinuationId!);
    const result = await adapter.repairContinuation!(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!, cwd: request.cwd,
      launchPolicy: request.launchPolicy, model: overrides.model ?? "gpt-5.6-sol", reasoningEffort: overrides.reasoningEffort,
    }, { checkpointReplacement: async () => {} });
    assert.equal(result.outcome, overrides.replace ? "replaced" : "rematerialized");
    return recordedByDaemon(result);
  };

  // The process has the thread loaded, and Codex keeps a loaded thread's own effort whatever a resume names.
  client.effortFromOwnSettings = "low";
  assert.deepEqual(await repair({ reasoningEffort: "low" }), [], "the thread has the effort the repair names");
  // The owner chose another effort since the launch. The loaded thread does not take it, and the repair says so.
  assert.deepEqual(await repair({ reasoningEffort: "high" }), [effortNotReported("high", "low")]);
  // The same again says nothing more: not at the next repair, and not for each probe and the new conversation of one repair.
  assert.deepEqual(await repair({ reasoningEffort: "high" }), []);
  assert.deepEqual(await repair({ reasoningEffort: "high", replace: true }), []);
  assert.equal(client.requests.filter((entry) => entry.method === "thread/start").length, 2);
  // An effort that the repair cannot send is said the same way.
  assert.deepEqual(await repair({ model: "gpt-5.5", reasoningEffort: "max" }), [effortNotGiven("max", "gpt-5.5")]);
  // The conversation that a repair starts is compared too, and its line is returned once for the four probes and the start.
  client.effortFromOwnSettings = "xhigh";
  assert.deepEqual(await repair({ reasoningEffort: "low", replace: true }), [effortNotReported("low", "xhigh")]);
  assert.deepEqual(streamed, []);
});

test("a Codex repair does not say again what the launch of its process said about the reasoning effort", async () => {
  const repaired = async (overrides: Partial<ProviderSpawnRequest>, options: Parameters<typeof createHarness>[0] = {}) => {
    const harness = createHarness(options);
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ deliveryMode: "daemon_inbox", ...overrides });
    const handle = await adapter.spawn(request);
    const repair = async (effort: ProviderSpawnRequest["reasoningEffort"]) => recordedByDaemon(await adapter.repairContinuation!(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!, cwd: request.cwd,
      launchPolicy: request.launchPolicy, model: request.model, reasoningEffort: effort,
    }, { checkpointReplacement: async () => {} }));
    return { launch: handle.launchNotices ?? [], same: await repair(request.reasoningEffort), other: await repair("medium") };
  };
  // The launch said that Codex reports another effort. A repair with the same effort finds the same, and is quiet.
  assert.deepEqual(await repaired({ model: "gpt-5.6-sol", reasoningEffort: "low" }, { effortFromOwnSettings: "xhigh" }), {
    launch: [effortNotReported("low", "xhigh")],
    same: [],
    other: [effortNotReported("medium", "xhigh")],
  });
  // The launch said that the effort was not given. The same holds for it.
  assert.deepEqual(await repaired({ model: "gpt-5.5", reasoningEffort: "max" }), {
    launch: [effortNotGiven("max", "gpt-5.5")],
    same: [],
    other: [],
  });
});

test("the owner is told when Codex reports no reasoning effort for a conversation that was given one", async () => {
  // Real Codex 0.153 reports the effort of a thread it was given one for, as a string. A null in
  // that place is Codex saying that the conversation has no effort, which is not what was chosen.
  const request = spawnRequest({ deliveryMode: "daemon_inbox", model: "gpt-5.6-sol", reasoningEffort: "low" });
  const none = createHarness({ effortReportedAsNull: true });
  const adapter = new CodexProviderAdapter({ dependencies: none.dependencies });
  const handle = await adapter.spawn(request);
  assert.deepEqual((requestByMethod(none.clients[0]!, "thread/start").params as Record<string, unknown>).config, { model_reasoning_effort: "low" });
  assert.deepEqual(handle.launchNotices, [effortReportedAsNone("low")]);
  assert.equal(handle.observedState(), "idle", "the agent still starts");

  // A repair reads the reply of a resume and of a new conversation the same way.
  const repair = async (effort: "low" | "high", replace = false) => {
    if (replace) none.clients[0]!.markThreadMissing(handle.providerContinuationId!);
    return recordedByDaemon(await adapter.repairContinuation!(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!, cwd: request.cwd,
      launchPolicy: request.launchPolicy, model: request.model, reasoningEffort: effort,
    }, { checkpointReplacement: async () => {} }));
  };
  assert.deepEqual(await repair("low"), [], "the launch of this process said it");
  assert.deepEqual(await repair("high"), [effortReportedAsNone("high")], "at a resume");
  assert.deepEqual(await repair("low", true), [effortReportedAsNone("low")], "at the start of a replacement conversation");

  // No effort was given: Codex was asked for none, and a null is no news.
  const unasked = createHarness({ effortReportedAsNull: true });
  assert.deepEqual((await new CodexProviderAdapter({ dependencies: unasked.dependencies }).spawn({ ...request, reasoningEffort: null })).launchNotices, []);
  // An effort that was not sent has its own line, and a null adds nothing to it.
  const refused = createHarness({ effortReportedAsNull: true });
  assert.deepEqual((await new CodexProviderAdapter({ dependencies: refused.dependencies })
    .spawn({ ...request, model: "gpt-5.5", reasoningEffort: "max" })).launchNotices, [effortNotGiven("max", "gpt-5.5")]);
});

test("a reasoning effort line that a Codex repair says first is not said again by the agent's next start", async () => {
  const supervised = (agent: string) => ({ deliveryMode: "daemon_inbox" as const, supervisorEntryId: agent,
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS });
  const taken = { model: "gpt-5.6-sol", reasoningEffort: "low" } as const;
  const refused = { model: "gpt-5.5", reasoningEffort: "max" } as const;
  const start = async (agent: string, overrides: Partial<ProviderSpawnRequest>, options: Parameters<typeof createHarness>[0] = {}) => {
    const harness = createHarness({ exitOnSignal: true, ...options });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ ...supervised(agent), ...overrides });
    const handle = await adapter.spawn(request);
    /** The daemon names the agent to a repair as it names it to a launch. Null is a repair that names none. */
    const repair = async (effort: Partial<ProviderSpawnRequest>, named: string | null = agent) => recordedByDaemon(await adapter.repairContinuation!(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!, cwd: request.cwd,
      launchPolicy: request.launchPolicy, model: effort.model, reasoningEffort: effort.reasoningEffort,
      ...(named === null ? {} : { supervisorEntryId: named }),
    }, { checkpointReplacement: async () => {} }));
    return { told: handle.launchNotices ?? [], repair };
  };

  // The owner chose an effort that the model refuses, and a repair is the first to find it.
  const first = await start("supervised_effort_repair_first", taken);
  assert.deepEqual(first.told, []);
  assert.deepEqual(await first.repair(refused), [effortNotGiven("max", "gpt-5.5")]);
  // The agent's next start finds the same. The owner has been told, so it says nothing.
  const second = await start("supervised_effort_repair_first", refused);
  assert.deepEqual(second.told, [], "the repair said this line");
  assert.deepEqual(await second.repair(refused), [], "and a repair of the new process does not say it either");
  // A repair that finds the effort taken has no line. The line that comes back at a later start is said again, as after a start with no line.
  assert.deepEqual(await second.repair(taken), []);
  assert.deepEqual((await start("supervised_effort_repair_first", refused)).told, [effortNotGiven("max", "gpt-5.5")], "a line that comes back is said again");

  // The same holds for an effort that Codex does not report back.
  const reporting = { effortFromOwnSettings: "xhigh" };
  const medium = { model: "gpt-5.6-sol", reasoningEffort: "medium" } as const;
  const reported = await start("supervised_effort_repair_reported", taken, reporting);
  assert.deepEqual(reported.told, [effortNotReported("low", "xhigh")]);
  assert.deepEqual(await reported.repair(medium), [effortNotReported("medium", "xhigh")]);
  assert.deepEqual((await start("supervised_effort_repair_reported", medium, reporting)).told, [], "the repair said this line");
  // Each agent is told for itself: the repair of one agent does not speak for another.
  assert.deepEqual((await start("supervised_effort_repair_other", medium, reporting)).told, [effortNotReported("medium", "xhigh")]);

  // A repair that names no agent keeps what it said with its own runtime, and the agent's next start says it.
  const unnamed = await start("supervised_effort_repair_unnamed", taken);
  assert.deepEqual(await unnamed.repair(refused, null), [effortNotGiven("max", "gpt-5.5")]);
  assert.deepEqual(await unnamed.repair(refused, null), []);
  assert.deepEqual((await start("supervised_effort_repair_unnamed", refused)).told, [effortNotGiven("max", "gpt-5.5")]);
});

test("a Codex repair has said its reasoning effort line only when the daemon recorded it, so a retry and the next start say a line that was lost", async () => {
  const supervised = (agent: string) => ({ deliveryMode: "daemon_inbox" as const, supervisorEntryId: agent,
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS });
  const taken = { model: "gpt-5.6-sol", reasoningEffort: "low" } as const;
  const refused = { model: "gpt-5.5", reasoningEffort: "max" } as const;
  const started = async (agent: string | undefined) => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ ...(agent === undefined ? { deliveryMode: "daemon_inbox" as const } : supervised(agent)), ...taken });
    const handle = await adapter.spawn(request);
    assert.deepEqual(handle.launchNotices, []);
    const repair = (effort: Partial<ProviderSpawnRequest>, checkpointReplacement: () => Promise<void> = async () => {}) => adapter.repairContinuation!(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!, cwd: request.cwd,
      launchPolicy: request.launchPolicy, model: effort.model, reasoningEffort: effort.reasoningEffort,
      ...(agent === undefined ? {} : { supervisorEntryId: agent }),
    }, { checkpointReplacement });
    return { client: harness.clients[0]!, handle, repair };
  };
  const journalDown = async () => { throw new Error("the replacement could not be journaled"); };

  // An effort that is not sent: the repair knows its line before it asks Codex for the conversation,
  // and then fails where the replacement conversation is made durable. Its result never reached the daemon.
  for (const agent of ["supervised_effort_repair_failed", undefined]) {
    const { client, handle, repair } = await started(agent);
    client.markThreadMissing(handle.providerContinuationId!);
    await assert.rejects(repair(refused, journalDown), /could not be journaled/);
    const retried = await repair(refused);
    assert.equal(retried.outcome, "replaced");
    assert.deepEqual(recordedByDaemon(retried), [effortNotGiven("max", "gpt-5.5")], `${agent}: the retry says what the failed repair did not`);
    assert.deepEqual(recordedByDaemon(await repair(refused)), [], `${agent}: and says it once`);
  }

  // An effort that Codex does not report back: the line is read in the reply of the new conversation, and the repair fails after it.
  {
    const { client, handle, repair } = await started(undefined);
    const high = { model: "gpt-5.6-sol", reasoningEffort: "high" } as const;
    client.effortFromOwnSettings = "xhigh";
    client.markThreadMissing(handle.providerContinuationId!);
    await assert.rejects(repair(high, journalDown), /could not be journaled/);
    assert.deepEqual(recordedByDaemon(await repair(high)), [effortNotReported("high", "xhigh")]);
  }

  // The repair returned its line, and the daemon did not record it: it failed the repair after the
  // provider returned, or it could not write the agent's activity. The provider was not told that
  // the line is recorded, so the line is still to be said.
  for (const agent of ["supervised_effort_repair_unrecorded", undefined]) {
    const { repair } = await started(agent);
    assert.deepEqual((await repair(refused)).notices, [effortNotGiven("max", "gpt-5.5")]);
    assert.deepEqual((await repair(refused)).notices, [effortNotGiven("max", "gpt-5.5")], `${agent}: a retry says the line that was lost`);
    assert.deepEqual(recordedByDaemon(await repair(refused)), [effortNotGiven("max", "gpt-5.5")], `${agent}: until it is recorded`);
    assert.deepEqual(recordedByDaemon(await repair(refused)), [], `${agent}: and then it is said`);
  }
  // With no retry, the agent's next start says the line that was lost.
  {
    const { repair } = await started("supervised_effort_repair_unrecorded_then_start");
    assert.deepEqual((await repair(refused)).notices, [effortNotGiven("max", "gpt-5.5")]);
    const next = createHarness({ exitOnSignal: true });
    assert.deepEqual((await new CodexProviderAdapter({ dependencies: next.dependencies })
      .spawn(spawnRequest({ ...supervised("supervised_effort_repair_unrecorded_then_start"), ...refused }))).launchNotices, [effortNotGiven("max", "gpt-5.5")]);
  }

  // A repair that failed is not what the agent was last told: with no retry, the next start says the line.
  const { client, handle, repair } = await started("supervised_effort_repair_failed_then_start");
  client.markThreadMissing(handle.providerContinuationId!);
  await assert.rejects(repair(refused, journalDown), /could not be journaled/);
  const next = createHarness({ exitOnSignal: true });
  assert.deepEqual((await new CodexProviderAdapter({ dependencies: next.dependencies })
    .spawn(spawnRequest({ ...supervised("supervised_effort_repair_failed_then_start"), ...refused }))).launchNotices, [effortNotGiven("max", "gpt-5.5")]);
});

test("a Codex agent is told about its reasoning effort when the line changes, not at every start", async () => {
  const supervised = (agent: string) => ({ deliveryMode: "daemon_inbox" as const, supervisorEntryId: agent,
    supervisorSocketPath: "/tmp/daemon.sock", supervisorExecutionGenerationId: "execution_exact", ...FULL_ACCESS });
  const told = async (agent: string | undefined, overrides: Partial<ProviderSpawnRequest>, options: Parameters<typeof createHarness>[0] = {}) => {
    const harness = createHarness({ exitOnSignal: true, ...options });
    const handle = await new CodexProviderAdapter({ dependencies: harness.dependencies })
      .spawn(spawnRequest({ ...(agent === undefined ? { deliveryMode: "daemon_inbox" } : supervised(agent)), ...overrides }));
    return handle.launchNotices ?? [];
  };
  const refused = { model: "gpt-5.5", reasoningEffort: "max" } as const;
  const taken = { model: "gpt-5.6-sol", reasoningEffort: "low" } as const;

  // An effort that is not sent.
  assert.deepEqual(await told("supervised_effort_once", refused), [effortNotGiven("max", "gpt-5.5")], "its first start says it");
  assert.deepEqual(await told("supervised_effort_once", refused), [], "the same again says nothing");
  assert.deepEqual(await told("supervised_effort_once", { model: "a-model-of-my-own", reasoningEffort: "max" }),
    [`This agent's reasoning effort "max" was not given to Codex, because Codex does not list the model "a-model-of-my-own", so the effort could not be checked. The agent runs with the effort Codex gives it.`],
    "another cause is another line");
  assert.deepEqual(await told("supervised_effort_once", taken), [], "an effort that Codex takes has no line");
  assert.deepEqual(await told("supervised_effort_once", refused), [effortNotGiven("max", "gpt-5.5")], "a line that comes back is said again");

  // An effort that Codex does not report back.
  assert.deepEqual(await told("supervised_effort_reported", taken, { effortFromOwnSettings: "xhigh" }), [effortNotReported("low", "xhigh")]);
  assert.deepEqual(await told("supervised_effort_reported", taken, { effortFromOwnSettings: "xhigh" }), []);
  assert.deepEqual(await told("supervised_effort_reported", taken, { effortFromOwnSettings: "medium" }), [effortNotReported("low", "medium")]);

  // Each agent is told for itself, and an agent with no id is told at every start.
  assert.deepEqual(await told("supervised_effort_other", refused), [effortNotGiven("max", "gpt-5.5")]);
  assert.deepEqual(await told(undefined, refused), [effortNotGiven("max", "gpt-5.5")]);
  assert.deepEqual(await told(undefined, refused), [effortNotGiven("max", "gpt-5.5")]);

  // The line about the effort and the line about saved options do not hide each other.
  const level = spawnRequest().launchPolicy as Record<string, unknown>;
  const both = { ...refused, homeHarness: true, launchPolicy: { ...level, personality: "pragmatic" } };
  assert.deepEqual(await told("supervised_effort_and_options", both), [
    `With your own setup on, this agent starts with its access level's own Codex options only. These saved options were not used: "personality".`,
    effortNotGiven("max", "gpt-5.5"),
  ]);
  assert.deepEqual(await told("supervised_effort_and_options", both), []);

  // A start that failed after it was given the line never showed it, so the next start says it.
  const failing = createHarness({ exitOnSignal: true });
  const createRpcClient = failing.dependencies.createRpcClient;
  failing.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown, options?: { timeoutMs?: number }) => {
      // This agent collects its own room messages, so its start ends with a first turn.
      if (method === "turn/start") throw new Error("the first turn was refused");
      return request<T>(method, params, options);
    };
    return client;
  };
  await assert.rejects(new CodexProviderAdapter({ dependencies: failing.dependencies })
    .spawn(spawnRequest({ ...supervised("supervised_effort_failed"), deliveryMode: "mcp_polling", ...refused })), /the first turn was refused/);
  assert.deepEqual(await told("supervised_effort_failed", refused), [effortNotGiven("max", "gpt-5.5")]);
});

test("reattachment subscribes the exact thread and observes native approvals without replay or policy overrides", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const first = await firstAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      const result = await request<T>(method, params);
      if (method === "thread/resume") client.askPermission(approvalParams());
      return result;
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const client = harness.clients[1]!;
  assert.deepEqual(requestByMethod(client, "thread/resume").params, { threadId: first.providerContinuationId });
  assert.equal(client.requests.some(request => request.method === "turn/start" || request.method === "thread/start"), false);
  const events: CodexPermissionObservation[] = [];
  const controller = new AbortController();
  const observation = adapter.observePermissions(attached, event => events.push(event), controller.signal);
  await flush();
  assert.ok(events.some(event => event.type === "snapshot" && event.requests.length === 1));
  assert.equal(client.permissionResponses.length, 0);
  controller.abort();
  await observation;
});

test("reattachment reconstructs a turn that completed before subscription without a notification", async () => {
  const harness = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies })
    .spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.turnStatus = "inProgress";
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      if (method === "thread/resume") client.turnStatus = "completed";
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.ok(observations.some(event => event.fact.domain === "turn"
    && event.fact.state === "terminal" && event.fact.turnOutcome === "completed"));
  assert.equal(attached.observedState(), "idle", "configuration restart admission must agree with the exact terminal snapshot");
  subscription.dispose();
});

test("observation attachment does not cold-resume an unloaded thread with process defaults", async () => {
  const harness = createHarness();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies })
    .spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      const result = await request<T>(method, params);
      if (method === "thread/read") (result as { thread: { status: unknown } }).thread.status = { type: "notLoaded" };
      return result;
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  assert.equal(harness.clients[1]!.requests.some(request => request.method === "thread/resume"), false);
});

test("empty reattachment subscribes after first-turn checkpoint and never replays on subscription failure", async () => {
  for (const { failSubscription, status } of [
    { failSubscription: false, status: "completed" },
    { failSubscription: false, status: "cancelled" },
    { failSubscription: false, status: "STOPPED" },
    { failSubscription: true, status: "completed" },
  ]) {
    const harness = createHarness();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies })
      .spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const createRpcClient = harness.dependencies.createRpcClient;
    let materialized = false;
    let checkpointed = false;
    let subscriptionFailed = false;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown) => {
        if (method === "thread/read" && !materialized && (params as { includeTurns?: boolean }).includeTurns) {
          throw new Error(`thread ${first.providerContinuationId} is not materialized yet; includeTurns is unavailable before first user message`);
        }
        if (method === "turn/start") { materialized = true; client.turnStatus = "inProgress"; }
        if (method === "thread/resume") {
          assert.ok(materialized, "resume cannot read history before the first turn");
          assert.ok(checkpointed, "native acknowledgement is durable before subscription can fail");
          if (failSubscription && !subscriptionFailed) {
            subscriptionFailed = true;
            throw new Error("subscription unavailable");
          }
          client.askPermission(approvalParams());
          // Fast completion before subscription has no corresponding notification.
          client.turnStatus = status;
        }
        return request<T>(method, params);
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({ workAttemptId: first.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection,
      launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
    assertProviderHandle(attached);
    const result = adapter.runRoomTurn(attached, { inboxItemId: "first-turn", actionId: "first-turn", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async () => { checkpointed = true; },
    });
    if (failSubscription) {
      await assert.rejects(result, /subscription unavailable/);
      await adapter.recoverRoomTurn(attached, { inboxItemId: "first-turn", providerTurnId: `turn-${first.providerContinuationId}` });
    }
    else if (status !== "completed") assert.equal((await result).outcome, "interrupted");
    else await result;
    const client = harness.clients[1]!;
    assert.equal(client.requests.filter(request => request.method === "turn/start").length, 1);
    assert.equal(client.permissionResponses.length, 0);
    const policy = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.deepEqual(policy.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(client.listPendingRequests().length, 1);
  }
});

test("fresh adapter reattaches the durable app-server endpoint without launching a duplicate child", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  assert.ok(first.providerConnection);

  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.turnStatus = { status: "failed" };
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown) => {
      const result = await request<T>(method, params);
      if (method === "thread/read") {
        const thread = (result as { thread?: { turns?: Array<Record<string, unknown>> } }).thread;
        const latestTurn = thread?.turns?.at(-1);
        if (latestTurn) latestTurn.items = [{ type: "agentMessage", text: "x".repeat(40_000) }];
      }
      return result;
    };
    return client;
  };
  const stream: ProviderStreamEvent[] = [];
  const freshAdapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = freshAdapter.onExecution(attached, (event) => observations.push(event));

  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(attached.pid, first.pid);
  assert.equal(harness.launches.length, 1, "reattach must not create a second native writer");
  assert.equal(
    harness.clients[1]!.requests.some((entry) => entry.method === "thread/start" || entry.method === "turn/start"),
    false,
  );
  const snapshot = stream.find((event) => event.method === "thread/read");
  assert.ok(snapshot, "reattach emits one normalized transcript snapshot");
  assert.equal((snapshot.payload as { thread?: unknown }).thread, undefined,
    "attach and live transcript snapshots share the same closed payload shape");
  assert.deepEqual((snapshot.payload as { latestTurn?: { status?: unknown } }).latestTurn?.status, { status: "failed" });
  assert.equal(snapshot.payloadTruncated, false,
    "oversized transcript items cannot erase the closed lifecycle metadata");
  assert.equal(providerStreamLifecycle(snapshot), "terminal",
    "the exact reattach payload keeps failed-turn evidence scoped to the native turn");
  assert.equal(snapshot.nativeLifecyclePhase, undefined,
    "reattach reconstruction does not feed the legacy lifecycle projection");
  const terminal = observations.find((event) => event.fact.domain === "turn");
  assert.ok(terminal?.fact.domain === "turn");
  assert.deepEqual(terminal.fact, {
    providerContinuationId: first.providerContinuationId,
    providerTurnId: `turn-${first.providerContinuationId}`,
    domain: "turn",
    kind: "state_changed",
    state: "terminal",
    turnOutcome: "failed",
    sideEffects: "none",
  });
  assert.equal(terminal.nativeProcessPid, first.providerConnection.pid);
  assert.equal(terminal.nativeProcessIdentity, first.providerConnection.processIdentity);
  assert.equal(observations[0]?.fact.domain, "runtime",
    "late capture receives the reconstructed runtime boundary before the turn");
  assert.equal(await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), attached);
  subscription.dispose();
});

test("fresh Codex attach reconstructs only a recognized latest native turn", async (t) => {
  const cases = [
    { name: "active", status: "inProgress", expected: { state: "active" } },
    { name: "completed", status: "completed", expected: { state: "terminal", turnOutcome: "completed" } },
    { name: "interrupted", status: "cancelled", expected: { state: "terminal", turnOutcome: "interrupted" } },
    { name: "unknown", status: "futureStatus", expected: null },
  ] as const;
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness();
    const request = spawnRequest();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      client.turnStatus = entry.status;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await request<T>(method, params);
        if (method === "thread/read" && (params as { includeTurns?: boolean } | undefined)?.includeTurns === true) {
          const turns = (result as { thread?: { turns?: Array<Record<string, unknown>> } }).thread?.turns;
          if (turns) turns.unshift({ id: "historical-turn", status: "completed" });
        }
        return result;
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection,
    });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, (event) => observations.push(event));
    const turns = observations.filter((event) => event.fact.domain === "turn");
    assert.equal(turns.length, entry.expected === null ? 0 : 1,
      "reattach reconstructs at most the single latest native turn");
    const turn = turns[0];
    if (entry.expected === null) assert.equal(turn, undefined);
    else {
      assert.ok(turn?.fact.domain === "turn");
      assert.equal(turn.fact.state, entry.expected.state);
      assert.equal("turnOutcome" in entry.expected ? turn.fact.turnOutcome : undefined,
        "turnOutcome" in entry.expected ? entry.expected.turnOutcome : undefined);
      assert.equal(turn.fact.providerContinuationId, first.providerContinuationId);
      assert.equal(turn.fact.providerTurnId, `turn-${first.providerContinuationId}`);
    }
    assert.equal(observations.filter((event) => event.fact.domain === "runtime").length, 1);
    assert.equal(observations.some((event) => event.fact.domain === "turn"
      && event.fact.providerTurnId === "historical-turn"), false);
    assert.equal(subscription.position().latestSequence, 2,
      "recognized turns retain one fact while unreadable latest state leaves an explicit source gap");
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.clients[1]!.requests.some((request) =>
      request.method === "thread/start" || request.method === "turn/start" || request.method === "turn/interrupt"), false);
    subscription.dispose();
  });
});

test("fresh Codex attach never orders a snapshot against queued lifecycle evidence", async (t) => {
  const cases: Array<{ name: string; expectedActive: boolean; expectedTerminal: boolean;
    expectedLatestSequence: number;
    emit(client: FakeRpc, threadId: string, turnId: string): void }> = [
    { name: "typed terminal", expectedActive: false, expectedTerminal: true, expectedLatestSequence: 3,
      emit: (client: FakeRpc, threadId: string, turnId: string) => client.emit({ method: "turn/completed",
        params: { threadId, turnId, turn: { id: turnId, status: "completed" } } }) },
    { name: "unreadable terminal", expectedActive: false, expectedTerminal: false, expectedLatestSequence: 4,
      emit: (client: FakeRpc, threadId: string, turnId: string) => client.emit({ method: "turn/completed",
        params: { threadId, turnId } }) },
    { name: "malformed terminal identity", expectedActive: false, expectedTerminal: false, expectedLatestSequence: 4,
      emit: (client: FakeRpc, threadId: string) => client.emit({ method: "turn/completed",
        params: { threadId } }) },
    { name: "mismatched terminal turn identities", expectedActive: false, expectedTerminal: false,
      expectedLatestSequence: 4,
      emit: (client: FakeRpc, threadId: string, turnId: string) => client.emit({ method: "turn/completed",
        params: { threadId, turnId, turn: { id: `${turnId}-other`, status: "completed" } } }) },
    { name: "terminal after queued start", expectedActive: true, expectedTerminal: true, expectedLatestSequence: 5,
      emit: (client: FakeRpc, threadId: string, turnId: string) => {
        client.emit({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId, status: "inProgress" } } });
        client.emit({ method: "turn/cancelled", params: { threadId, turnId } });
      } },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness();
    const request = spawnRequest();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      client.turnStatus = "inProgress";
      const read = client.request.bind(client);
      let queued = false;
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await read<T>(method, params);
        if (!queued && method === "thread/read"
          && (params as { includeTurns?: boolean } | undefined)?.includeTurns === true) {
          queued = true;
          const turnId = `turn-${first.providerContinuationId}`;
          entry.emit(client, first.providerContinuationId!, turnId);
        }
        return result;
      };
      return client;
    };
    const stream: ProviderStreamEvent[] = [];
    const adapter = new CodexProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: event => stream.push(event),
    });
    const attached = await adapter.attach({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection,
    });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, event => observations.push(event));
    const activeTurns = observations.filter(event => event.fact.domain === "turn" && event.fact.state === "active");
    assert.equal(activeTurns.length, entry.expectedActive ? 1 : 0,
      "only an exact queued start may produce active state; the ambiguous snapshot never does");
    if (entry.expectedActive) assert.equal(activeTurns[0]?.sequence, 4,
      "the queued start remains behind the explicit ambiguity gap");
    assert.equal(observations.filter(event => event.fact.domain === "turn").length,
      (entry.expectedActive ? 1 : 0) + (entry.expectedTerminal ? 1 : 0));
    assert.equal(subscription.position().latestSequence, entry.expectedLatestSequence);
    assert.equal(observations.some(event => event.sequence === 2), false,
      "snapshot/notification coexistence consumes an unavailable source position");
    assert.equal(stream.filter(event => /^turn\/(?:completed|cancelled)$/.test(event.method)).length, 1,
      "the raw sink receives the queued terminal exactly once, even without typed correlation");
    assert.equal(stream.some(event => event.nativeEventId !== undefined), false,
      "notifications consumed before the production raw listener exists are not correlated into shadow comparison");
    assert.equal(observations.some(event => event.fact.nativeEventId !== undefined), false);
    assert.equal(stream.find(event => event.method === "thread/read")?.nativeEventId, undefined,
      "the stale snapshot is not correlated as a lifecycle checkpoint");
    subscription.dispose();
  });
});

test("Codex attach gaps a queued start that may precede a terminal snapshot", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  assert.ok(first.providerConnection);
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.turnStatus = "completed";
    const read = client.request.bind(client);
    let queued = false;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (!queued && method === "thread/read"
        && (params as { includeTurns?: boolean } | undefined)?.includeTurns === true) {
        queued = true;
        const turnId = `turn-${first.providerContinuationId}`;
        client.emit({ method: "turn/started", params: {
          threadId: first.providerContinuationId,
          turnId,
          turn: { id: turnId, status: "inProgress" },
        } });
      }
      return read<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({ workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.deepEqual(observations.map(event => event.sequence), [1, 3, 4],
    "the queued start remains retained but cannot erase the ambiguous response boundary");
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 4 });
  assert.deepEqual(observations.flatMap(event => event.fact.domain === "turn" ? [event.fact.state] : []), ["active"]);
  assert.equal(attached.observedState(), "working", "ambiguous queued activity must not admit an idle restart");
  subscription.dispose();
});

test("queued lifecycle cannot erase unreadable or contradictory Codex attach evidence", async (t) => {
  await t.test("unknown snapshot plus typed start", async () => {
    const harness = createHarness();
    const request = spawnRequest();
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      client.turnStatus = "futureStatus";
      const read = client.request.bind(client);
      let queued = false;
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await read<T>(method, params);
        if (!queued && method === "thread/read" && (params as { includeTurns?: boolean }).includeTurns === true) {
          queued = true;
          const turnId = `turn-${first.providerContinuationId}`;
          client.emit({ method: "turn/started", params: {
            threadId: first.providerContinuationId,
            turnId,
            turn: { id: turnId, status: "inProgress" },
          } });
        }
        return result;
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await adapter.attach({ workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, event => observations.push(event));
    assert.deepEqual(observations.map(event => event.sequence), [1, 3, 4],
      "the queued typed facts remain behind the unreadable snapshot gap");
    assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 4 });
    subscription.dispose();
  });

  await t.test("explicit empty fallback plus unreadable terminal", async () => {
    const harness = createHarness({ threadReadUnmaterialized: true });
    const request = spawnRequest({ deliveryMode: "daemon_inbox" });
    const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
    assert.ok(first.providerConnection);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const read = client.request.bind(client);
      let queued = false;
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        try { return await read<T>(method, params); }
        catch (error) {
          if (!queued && method === "thread/read" && (params as { includeTurns?: boolean }).includeTurns === true) {
            queued = true;
            client.emit({ method: "turn/completed", params: {
              threadId: first.providerContinuationId,
              turnId: `turn-${first.providerContinuationId}`,
            } });
          }
          throw error;
        }
      };
      return client;
    };
    const stream: ProviderStreamEvent[] = [];
    const adapter = new CodexProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: event => stream.push(event),
    });
    const attached = await adapter.attach({ workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
    assertProviderHandle(attached);
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(attached, event => observations.push(event));
    assert.deepEqual(observations.map(event => event.sequence), [1, 4]);
    assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 4 },
      "both the malformed terminal and its contradiction with the empty fallback remain visible as gaps");
    assert.equal(stream.filter(event => event.method === "turn/completed").length, 1);
    subscription.dispose();
  });
});

test("cached Codex attach requires the exact continuation and native connection identity", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const handle = await adapter.spawn(request);
  assert.ok(handle.providerConnection?.kind === "codex_app_server");
  const exactRef = {
    workAttemptId: request.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  };

  assert.equal(await adapter.attach(exactRef), handle);
  assert.equal(await adapter.attach({ ...exactRef, providerContinuationId: "cross-wired-thread" }), null);
  assert.equal(await adapter.attach({ ...exactRef, providerConnection: null }), null);

  const mismatchedConnections: ProviderConnectionRef[] = [
    { ...handle.providerConnection, url: "ws://127.0.0.1:9999" },
    { ...handle.providerConnection, url: "" },
    { ...handle.providerConnection, pid: handle.providerConnection.pid! + 1 },
    { ...handle.providerConnection, pid: null },
    { ...handle.providerConnection, processIdentity: "another-process-birth" },
    { ...handle.providerConnection, processIdentity: null },
    { kind: "claude_cli", pid: handle.providerConnection.pid, processIdentity: handle.providerConnection.processIdentity },
  ];
  for (const providerConnection of mismatchedConnections) {
    assert.equal(await adapter.attach({ ...exactRef, providerConnection }), null);
  }
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.clients.length, 1, "rejected cached refs never contact or launch another endpoint");
});

test("fresh adapter reattaches when only the MCP workplace status probe times out", async () => {
  const harness = createHarness({ workplaceProbeTimesOut: true });
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  assert.ok(first.providerConnection);

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assertProviderHandle(attached);
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(attached.pid, first.pid);
  assert.equal(harness.launches.length, 1);
});

test("reattached RPC disconnect fences the exact child and waits for verified exit", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const terminals: ProviderTerminalPayload[] = [];
  freshAdapter.onExit(attached, (terminal) => terminals.push(terminal));

  assert.equal(harness.dependencies.getProcessIdentity(4100), "fake-process-4100-birth-1");
  harness.clients[1]!.disconnect();
  await flush();

  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.launches[0]?.alive, true);
  assert.equal(terminals.length, 0, "RPC loss alone cannot make a live writer restartable");
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.terminalCause, "crashed");
  assert.equal(attached.observedState(), "failed");
});

test("unverifiable process identity keeps RPC loss ambiguous until actual exit", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const terminals: ProviderTerminalPayload[] = [];
  freshAdapter.onExit(attached, (terminal) => terminals.push(terminal));

  harness.setIdentityObservable(false);
  harness.clients[1]!.disconnect();
  await flush();
  assert.deepEqual(harness.signals, [], "an unverifiable pid must not be signalled");
  assert.equal(terminals.length, 0, "unverifiable liveness must remain restart-blocking");

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();
  assert.equal(terminals.length, 1, "the actual child-exit observation remains authoritative");
});

test("pid-less durable endpoint stays ambiguous even when exact thread RPC succeeds", async () => {
  const healthy = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: healthy.dependencies }).spawn(request);
  const pidlessConnection = { ...first.providerConnection!, pid: null };
  await assert.rejects(new CodexProviderAdapter({ dependencies: healthy.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: pidlessConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(healthy.launches.length, 1);

  const unavailable = createHarness({ threadReadFails: true });
  const unavailableFirst = await new CodexProviderAdapter({
    dependencies: unavailable.dependencies,
  }).spawn(request);
  await assert.rejects(new CodexProviderAdapter({
    dependencies: unavailable.dependencies,
  }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: unavailableFirst.providerContinuationId!,
    providerConnection: { ...unavailableFirst.providerConnection!, pid: null },
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(unavailable.launches.length, 1);
});

test("recycled pid terminalizes the recorded writer without touching the replacement process", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.processIdentity = "fake-process-4100-birth-2";

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assert.ok(attached && "state" in attached);
  assert.equal(attached.state, "terminal");
  assert.equal(attached.terminal.terminalCause, "crashed");
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.clients.length, 1, "a recycled pid is rejected before endpoint contact");
  assert.deepEqual(harness.signals, [], "the replacement process must not be signalled");
});

test("fresh attach fences an unverifiable live app-server instead of allowing a duplicate writer", async () => {
  const harness = createHarness({ threadReadFails: true });
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(harness.launches.length, 1);
});

test("fresh attach proves an empty unmaterialized daemon-inbox thread without launching a second writer", async () => {
  const harness = createHarness({ threadReadUnmaterialized: true });
  const request = spawnRequest({ deliveryMode: "daemon_inbox" });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);

  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(harness.launches.length, 1, "the verified existing writer must be retained");
  assert.equal(harness.clients[1]!.requests.some(entry => entry.method === "thread/resume"), false,
    "an empty thread may have no stored history for resume; preserve metadata-only attachment");
  assert.deepEqual(
    harness.clients[1]!.requests
      .filter((entry) => entry.method === "thread/read")
      .map((entry) => (entry.params as { includeTurns?: boolean }).includeTurns),
    [true, false],
    "metadata-only proof is used only after the exact empty-thread response",
  );
  assert.deepEqual(observations.map(event => event.fact.domain), ["runtime"]);
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 1 },
    "the explicit unmaterialized-empty proof is gap-free, not an unreadable snapshot");
  assert.deepEqual(harness.signals, []);
  subscription.dispose();
});

test("a reattached thread with no turn yet is idle, so it stops reporting work it is not doing", async () => {
  // Shapes the attach read can take for a thread that has never run a turn.
  const cases: Array<{ name: string; read: (threadId: string, includeTurns: boolean | undefined) => unknown; expected: "idle" | "working" }> = [
    { name: "unmaterialized daemon-inbox thread", expected: "idle", read: (threadId, includeTurns) => {
      if (includeTurns !== false) throw new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
      return { thread: { id: threadId, status: { type: "idle" } } };
    } },
    { name: "materialized thread without turns", expected: "idle",
      read: (threadId) => ({ thread: { id: threadId, status: { type: "idle" }, turns: [] } }) },
    { name: "thread that still reports itself active", expected: "working", read: (threadId, includeTurns) => {
      if (includeTurns !== false) throw new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
      return { thread: { id: threadId, status: { type: "active" } } };
    } },
    { name: "thread not loaded in the app-server", expected: "idle",
      read: (threadId) => ({ thread: { id: threadId, status: { type: "notLoaded" }, turns: [] } }) },
    { name: "thread in a system error", expected: "idle",
      read: (threadId) => ({ thread: { id: threadId, status: { type: "systemError" }, turns: [] } }) },
  ];
  for (const testCase of cases) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const first = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method !== "thread/read") return request<T>(method, params);
        client.requests.push({ method, params });
        const input = params as { threadId: string; includeTurns?: boolean };
        return testCase.read(input.threadId, input.includeTurns) as T;
      };
      return client;
    };
    const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
      workAttemptId: first.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
      providerConnection: first.providerConnection,
    });
    assertProviderHandle(attached);
    assert.equal(attached.observedState(), testCase.expected, testCase.name);
    assert.equal(harness.launches.length, 1, `${testCase.name}: the existing writer is kept`);
  }
});

test("fresh and repaired threads retain empty-thread attachment when native default history is unsupported", async () => {
  for (const repair of [false, true]) {
    const harness = createHarness();
    const historyModes = new Map<string, unknown>();
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (serverUrl, notify) => {
      const client = createRpcClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const input = params as { threadId?: string; historyMode?: string; includeTurns?: boolean };
        if (method === "thread/read") {
          client.requests.push({ method, params });
          if (input.includeTurns) {
            if (historyModes.get(input.threadId!) !== "legacy") throw new Error("list_turns is not supported yet");
            throw new Error(`thread ${input.threadId} is not materialized yet; includeTurns is unavailable before first user message`);
          }
          return { thread: { id: input.threadId, status: { type: "idle" }, turns: [] } } as T;
        }
        const result = await request<T>(method, params);
        if (method === "thread/start") {
          historyModes.set((result as { thread: { id: string } }).thread.id, input.historyMode ?? "paginated");
        }
        return result;
      };
      return client;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const launchPolicy = { ...spawnRequest().launchPolicy as Record<string, unknown>, historyMode: "paginated" };
    const first = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", launchPolicy }));
    if (repair) {
      harness.clients[0]!.markThreadMissing(first.providerContinuationId!);
      await adapter.repairContinuation(first, {
        workAttemptId: first.workAttemptId,
        expectedProviderContinuationId: first.providerContinuationId!,
        cwd: spawnRequest().cwd,
        launchPolicy,
      }, { checkpointReplacement: async () => {} });
    }
    const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const attached = await freshAdapter.attach({ workAttemptId: first.workAttemptId,
      providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection });
    assertProviderHandle(attached);
    assert.equal(attached.providerContinuationId, first.providerContinuationId);
    const subscription = freshAdapter.onExecution(attached, () => {});
    assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 1 });
    subscription.dispose();
    assert.equal(harness.launches.length, 1);
    assert.deepEqual(harness.signals, []);
    assert.equal(harness.clients[1]!.requests.some(entry => entry.method === "thread/resume"), false);
  }
});

test("unsupported paginated history cannot become empty-thread attachment or idle proof", async () => {
  const harness = createHarness();
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/read" && (params as { includeTurns?: boolean }).includeTurns) {
        client.requests.push({ method, params });
        throw new Error("list_turns is not supported yet");
      }
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const first = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(freshAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection }),
  /attach is ambiguous.*list_turns is not supported yet/);
  assert.deepEqual(await adapter.inspectTurnBoundary(first), { state: "unknown" });
  await assert.rejects(adapter.recoverRoomTurn(first, { inboxItemId: "retained-inbox", providerTurnId: "retained-turn" }),
    /list_turns is not supported yet/);
  assert.equal(harness.clients.some(client => client.requests.some(entry => entry.method === "turn/start")), false);
  assert.equal(harness.clients[1]!.requests.some(entry => entry.method === "thread/read"
    && (entry.params as { includeTurns?: boolean }).includeTurns === false), false);
  assert.equal(harness.launches.length, 1);
  assert.deepEqual(harness.signals, []);
});

test("missing-continuation attach remains gap-free across same-process repair", async () => {
  const harness = createHarness();
  const request = spawnRequest({ deliveryMode: "daemon_inbox" });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  assert.ok(first.providerConnection);
  const createRpcClient = harness.dependencies.createRpcClient;
  harness.dependencies.createRpcClient = (serverUrl, notify) => {
    const client = createRpcClient(serverUrl, notify) as FakeRpc;
    client.markThreadMissing(first.providerContinuationId!);
    const request = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/read") throw new Error(`thread not found: ${first.providerContinuationId}`);
      return request<T>(method, params);
    };
    return client;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await adapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assertProviderHandle(attached);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(attached, event => observations.push(event));
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 1 });
  const repaired = await adapter.repairContinuation!(attached, {
    workAttemptId: request.workAttemptId,
    expectedProviderContinuationId: first.providerContinuationId!,
    cwd: request.cwd,
    launchPolicy: request.launchPolicy,
  }, { checkpointReplacement: async () => {} });
  assert.equal(repaired.outcome, "replaced");
  const replacement = repaired.replacementProviderContinuationId;
  harness.clients[1]!.emit({ method: "turn/started", params: {
    threadId: replacement,
    turnId: `turn-${replacement}`,
    turn: { id: `turn-${replacement}`, status: "inProgress" },
  } });
  assert.deepEqual(subscription.position(), { firstRetainedSequence: 1, latestSequence: 3 },
    "repair continues the original exact source without inheriting a permanent gap");
  assert.equal(observations.some(event => event.fact.domain === "turn"
    && event.fact.providerContinuationId === replacement), true);
  assert.equal(harness.launches.length, 1);
  subscription.dispose();
});

test("fresh attach returns terminal evidence when the recorded app-server is verifiably gone", async () => {
  const harness = createHarness({ threadReadFails: true });
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assert.ok(attached && "state" in attached);
  assert.equal(attached.state, "terminal");
  assert.equal(attached.terminal.terminalCause, "crashed");
  assert.equal(attached.terminal.providerContinuationId, first.providerContinuationId);
  assert.equal(harness.clients.length, 1, "a proven-absent process is rejected before endpoint contact");
  assert.deepEqual(harness.signals, [], "a proven-absent process is never signalled");
});

test("resume capability fails honestly when app-server lacks thread/resume", async () => {
  const harness = createHarness({ resumeSupported: false });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await adapter.spawn(request);

  assert.equal(
    adapter.capabilities().resume,
    true,
    "fresh thread/start cannot safely infer resume support without a real continuation",
  );
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await assert.rejects(
    adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
    }, request),
    /bounded recovery must start a fresh generation/,
  );
  assert.equal(adapter.capabilities().resume, false);
});

test("cold resume explains an exact saved-thread writer conflict without replacing or interrupting its owner", async () => {
  for (const exact of [true, false]) {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest();
    const first = await adapter.spawn(request);
    harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await flush();
    const nativeError = new Error(`thread ${exact ? first.providerContinuationId : "another-thread"} already has an active writer`);
    const createRpcClient = harness.dependencies.createRpcClient;
    harness.dependencies.createRpcClient = (...args) => {
      const client = createRpcClient(...args) as FakeRpc;
      const original = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "thread/resume") {
          client.requests.push({ method, params });
          throw nativeError;
        }
        return original<T>(method, params);
      };
      return client;
    };
    const resumedAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await assert.rejects(resumedAdapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
    }, request), (error: unknown) => {
      assert.ok(error instanceof Error);
      if (exact) {
        assert.match(error.message, /saved Codex conversation is being used by another running Codex session/);
        assert.match(error.message, /Resume this agent after that session has stopped/);
        assert.equal(error.cause, undefined, "raw provider errors must not leak back into the UI");
        assert.equal("transientProviderStart" in error, false);
        assert.equal("providerRuntimeGone" in error, false);
      } else assert.equal(error, nativeError, "an unrelated thread error keeps its original meaning");
      return true;
    });
    assert.equal(resumedAdapter.capabilities().resume, true);
    assert.equal(harness.launches.length, 2, "no fallback or replacement runtime is launched");
    assert.deepEqual(harness.signals, [{ pid: 4101, signal: "SIGTERM" }], "only the failed new launch is stopped");
    assert.equal(harness.clients[1]!.closed, true);
    assert.deepEqual(harness.clients[1]!.requests.filter(({ method }) => /^(thread|turn)\/(start|resume)$/.test(method))
      .map(({ method }) => method), ["thread/resume"], "no new thread or model turn starts");
    assert.equal((requestByMethod(harness.clients[1]!, "thread/resume").params as { threadId: string }).threadId, first.providerContinuationId);
  }
});
