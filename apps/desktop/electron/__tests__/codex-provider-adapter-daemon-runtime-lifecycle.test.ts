import "./isolated-home.js";
import assert from "node:assert/strict";
import { supervisedAgentTest as test } from "./platform.js";
import { CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import {
  ProviderActionPortRouter,
  createHarness,
  spawnRequest,
  flush,
  codexDaemonFixture,
  applySavedSettings,
  switchOwnerSetupAndApply,
  attachedAsIsolated,
  convergeAcrossExit,
  answerOnReplacement,
  EXIT_RECORDING_FAULTS,
  executionRecord,
} from "./codex-provider-adapter.fixture.js";

for (const variant of ["", ", with an execution-capture gap from before", ", while it holds a task lease"] as const) test(`a real daemon keeps a Codex agent answering after its provider refuses two turns${variant}`, async () => {
  const refusal = "The provider refused this turn. Try rephrasing your request.";
  const priorGap = variant.includes("gap");
  const heldTask = variant.includes("task lease");
  const agent = await codexDaemonFixture(heldTask
    ? { ownedTasks: [{ id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 }] } : {});
  try {
    const observer = () => agent.read<{ last: number; max: number }>(
      "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0];
    if (priorGap) {
      // A terminal notification the adapter cannot attribute consumes a source
      // position without a fact: the capture lane has a gap from here on.
      agent.client.emit({ method: "turn/completed", params: {
        threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
      } });
      await agent.eventually(() => { const row = observer(); return Boolean(row && row.max > row.last); }, "the capture gap is durable");
    }

    // With a task lease held, a note that the task was not continued follows the reason.
    const reason = (row: { last_error: string | null }) => heldTask ? row.last_error?.slice(0, refusal.length) : row.last_error;
    assert.equal(reason(await agent.deliver(1, { refusal })), refusal, "the first refusal settles with the provider's reason");
    assert.equal(reason(await agent.deliver(2, { refusal })), refusal, "so does the second");
    await agent.deliver(3, { answer: "Answer 3." });
    if (heldTask) {
      const rows = await agent.receipts();
      assert.deepEqual(rows.map((row) => [row.source_message_id, row.state]),
        [["msg_1", "acknowledged_failed"], ["msg_2", "acknowledged_failed"], ["msg_3", "acknowledged"]],
        "no blocked task follow-up was queued in front of the next message");
      assert.ok(rows[1]!.last_error?.startsWith(refusal), "the provider's reason stays on the refused message");
    }
    assert.deepEqual(agent.published, ["Answer 3."], "the next message is delivered and answered without a person");
    assert.deepEqual(agent.read<{ activation_json: string }>("SELECT activation_json FROM supervised_agent_inbox WHERE agent_id=? ORDER BY fifo_sequence")
      .map((row) => Object.hasOwn(JSON.parse(row.activation_json), "task_continuity_refusal")), [false, false, false],
      "no refusal mark is left on a settled message");

    assert.equal(agent.harness.launches.length, 1, "the same app-server served every turn");
    assert.deepEqual(agent.harness.signals, [], "the runtime was never stopped");
    const current = await agent.view();
    assert.equal(current.condition, "none", current.last_error ?? "");
    assert.ok(["idle", "working"].includes(current.observed_state), current.observed_state);
    assert.equal(current.room_agent_state.connection.state, "connected");
    assert.equal(current.room_agent_state.inbox.state, "empty");
    if (priorGap) {
      const row = observer()!;
      assert.ok(row.max > row.last, "the earlier gap is still there; delivery did not depend on closing it");
    } else {
      await agent.eventually(() => agent.read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM execution_turns WHERE agent_id=? AND state='terminal'")[0]!.n === 3, "the capture records every turn");
      assert.deepEqual(agent.read<{ provider_turn_id: string; state: string }>(
        "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,provider_turn_id"), [
        { provider_turn_id: "turn-1", state: "terminal" },
        { provider_turn_id: "turn-2", state: "terminal" },
        { provider_turn_id: "turn-3", state: "terminal" },
      ], "the real shadow store accepted each turn; none was lost");
      const row = observer()!;
      assert.equal(row.max, row.last, "the capture lane has no gap");
      await agent.eventually(() => agent.read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM execution_message_attempts WHERE agent_id=? AND conclusion IS NOT NULL")[0]!.n === 3, "every attempt settles");
      assert.deepEqual(agent.read<{ source_message_id: string; conclusion: string | null }>(
        "SELECT source_message_id,conclusion FROM execution_message_attempts WHERE agent_id=? ORDER BY created_at_ms"), [
        { source_message_id: "msg_1", conclusion: "failed" },
        { source_message_id: "msg_2", conclusion: "failed" },
        { source_message_id: "msg_3", conclusion: "replied" },
      ]);
    }
  } finally {
    await agent.cleanup();
  }
});

test("convergence and heartbeats between a thread's systemError and its turn's ending leave the turn alone", async () => {
  const refusal = "The provider refused this turn. Try rephrasing your request.";
  const agent = await codexDaemonFixture();
  try {
    // A capture gap, so nothing could replace a runtime that was stopped here.
    agent.client.emit({ method: "turn/completed", params: {
      threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
    } });
    const row = await agent.deliver(1, { refusal, beforeEnding: async () => {
      // Eight heartbeats and two explicit passes while the turn has not ended.
      agent.converge();
      await new Promise((resolve) => setTimeout(resolve, 400));
      agent.converge();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(agent.harness.signals, [], "the runtime is not stopped under its turn");
    } });
    assert.equal(row.last_error, refusal);
    await agent.deliver(2, { answer: "Answer 2." });
    assert.deepEqual(agent.published, ["Answer 2."]);
    assert.equal(agent.harness.launches.length, 1);
    assert.deepEqual(agent.harness.signals, []);
  } finally {
    await agent.cleanup();
  }
});

test("a runtime that ends under a turn is retired only after the turn's delayed result is saved", async () => {
  const reason = "The provider failed this turn.";
  const agent = await codexDaemonFixture();
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id),
      "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });

    // The runtime itself ends, without its process exiting, under the turn.
    agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });
    // Eight heartbeats and two explicit passes before the provider reports the turn.
    agent.converge();
    await new Promise((resolve) => setTimeout(resolve, 400));
    agent.converge();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(agent.harness.signals, [], "the runtime is not stopped before its turn's result is saved");
    assert.equal((await agent.receipt("msg_1"))?.last_error ?? null, null, "and the turn is still open");

    // The delayed terminal event.
    Object.assign(turn, { status: "failed", error: { message: reason } });
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles");
    assert.equal((await agent.receipt("msg_1"))?.last_error, reason, "with the provider's own reason");
    await agent.eventually(() => agent.harness.signals.length === 1, "the ended runtime is stopped once its turn is recorded");

    // Its replacement serves the same conversation and answers the next message.
    await agent.eventually(() => agent.harness.clients.length === 2, "the runtime is replaced");
    const successor = agent.harness.clients[1]!;
    agent.serveThread(successor);
    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id),
      "msg_2 starts its own turn on the replacement");
    const next = agent.turns[1]!;
    successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: next.id, turn: { id: next.id, status: "inProgress" } } });
    Object.assign(next, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: next.id, turn: next } });
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.deepEqual(agent.published, ["Answer 2."]);
    assert.deepEqual((await agent.receipts()).map((row) => [row.source_message_id, row.state]),
      [["msg_1", "acknowledged_failed"], ["msg_2", "acknowledged"]], "the failed turn was never run again");
    assert.equal(agent.turns.length, 2);
    assert.equal(agent.harness.launches.length, 2, "one replacement");
  } finally {
    await agent.cleanup();
  }
});

test("an ended runtime whose turn can no longer be recorded is left until the provider finishes it, and retired when the bounded wait runs out", async () => {
  const reason = "The provider failed this turn.";
  // The launch's bearer falls due for rotation fifteen seconds after it is
  // minted; a rotation then gets a new session, as the room gives when the
  // earlier one has ended. The lane that started a turn under the earlier
  // session has no authority left to record it.
  const agent = await codexDaemonFixture({ mint: (mints) => mints === 1 ? { expiresInMs: 75_000 } : { newSession: true } });
  try {
    await agent.eventually(async () => (await agent.view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    // A capture gap: no fact tells the entry that its runtime ended, so the
    // heartbeat keeps rotating its bearer.
    agent.client.emit({ method: "turn/completed", params: {
      threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
    } });
    await agent.eventually(() => {
      const row = agent.read<{ last: number; max: number }>(
        "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0];
      return Boolean(row && row.max > row.last);
    }, "the capture gap is durable");
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id),
      "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });

    // Fifteen seconds pass: the bearer is due, and half the wait for the turn is left.
    agent.passTime(15_000);
    await agent.eventually(() => agent.mints() === 2, "the rotation mints a new session under the turn");
    // Eight heartbeats with the lane torn down and the provider still working.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(agent.harness.signals, [], "the runtime is not stopped while its message is in flight");

    // The provider finishes the turn and records its ending in the thread.
    Object.assign(turn, { status: "failed", error: { message: reason } });
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(agent.harness.signals, [], "nor before the bounded wait for that message has run out");
    assert.equal((await agent.receipt("msg_1"))?.state, "dispatching", "nothing here could record the turn");

    // The wait runs out: the runtime is retired, once, with the turn's ending
    // already in the provider's own record for the replacement to read.
    agent.passTime(31_000);
    agent.converge();
    await agent.eventually(() => agent.harness.signals.length === 1, "the ended runtime is stopped when the wait runs out");
    const row = await agent.receipt("msg_1");
    assert.equal(row?.provider_turn_id, "turn-1", "the message keeps its exact turn");
    assert.equal(agent.turns.length, 1, "and that turn is never run again");
  } finally {
    await agent.cleanup();
  }
});

test("a failed turn whose turn/completed never arrives is settled from the thread after a stated wait, and the next message runs", async () => {
  const reason = "The provider refused this turn.";
  const agent = await codexDaemonFixture();
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id),
      "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    const sleepsBefore = agent.harness.sleeps.length;
    // The app-server fails the turn and reports the thread; its turn/completed is lost.
    Object.assign(turn, { status: "failed", error: { message: reason, codexErrorInfo: "unauthorized" } });
    // Reported twice, as a reconnecting client can see it: still one read.
    for (let report = 0; report < 2; report += 1) {
      agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "systemError" } } });
    }
    agent.client.emit({ method: "error", params: { ...identity, willRetry: false, error: turn.error } });

    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles without its turn/completed");
    assert.equal((await agent.receipt("msg_1"))?.last_error, reason, "with the provider's reason, read from the thread");
    assert.deepEqual(agent.harness.sleeps.slice(sleepsBefore), [2_000], "after one stated wait, not a poll");
    await agent.eventually(async () => (await agent.view()).observed_state === "idle", "the agent is idle again", 5_000).catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });

    // The lost notification turns up after all: it repeats what the thread
    // already said, and execution capture takes it without a gap.
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await agent.turnsRecorded(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const observer = agent.read<{ last: number; max: number }>(
      "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
    assert.equal(observer.max, observer.last, "the capture lane has no gap");
    assert.equal((await agent.receipt("msg_1"))?.state, "acknowledged_failed");

    await agent.deliver(2, { answer: "Answer 2." });
    assert.deepEqual(agent.published, ["Answer 2."]);
    assert.equal(agent.harness.launches.length, 1, "on the same runtime");
    assert.deepEqual(agent.harness.signals, []);
  } finally {
    await agent.cleanup();
  }
});

for (const lastTurn of ["answered", "refused"] as const) test(`an app update replaces the runtime of an agent whose last turn was ${lastTurn}, and its next message is delivered`, async () => {
  const agent = await codexDaemonFixture();
  try {
    if (lastTurn === "refused") await agent.deliver(1, { refusal: "The provider refused this turn." });
    else await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    agent.updateApp();

    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(() => agent.harness.clients.length === 2, "the runtime launched by the old app is replaced", 10_000).catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: msg_2 is ${(await agent.receipt("msg_2"))?.state}; agent is ${current.observed_state}/${current.condition} (${current.last_error}); inbox ${current.room_agent_state.inbox.state}`);
    });
    const successor = agent.harness.clients[1]!;
    agent.serveThread(successor);
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id),
      "msg_2 starts its turn on the replacement");
    const next = agent.turns[1]!;
    successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: next.id, turn: { id: next.id, status: "inProgress" } } });
    Object.assign(next, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: next.id, turn: next } });
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.equal(agent.published.at(-1), "Answer 2.");
    assert.equal(agent.harness.launches.length, 2, "one replacement");
  } finally {
    await agent.cleanup();
  }
});

for (const exit of ["in the same tick it is signalled", "a moment after it is signalled"] as const) for (const lastTurn of ["refused", "answered"] as const) {
  test(`an agent that still runs with its owner's setup after ${lastTurn === "refused" ? "a refused" : "an answered"} turn is replaced without it when the owner turns the setup off, and takes its next message (the stopped process exits ${exit})`, async () => {
    const agent = await codexDaemonFixture({ ownerSetup: true, ...(exit === "a moment after it is signalled" ? { exitAfterMs: 10 } : {}) });
    try {
      assert.equal(agent.harness.launchOptions[0]?.options.homeHarness, true, "the runtime was started with the owner's setup");
      if (lastTurn === "refused") await agent.deliver(1, { refusal: "The provider refused this turn." });
      else await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      // The owner acts a moment after the turn, not within the same millisecond.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // After a refusal the thread is in systemError. The switch replaces the
      // runtime as it does after an answered turn: as soon as the agent is idle.
      const off = await agent.setOwnerSetup(false);
      assert.equal(off.ok, true, off.error);
      await agent.eventually(() => agent.harness.signals.length === 1, "the runtime that has the setup is stopped");
      await agent.eventually(() => agent.harness.launches.length === 2, "a replacement is started").catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
      });
      assert.notEqual(agent.harness.launchOptions[1]?.options.homeHarness, true, "and it runs without the owner's setup");
      assert.equal(agent.turns.length, 1, "no turn ran on the runtime that still had the setup");

      await agent.eventually(() => agent.harness.clients.length === 2, "the replacement is up");
      await answerOnReplacement(agent, 2);
      assert.equal(agent.published.at(-1), "Answer 2.", "the next message is delivered and answered by the replacement");
      assert.equal(agent.harness.launches.length, 2, "one replacement");
      // Delivery alone does not show that the stopped process's exit was
      // settled before the agent was converged: what is recorded does.
      assert.deepEqual((await agent.transitionCauses()).filter((cause) => /provider terminal|attachable/.test(cause)),
        ["provider terminal completed intentional configuration replacement"],
        "the stopped process's exit is recorded once, as the replacement it was");
      assert.deepEqual(executionRecord(agent).boundaries(), [], "and nothing had to be archived for the agent to carry on");
    } finally {
      await agent.cleanup();
    }
  });
}

test("a daemon restart does not make a runtime that has the owner's setup look isolated: it is attached as it is, and turning the setup off during a turn still replaces it afterwards", async () => {
  const agent = await codexDaemonFixture();
  try {
    assert.notEqual(agent.harness.launchOptions[0]?.options.homeHarness, true, "the agent was created isolated");
    await switchOwnerSetupAndApply(agent, true, 2);
    assert.equal(agent.harness.launchOptions[1]?.options.homeHarness, true, "the restart that applied the switch started the runtime with the owner's setup");
    await agent.eventually(() => agent.holdsOwnerSetup(), "the daemon records the new runtime as having the owner's setup");

    // The daemon ends and a new one finds the runtime still running.
    await agent.restartDaemon();
    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's runtime");
    assert.equal(agent.harness.launches.length, 2, "nothing was started in its place");
    assert.equal(agent.holdsOwnerSetup(), true, "the new daemon records that this runtime has the owner's setup");
    assert.equal(attachedAsIsolated(agent), false, "and so does not ask it to list its MCP servers, which makes Codex read the project's config again");

    // A turn is running when the owner turns the setup off: the runtime cannot be replaced yet.
    const attached = agent.harness.clients.at(-1)!;
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    attached.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
    const off = await agent.setOwnerSetup(false);
    assert.equal(off.result?.outcome, "updated", off.error ?? off.result?.error);
    assert.equal(off.result?.apply, "busy_active_turn", "the turn is not interrupted");
    assert.equal(agent.harness.launches.length, 2);

    // When the turn ends, the daemon replaces the runtime before it takes another turn.
    Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 1." }] });
    attached.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    attached.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: turn.id, turn } });
    await agent.eventually(() => agent.harness.launches.length === 3, "a replacement without the owner's setup is started").catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); signals ${JSON.stringify(agent.harness.signals)}`);
    });
    assert.notEqual(agent.harness.launchOptions[2]?.options.homeHarness, true);
    assert.equal(agent.harness.signals.filter((signal) => signal.pid === agent.harness.launches[1]!.pid).length, 1, "the runtime that had the setup was stopped");
    await agent.eventually(() => agent.harness.clients.length === 4, "the replacement is up");
    await answerOnReplacement(agent, 2);
    assert.equal(agent.turns.length, 2, "the next message ran on the replacement, and no turn ran on the runtime that still had the setup");
  } finally {
    await agent.cleanup();
  }
});

test("a daemon restart while a turn runs on a runtime whose owner has since turned the setup off: the new daemon still ends that runtime when the turn is over", async () => {
  const agent = await codexDaemonFixture();
  try {
    await switchOwnerSetupAndApply(agent, true, 2);
    await agent.eventually(() => agent.holdsOwnerSetup(), "the daemon records the new runtime as having the owner's setup");
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    agent.harness.clients.at(-1)!.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
    const off = await agent.setOwnerSetup(false);
    assert.equal(off.result?.apply, "busy_active_turn", "the turn is not interrupted, so the runtime keeps the setup for now");

    await agent.restartDaemon();
    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's runtime");
    assert.equal(agent.holdsOwnerSetup(), true, "the new daemon records that this runtime still has the owner's setup");
    assert.equal(agent.harness.launches.length, 2);

    const attached = agent.harness.clients.at(-1)!;
    Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 1." }] });
    attached.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    attached.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: turn.id, turn } });
    await agent.eventually(() => agent.harness.launches.length === 3, "a replacement without the owner's setup is started");
    assert.notEqual(agent.harness.launchOptions[2]?.options.homeHarness, true);
    await agent.eventually(() => agent.harness.clients.length === 4, "the replacement is up");
    await answerOnReplacement(agent, 2);
    assert.equal(agent.turns.length, 2, "no turn ran on the runtime that still had the setup after it was turned off");
  } finally {
    await agent.cleanup();
  }
});

test("a daemon restart does not make an isolated runtime look like one with the owner's setup, after the setup was turned on and off again", async () => {
  const agent = await codexDaemonFixture();
  try {
    await switchOwnerSetupAndApply(agent, true, 2);
    await switchOwnerSetupAndApply(agent, false, 3);
    assert.notEqual(agent.harness.launchOptions[2]?.options.homeHarness, true, "the runtime in place is isolated");
    await agent.eventually(() => agent.holdsRuntime(), "the daemon holds the replacement");
    assert.equal(agent.holdsOwnerSetup(), false);

    await agent.restartDaemon();
    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's runtime");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(agent.holdsOwnerSetup(), false, "the new daemon records it as isolated");
    assert.equal(attachedAsIsolated(agent), true, "and checks it as any isolated runtime is checked");
    assert.equal(agent.harness.launches.length, 3, "and does not replace a runtime that has nothing to end");
    assert.equal(agent.harness.signals.filter((signal) => signal.pid === agent.harness.launches[2]!.pid).length, 0);
  } finally {
    await agent.cleanup();
  }
});

test("a daemon restart keeps a runtime isolated while the owner's setup is saved on but has not been applied, and the restart that applies it starts the owner's setup", async () => {
  const agent = await codexDaemonFixture();
  try {
    const on = await agent.setOwnerSetup(true);
    assert.equal(on.result?.outcome, "updated", on.error ?? on.result?.error);
    await agent.restartDaemon();
    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's runtime");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(agent.holdsOwnerSetup(), false, "the runtime started without the setup, whatever is saved");
    assert.equal(attachedAsIsolated(agent), true);
    assert.equal(agent.harness.launches.length, 1, "the saved switch waits for the owner's restart");

    const applied = await applySavedSettings(agent);
    assert.equal(applied.result?.outcome, "restarting", applied.error ?? JSON.stringify(applied.result));
    await agent.eventually(() => agent.harness.launches.length === 2, "the restart starts a new runtime");
    assert.equal(agent.harness.launchOptions[1]?.options.homeHarness, true);
    await agent.eventually(() => agent.holdsOwnerSetup(), "the daemon records the new runtime as having the owner's setup");
  } finally {
    await agent.cleanup();
  }
});

test("an agent paused and resumed after a refused turn is replaced, and its next message is delivered", async () => {
  const agent = await codexDaemonFixture();
  const snap = async () => { const current = await agent.view(); return `agent is ${current.observed_state}/${current.condition} (${current.last_error}); launches ${agent.harness.launches.length}; signals ${JSON.stringify(agent.harness.signals)}`; };
  try {
    await agent.deliver(1, { refusal: "The provider refused this turn." });
    await agent.turnsRecorded(1);
    assert.equal((await agent.request("manifest.set_desired_state", { id: agent.id, desired_state: "paused" })).ok, true);
    await agent.eventually(async () => (await agent.view()).observed_state === "paused", "the agent pauses").catch(async (error) => { throw new Error(`${(error as Error).message}: ${await snap()}`); });
    assert.equal(agent.harness.signals.length, 1, "pausing stops the runtime whose thread is in systemError");
    assert.equal((await agent.request("manifest.set_desired_state", { id: agent.id, desired_state: "running" })).ok, true);
    await agent.eventually(() => agent.harness.clients.length === 2, "resuming starts a runtime").catch(async (error) => { throw new Error(`${(error as Error).message}: ${await snap()}`); });
    const successor = agent.harness.clients[1]!;
    agent.serveThread(successor);

    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2",
      activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id),
      "msg_2 starts its turn on the resumed runtime").catch(async (error) => { throw new Error(`${(error as Error).message}: msg_2 is ${(await agent.receipt("msg_2"))?.state}; ${await snap()}`); });
    const next = agent.turns[1]!;
    successor.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: next.id, turn: { id: next.id, status: "inProgress" } } });
    Object.assign(next, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    successor.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    successor.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: next.id, turn: next } });
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.equal(agent.published.at(-1), "Answer 2.");
  } finally {
    await agent.cleanup();
  }
});

for (const runtime of ["healthy", "ended"] as const) for (const room of ["ends the agent's session", "still accepts the agent"] as const) {
  if (runtime === "healthy" && room === "still accepts the agent") continue;
  test(`${runtime === "ended" ? "an ended" : "a healthy"} runtime whose room ${room}: ${room === "still accepts the agent" ? "the runtime is replaced" : "no new session and no new runtime"}`, async () => {
    const { ROOM_REFUSED_ACCESS_DETAIL } = await import(new URL("../../daemon/supervised-agent-delivery.ts", import.meta.url).href);
    const agent = await codexDaemonFixture();
    try {
      // A capture gap: no fact will tell the entry that its runtime ended,
      // which is the ending this change newly recovers by replacing the runtime.
      agent.client.emit({ method: "turn/completed", params: {
        threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" },
      } });
      await agent.eventually(() => {
        const row = agent.read<{ last: number; max: number }>(
          "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0];
        return Boolean(row && row.max > row.last);
      }, "the capture gap is durable");
      const mintsBefore = agent.mints();
      assert.equal(mintsBefore, 1, "the launch's own session");

      if (room === "ends the agent's session") {
        // What a room admin's disconnect looks like from here: the bearer is
        // refused, and the grant that minted it would mint again if asked.
        agent.endRoomSession();
        await agent.eventually(async () => (await agent.view()).room_agent_state.ingress.state === "blocked", "the owner sees the refusal");
      }
      if (runtime === "ended") agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });

      if (room === "still accepts the agent") {
        await agent.eventually(() => agent.harness.signals.length === 1, "the ended runtime is stopped for its replacement");
        return;
      }
      // Thirty heartbeats, with the refused poll retried throughout.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(agent.mints(), mintsBefore, "no session is minted");
      assert.equal(agent.harness.launches.length, 1, "no runtime is launched");
      assert.deepEqual(agent.harness.signals, [], "and none is stopped");
      const current = await agent.view();
      assert.deepEqual([current.room_agent_state.ingress.state, current.room_agent_state.ingress.detail],
        ["blocked", ROOM_REFUSED_ACCESS_DETAIL], "the owner is told the room refused the agent, not that it is reconnecting");
    } finally {
      await agent.cleanup();
    }
  });
}

test("an ended runtime whose room access was refused is not minted for again on every heartbeat", async () => {
  const { SupervisorGrantRequestError } = await import(new URL("../../daemon/cloud-http.ts", import.meta.url).href);
  // The launch's bearer is due for rotation at once, and the room refuses
  // every later mint: the agent ends up with no room binding.
  const agent = await codexDaemonFixture({
    mint: (mints) => mints === 1 ? { expiresInMs: 30_000 } : new SupervisorGrantRequestError(403, "Worker session mint"),
  });
  try {
    await agent.eventually(async () => /Use Reconnect/.test((await agent.view()).last_error ?? ""),
      "room access is given up after its bounded attempts", 30_000);
    // The runtime itself now ends without its process exiting.
    agent.client.emit({ method: "process/systemError", params: { status: "systemError" } });
    // The failure itself is reconciled once; let that settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settledMints = agent.mints();
    // Thirty heartbeats. Each used to send convergence to mint once more.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(agent.mints(), settledMints, "no heartbeat mints for an agent that has no room binding");
    const current = await agent.view();
    assert.equal(current.condition, "coordination_blocked");
    assert.match(current.last_error ?? "", /Use Reconnect/, "the owner still sees how to restore it");
  } finally {
    await agent.cleanup();
  }
});

for (const launchPolicy of ["without", "with"] as const) test(`the router does not hand back a runtime whose process has exited, ${launchPolicy} a launch policy on the attach`, async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const request = spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" });
  const handle = await router.spawn({ ...request, provider: "codex" });
  // What the daemon attaches with. An attach carries the launch policy only
  // while the saved configuration is the one the runtime was started with.
  const ref = {
    workAttemptId: request.workAttemptId, provider: "codex", providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection, lifecycleAuthorityMode: "typed" as const,
    ...(launchPolicy === "with" ? { launchPolicy: request.launchPolicy } : {}),
  };
  const live = await router.attach(ref);
  assert.ok(live && !("state" in live), "a running process is attached from memory");
  assert.equal(live.pid, handle.pid);

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();
  const attached = await router.attach(ref);
  assert.ok(attached && "state" in attached && attached.state === "terminal",
    "the adapter answers that the process is gone; the remembered handle is not attached again");
  assert.deepEqual(attached.terminal.nativeRuntimeDeath,
    { kind: "codex_app_server", pid: handle.pid, processIdentity: handle.providerConnection!.processIdentity });
  assert.equal(harness.launches.length, 1, "and nothing is started");
});

test("a convergence pass that runs while a configuration change's exit is being settled does not take the exited runtime back", async () => {
  const agent = await codexDaemonFixture({ holdExits: true });
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);

    // The owner changes a setting and restarts the agent to apply it: its idle runtime is stopped.
    const applied = agent.changeEffortAndRestart();
    await agent.eventually(() => agent.harness.signals.length === 1, "the runtime with the old setting is asked to stop");
    await convergeAcrossExit(agent, () => agent.exitProcess(0));
    const answer = await applied;
    assert.equal(answer.result?.outcome, "restarting", answer.error);
    const entry = (await agent.request("manifest.list")).result[0] as { reconciliation?: { exit_timestamps_ms?: number[] } };
    assert.deepEqual(entry.reconciliation?.exit_timestamps_ms ?? [], [], "a restart the owner asked for is not counted as a crash");
    assert.deepEqual((await agent.transitionCauses()).filter((cause) => /provider terminal|attachable/.test(cause)),
      ["provider terminal completed intentional configuration replacement"],
      "the exit is recorded once, as the replacement it was, and the agent is never reported as blocked");

    await agent.eventually(() => agent.harness.clients.length === 2, "the runtime is replaced").catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });
    await answerOnReplacement(agent, 2);
    assert.equal(agent.published.at(-1), "Answer 2.");
    assert.equal(agent.harness.launches.length, 2, "one replacement");
    const observer = agent.read<{ last: number; max: number }>(
      "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
    assert.equal(observer.max, observer.last, "the replacement's activity is recorded without a gap");
    assert.deepEqual(agent.read<{ provider_turn_id: string; state: string }>(
      "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,provider_turn_id"), [
      { provider_turn_id: "turn-1", state: "terminal" },
      { provider_turn_id: "turn-2", state: "terminal" },
    ], "both turns are in the record");
  } finally {
    await agent.cleanup();
  }
});

test("a convergence pass that runs while a crash is being settled starts no replacement until the crash is recorded", async () => {
  const agent = await codexDaemonFixture({ holdExits: true });
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);

    await convergeAcrossExit(agent, () => agent.exitProcess(0, "SIGKILL"));
    await agent.eventually(() => agent.harness.clients.length === 2, "the crashed runtime is replaced").catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });
    const entry = (await agent.request("manifest.list")).result[0] as {
      reconciliation?: { exit_timestamps_ms?: number[]; last_terminal?: { terminal_cause?: string } };
    };
    assert.deepEqual((await agent.transitionCauses()).filter((cause) => /provider terminal|attachable/.test(cause)),
      ["provider terminal: crashed"],
      "the crash is recorded once, and the agent is never reported as blocked on a runtime that cannot be attached");
    assert.equal(entry.reconciliation?.exit_timestamps_ms?.length, 1, "the crash counts toward the agent's crash-loop limit");
    assert.equal(entry.reconciliation?.last_terminal?.terminal_cause, "crashed", "and the owner can see how the runtime ended");
    await answerOnReplacement(agent, 2);
    assert.equal(agent.published.at(-1), "Answer 2.");
    assert.equal(agent.harness.launches.length, 2, "one replacement");
  } finally {
    await agent.cleanup();
  }
});

for (const [fault, inject] of Object.entries(EXIT_RECORDING_FAULTS)) {
  test(`an agent whose crash cannot be recorded because ${fault} is started again after a bounded wait, answers its next message, and tells its owner`, async () => {
    const { EXIT_UNSETTLED_NOTICE } = await import(new URL("../../daemon/provider-terminal-coordinator.ts", import.meta.url).href);
    const agent = await codexDaemonFixture({ holdExits: true });
    let endFault = () => {};
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      const terminals = agent.exitSettlement();
      // Fifteen seconds, eight and four outside tests.
      terminals.bounds = { settleMs: 600, lastAttemptMs: 400, recordMs: 200 };
      endFault = inject(terminals);

      const crashedAt = Date.now();
      agent.exitProcess(0, "SIGKILL");
      await agent.eventually(() => !agent.holdsRuntime() && terminals.settling(agent.id), "the daemon lets go of the exited runtime and starts recording its exit");
      agent.converge();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(agent.harness.launches.length, 1, "while the exit may still be recorded, no replacement is started");
      assert.equal(terminals.settling(agent.id), true);

      await agent.eventually(() => agent.harness.clients.length === 2, "the agent is started again once the wait has ended", 5_000).catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); settling=${terminals.settling(agent.id)}`);
      });
      assert.ok(Date.now() - crashedAt >= 600, "not before the ordinary attempts had their time");
      assert.equal(terminals.settling(agent.id), false, "the daemon no longer waits for that exit");
      await answerOnReplacement(agent, 2);
      assert.equal(agent.published.at(-1), "Answer 2.");
      assert.equal(agent.harness.launches.length, 2, "one replacement");

      const entry = (await agent.request("manifest.list")).result[0] as { activity?: Array<{ kind: string; summary: string }> };
      assert.equal(entry.activity?.filter((event) => event.summary === EXIT_UNSETTLED_NOTICE).length, 1,
        "the owner reads once, in the agent's activity, that the exit could not be recorded in full");
      const generations = agent.read<{ ended: number }>(
        "SELECT terminal_json IS NOT NULL AS ended FROM work_attempt_executions WHERE work_attempt_id=(SELECT work_attempt_id FROM agent_configurations c JOIN runtime_deployments d ON d.agent_id=c.agent_id WHERE c.agent_id=?) ORDER BY rowid");
      assert.deepEqual(generations.map((row) => row.ended), [1, 0], "the crashed process's terminal is saved: the first generation has ended, the second runs");
      const recorded = (await agent.transitionCauses()).filter((cause) => /provider terminal/.test(cause));
      // The last attempt goes on without the approvals step, so the crash is
      // recorded as one. When the queue or the terminal's storage is what
      // fails, the daemon stops waiting and finds the process gone instead.
      assert.deepEqual(recorded, fault.startsWith("closing its approvals") ? ["provider terminal: crashed"] : [], "the crash is recorded at most once");
      const observer = agent.read<{ last: number; max: number }>(
        "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
      assert.equal(observer.max, observer.last, "and the replacement's activity is recorded without a gap");

      // The replacement crashes as well, and its exit cannot be recorded either: that is a second exit, and the owner is told of it too.
      agent.exitProcess(1, "SIGKILL");
      await agent.eventually(() => agent.harness.clients.length === 3, "the agent is started again after the second crash", 5_000);
      await agent.eventually(async () => ((await agent.request("manifest.list")).result[0] as typeof entry).activity
        ?.filter((event) => event.summary === EXIT_UNSETTLED_NOTICE).length === 2, "the owner reads of each exit once");
      await answerOnReplacement(agent, 3);
      assert.equal(agent.published.at(-1), "Answer 3.");
      // Told again of the first exit, and then of a third, the owner reads of the third only.
      const [firstExit] = agent.read<{ id: string }>("SELECT execution_generation_id AS id FROM execution_generations WHERE agent_id=? ORDER BY rowid");
      terminals.ports.exitUnsettled(agent.id, firstExit!.id);
      terminals.ports.exitUnsettled(agent.id, "a-third-exit");
      await agent.eventually(async () => ((await agent.request("manifest.list")).result[0] as typeof entry).activity
        ?.filter((event) => event.summary === EXIT_UNSETTLED_NOTICE).length === 3, "the owner reads of the third exit");
      assert.equal(((await agent.request("manifest.list")).result[0] as typeof entry).activity
        ?.filter((event) => event.summary === EXIT_UNSETTLED_NOTICE).length, 3, "and of no exit twice");
    } finally {
      endFault();
      await agent.cleanup();
    }
  });
}

for (const fault of ["closing its approvals never returns", "its entry's queue never answers"] as const) {
  test(`an agent restarted to apply a setting, whose stopped process cannot be recorded because ${fault}, runs again with the setting after a bounded wait`, async () => {
    const agent = await codexDaemonFixture();
    let endFault = () => {};
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      const terminals = agent.exitSettlement();
      terminals.bounds = { settleMs: 600, lastAttemptMs: 400, recordMs: 200 };
      endFault = EXIT_RECORDING_FAULTS[fault](terminals);

      const applied = await agent.changeEffortAndRestart();
      // The last attempt records the exit without the approvals step, and the
      // restart completes as asked. When the queue is what fails, the app is
      // told the exit could not be recorded, and the agent is started all the same.
      if (fault === "closing its approvals never returns") assert.equal(applied.result?.outcome, "restarting", JSON.stringify(applied));
      else assert.match(applied.error ?? "", /could not finish recording that in time/, JSON.stringify(applied));
      await agent.eventually(() => agent.harness.clients.length === 2, "the agent is started again", 5_000).catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); settling=${terminals.settling(agent.id)}; answer=${JSON.stringify(applied)}`);
      });
      assert.equal(terminals.settling(agent.id), false);
      await answerOnReplacement(agent, 2);
      assert.equal(agent.published.at(-1), "Answer 2.");
      assert.equal(agent.harness.launches.length, 2, "one replacement");
      const configuration = (await agent.request("supervisor.get_agent_configuration", { entry_id: agent.id, daemon_generation: agent.daemonGeneration() })).result;
      assert.equal(configuration.runtime_configuration_revision, configuration.config_revision, "the running process has the saved setting");
    } finally {
      endFault();
      await agent.cleanup();
    }
  });
}

for (const fault of ["its entry's queue never answers", "closing its approvals never returns", "saving its terminal never returns"] as const) {
test(`Restart and resume starts an agent again at once while the daemon is still recording the exit of its crashed process, because ${fault}`, async () => {
  const agent = await codexDaemonFixture({ holdExits: true, osProcessBirths: true });
  let endFault = () => {};
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    const terminals = agent.exitSettlement();
    // The exit's recording does not finish. The bound that would end the wait
    // is seconds away; the owner's last resort must not wait for it, even for
    // a step that holds the entry's queue.
    endFault = EXIT_RECORDING_FAULTS[fault](terminals);
    const before = (await agent.request("manifest.list")).result[0] as { room_id: string; provider_ref: { execution_generation_id: string } };
    const runtimeId = agent.read<{ runtime_generation_id: string }>(
      "SELECT runtime_generation_id FROM execution_runtime_generations WHERE agent_id=? ORDER BY created_at_ms DESC")[0]!.runtime_generation_id;

    agent.exitProcess(0, "SIGKILL");
    await agent.eventually(() => !agent.holdsRuntime() && terminals.settling(agent.id), "the exit waits to be recorded");
    agent.converge();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(agent.harness.launches.length, 1, "nothing replaces the process by itself yet");

    // The owner uses Diagnostics, "Restart and resume".
    const askedAt = Date.now();
    const recovered = await agent.request("supervisor.recover_agent_runtime", { entry_id: agent.id, daemon_generation: agent.daemonGeneration(),
      mode: "resume", operation_id: "owner-restart-1", room_id: before.room_id,
      execution_generation_id: before.provider_ref.execution_generation_id, runtime_generation_id: runtimeId });
    assert.equal(recovered.result?.outcome, "recovering", recovered.error ?? recovered.result?.error);
    assert.ok(Date.now() - askedAt < 3_000, `it took effect at once, not after the recording's bound (${Date.now() - askedAt} ms)`);
    assert.equal(terminals.settling(agent.id), false, "the exit the daemon was still recording gives way to the owner's recovery");
    await agent.eventually(() => agent.harness.clients.length === 2, "the agent is started again", 3_000).catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });
    await answerOnReplacement(agent, 2);
    assert.equal(agent.published.at(-1), "Answer 2.");
    assert.equal(agent.harness.launches.length, 2, "one replacement");
    assert.equal(agent.read<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=? AND phase='complete'")[0]!.n, 1);
  } finally {
    endFault();
    await agent.cleanup();
  }
});
}

test("a recovery that asks the provider whether the saved process is gone names the process as one that has the owner's setup when it was started with it", async () => {
  const agent = await codexDaemonFixture({ holdExits: true, osProcessBirths: true, ownerSetup: true });
  let endFault = () => {};
  try {
    assert.equal(agent.harness.launchOptions[0]?.options.homeHarness, true, "the runtime was started with the owner's setup");
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    const terminals = agent.exitSettlement();
    terminals.bounds = { settleMs: 600, lastAttemptMs: 400, recordMs: 200 };
    endFault = EXIT_RECORDING_FAULTS["saving its terminal never returns"](terminals);
    agent.exitProcess(0, "SIGKILL");
    await agent.eventually(() => !agent.holdsRuntime() && terminals.settling(agent.id), "the exit waits to be recorded");

    // The daemon holds no runtime and has not recorded the end of the saved one, so it asks the provider whether that process is gone.
    const attachedBefore = agent.attachedRefs().length;
    const recovered = await agent.request("supervisor.recover_agent_runtime", { entry_id: agent.id, daemon_generation: agent.daemonGeneration() });
    assert.equal(recovered.ok, true, recovered.error);
    const asked = agent.attachedRefs().slice(attachedBefore);
    assert.ok(asked.length > 0, "the provider was asked to attach the saved process");
    assert.ok(asked.every((ref) => ref.ownerSetup === true), "and was told it was started with the owner's setup");
    await agent.eventually(() => agent.harness.clients.length === 2, "the agent is started again", 3_000);
    assert.equal(agent.harness.launchOptions[1]?.options.homeHarness, true, "the setup is still on, so the replacement has it");
  } finally {
    endFault();
    await agent.cleanup();
  }
});

for (const fault of Object.keys(EXIT_RECORDING_FAULTS) as Array<keyof typeof EXIT_RECORDING_FAULTS>) {
test(`an app update that waits on an exit that cannot be recorded, because ${fault}, goes ahead once the bounded wait has ended`, async () => {
  const agent = await codexDaemonFixture({ holdExits: true });
  let endFault = () => {};
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    const terminals = agent.exitSettlement();
    terminals.bounds = { settleMs: 600, lastAttemptMs: 400, recordMs: 200 };
    endFault = EXIT_RECORDING_FAULTS[fault](terminals);
    const exitedAt = Date.now();
    agent.exitProcess(0, "SIGKILL");
    await agent.eventually(() => !agent.holdsRuntime() && terminals.settling(agent.id), "the exit waits to be recorded");

    // The update waits for the exit to be recorded, which outside tests
    // takes 27 seconds at most: inside the 30 seconds after which the app
    // would say "Update deferred" and leave the owner to try again. A step
    // that fails is waited through as one that never returns is.
    const handoff = await agent.request("daemon.prepare_handoff");
    assert.equal(handoff.ok, true, handoff.error);
    // The wait is counted from the exit, not from the request.
    assert.ok(Date.now() - exitedAt >= 600, "it waited for the exit, for as long as the exit was waited for");
    assert.equal(terminals.settling(agent.id), false);
  } finally {
    endFault();
    await agent.cleanup();
  }
});
}

for (const exit of ["cannot be recorded", "is recorded as usual"] as const) {
  test(`removing an agent whose exit ${exit} is not refused for a process that still looks alive${exit === "cannot be recorded" ? " once the bounded wait has ended" : ""}`, async () => {
    const agent = await codexDaemonFixture({ holdExits: true });
    let endFault = () => {};
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      const terminals = agent.exitSettlement();
      terminals.bounds = { settleMs: 600, lastAttemptMs: 400, recordMs: 200 };
      if (exit === "cannot be recorded") endFault = EXIT_RECORDING_FAULTS["its entry's queue never answers"](terminals);
      agent.exitProcess(0, "SIGKILL");
      await agent.eventually(() => !agent.holdsRuntime(), "the daemon lets go of the exited runtime");

      // What the app does when the owner removes an agent: it retires it, ending its room session, and then purges it.
      const removal = { entry_id: agent.id, daemon_generation: agent.daemonGeneration() };
      const asked = await agent.request("supervisor.retire_agent", { ...removal, revoked_agent_session_id: null, grant_revoked_without_worker_session: false });
      assert.equal(asked.result?.outcome, "revocation_required", asked.error ?? asked.result?.error);
      const retired = await agent.request("supervisor.retire_agent", { ...removal, revoked_agent_session_id: asked.result.agent_session_id, grant_revoked_without_worker_session: false });
      assert.equal(retired.result?.outcome, "retired", retired.error ?? retired.result?.error);
      const purge = () => agent.request("supervisor.purge_agent", { ...removal, revoked_agent_session_id: asked.result.agent_session_id });
      const unended = () => agent.read<{ n: number }>("SELECT COUNT(*) AS n FROM work_attempt_executions WHERE terminal_json IS NULL AND ?<>''")[0]!.n;
      if (exit === "cannot be recorded") {
        // Removal is refused while the exit may still be recorded: the
        // agent's execution has no terminal, and depending on how far the
        // daemon has got, its state is not yet a stopped one either.
        const early = (await purge()).result as { outcome: string; error?: string };
        assert.equal(early.outcome, "invalid", early.error);
        assert.match(early.error ?? "", /live provider execution|fully stopped durable lifecycle/);
        assert.equal(unended(), 1, "the ended process has no saved terminal yet");
        await agent.eventually(() => !terminals.settling(agent.id), "the daemon stops waiting for the exit", 5_000);
      }
      await agent.eventually(() => unended() === 0, "the ended process has a saved terminal");
      // The agent's first working event published its live activity line,
      // so the daemon holds a native publication that names its worker
      // session: that is the exact evidence a purge needs, and the purge
      // completes for both. Removal has got past the process's exit once it
      // answers that.
      let answer: { outcome: string; error?: string } = { outcome: "" };
      await agent.eventually(async () => {
        answer = (await purge()).result as typeof answer;
        return !/live provider execution|fully stopped durable lifecycle/.test(answer.error ?? "");
      }, "removal is no longer refused for a process that looks alive").catch((error) => {
        throw new Error(`${(error as Error).message}: ${JSON.stringify(answer)}`);
      });
      assert.equal(answer.outcome, "purged", answer.error);
      assert.equal(agent.harness.launches.length, 1, "an agent being removed is not started again");
    } finally {
      endFault();
      await agent.cleanup();
    }
  });
}

for (const shown of ["still shows the turn as running", "does not hold the turn"] as const) for (const started of [true, false]) {
  test(`a turn whose runtime exited under it${started ? "" : " before the record saw it start"}, in a thread that ${shown}, is settled as cut off by the exit${started ? " and closed in the record" : ", with no ending recorded for it"}, and the next message is answered`, async () => {
    const { PROCESS_ENDED_DURING_TURN } = await import("../main/agents/provider-adapter.js");
    const agent = await codexDaemonFixture({ holdExits: true });
    const turnStates = () => agent.read<{ provider_turn_id: string; state: string }>(
      "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,provider_turn_id");
    try {
      agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
      await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
      const turn = agent.turns[0]!;
      if (started) {
        agent.client.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
        await agent.eventually(() => turnStates()[0]?.state === "active", "the turn's start is recorded");
      }

      // The process dies under the turn, and the thread never learns how the turn ended.
      if (shown === "does not hold the turn") turn.notInThread = true;
      agent.exitProcess(0, null);
      await agent.eventually(() => agent.harness.clients.length === 2, "the runtime is replaced");
      agent.serveThread(agent.harness.clients[1]!);
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed").catch(async (error) => {
        const row = await agent.receipt("msg_1");
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
      });
      assert.equal((await agent.receipt("msg_1"))!.last_error, PROCESS_ENDED_DURING_TURN, "with the reason, for the room and the owner");
      if (started) await agent.eventually(() => turnStates()[0]?.state === "terminal", "and the record closes the turn");
      else assert.deepEqual(turnStates(), [], "a turn the record never saw start is given no ending in it");

      // The turn is over for the thread as well: the next message gets a turn of its own.
      Object.assign(turn, { status: "interrupted" });
      await answerOnReplacement(agent, 2);
      assert.deepEqual(agent.published, ["Answer 2."], "the turn that was cut off is never run again");
      await agent.eventually(() => turnStates().at(-1)?.state === "terminal" && turnStates().length === (started ? 2 : 1), "the next turn is recorded to its end");
      assert.deepEqual(turnStates().map((row) => row.provider_turn_id), started ? ["turn-1", "turn-2"] : ["turn-2"]);
      const observer = agent.read<{ last: number; max: number }>(
        "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
      assert.equal(observer.max, observer.last, "with no gap in the record");
      assert.equal(agent.harness.launches.length, 2, "one replacement");
      assert.equal((await agent.view()).room_agent_state.inbox.state, "empty", "nothing waits for a person");
    } finally {
      await agent.cleanup();
    }
  });
}

test("a turn that is still running on its live process when the daemon is restarted is waited for and answered, not taken for cut off", async () => {
  const agent = await codexDaemonFixture({ recordGraceMs: 400 });
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id), "msg_2 starts its turn");
    const turn = agent.turns[1]!;
    agent.client.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });

    // The daemon ends and a new one attaches the same process, which is still running the turn.
    await agent.restartDaemon();
    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's process");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await agent.receipt("msg_2"))!.state === "acknowledged_failed", false, "the turn's process has not ended; the turn is not given up");
    assert.equal(agent.harness.launches.length, 1, "nothing was started in its place");

    // A restart under a running turn can leave the record of that turn
    // incomplete, and delivery is then not admitted to read the turn's
    // ending. The daemon does not touch the process while the turn runs.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(agent.harness.signals, [], "a running turn is never interrupted for its record");

    const attached = agent.harness.clients.at(-1)!;
    Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
    attached.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    attached.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: turn.id, turn } });
    // Either delivery reads the ending from the process it attached, or,
    // where the record no longer admits it, the daemon restarts the idle
    // agent once and its replacement reads the ending from the thread.
    agent.whenNextConnects((server) => agent.serveThread(server));
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered").catch(async (error) => {
      const row = await agent.receipt("msg_2");
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); agent is ${current.observed_state}/${current.condition} (${current.last_error}); ${JSON.stringify(current.room_agent_state)}; clients ${agent.harness.clients.length}; record ${JSON.stringify(executionRecord(agent).observer())} ${JSON.stringify(executionRecord(agent).turns())}`);
    });
    assert.deepEqual(agent.published, ["Answer 1.", "Answer 2."], "the answer is posted once, and the turn was never run again");
    assert.equal(agent.turns.length, 2);
    await answerOnReplacement(agent, 3);
    assert.equal(agent.published.at(-1), "Answer 3.", "and the next message is answered");
  } finally {
    await agent.cleanup();
  }
});

for (const ending of ["interrupted", "completed"] as const) test(`a turn whose runtime exited under it is closed in the record when its replacement reads that it was ${ending}, so later turns and later replacements are recorded too`, async () => {
  const agent = await codexDaemonFixture({ holdExits: true });
  const turnStates = () => agent.read<{ provider_turn_id: string; state: string }>(
    "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,provider_turn_id");
  const observer = () => agent.read<{ last: number; max: number }>(
    "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
  const replaced = (count: number) => agent.eventually(() => agent.harness.clients.length === count, `runtime ${count} is started`).catch(async (error) => {
    const current = await agent.view();
    throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
  });
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    agent.client.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
    await agent.eventually(() => turnStates()[0]?.state === "active", "the turn's start is recorded");

    // The process dies under the turn. The thread then says how the turn
    // ended: interrupted, as Codex reports a turn its process died under, or
    // completed, when the answer was written just before. No notification
    // ever says so.
    Object.assign(turn, ending === "completed"
      ? { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 1." }] }
      : { status: "interrupted", items: [] });
    const settled = ending === "completed" ? "acknowledged" : "acknowledged_failed";
    agent.exitProcess(0, null);
    await agent.eventually(() => turnStates()[0]?.state === "lost", "the record says the turn was lost with its runtime");
    await replaced(2);
    agent.serveThread(agent.harness.clients[1]!);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === settled, "the replacement reads how the turn ended");
    await agent.eventually(() => turnStates()[0]?.state === "terminal", "and the record closes the turn", 5_000).catch((error) => {
      throw new Error(`${(error as Error).message}: the record has ${JSON.stringify(turnStates())}`);
    });

    // The next turn is recorded: nothing is left open in front of it.
    await answerOnReplacement(agent, 2);
    await agent.eventually(() => turnStates()[1]?.state === "terminal", "the next turn is recorded to its end", 5_000).catch((error) => {
      throw new Error(`${(error as Error).message}: the record has ${JSON.stringify(turnStates())}, observer ${JSON.stringify(observer())}`);
    });
    assert.deepEqual([observer().last], [observer().max], "with no gap in the record");

    // So a second exit is replaced like the first, and its replacement takes the next message.
    agent.exitProcess(1, null);
    await replaced(3);
    await answerOnReplacement(agent, 3);
    assert.deepEqual(agent.published, [...(ending === "completed" ? ["Answer 1."] : []), "Answer 2.", "Answer 3."],
      "each answer is posted once");
    assert.deepEqual((await agent.receipts()).map((row) => [row.source_message_id, row.state]),
      [["msg_1", settled], ["msg_2", "acknowledged"], ["msg_3", "acknowledged"]], "the first turn was never run again");
    assert.equal(agent.turns.length, 3);
    await agent.eventually(() => agent.read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM execution_message_attempts WHERE agent_id=? AND conclusion IS NOT NULL")[0]!.n === 3, "every attempt settles");
    assert.deepEqual(agent.read<{ source_message_id: string; conclusion: string | null }>(
      "SELECT source_message_id,conclusion FROM execution_message_attempts WHERE agent_id=? ORDER BY created_at_ms"), [
      { source_message_id: "msg_1", conclusion: ending === "completed" ? "replied" : "interrupted" },
      { source_message_id: "msg_2", conclusion: "replied" },
      { source_message_id: "msg_3", conclusion: "replied" },
    ]);
    // Nothing is missing from this record, so nothing was archived and the owner is told nothing.
    assert.deepEqual(executionRecord(agent).boundaries(), []);
    assert.deepEqual(await executionRecord(agent).notices(), []);
  } finally {
    await agent.cleanup();
  }
});

test("a turn the record never saw start is still recovered by the replacement, and its ending opens no gap in the record", async () => {
  const agent = await codexDaemonFixture({ holdExits: true });
  const observer = () => agent.read<{ last: number; max: number }>(
    "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
    // The process dies before it reports that the turn started: the record holds no such turn.
    Object.assign(agent.turns[0]!, { status: "interrupted", items: [] });
    agent.exitProcess(0, null);
    await agent.eventually(() => agent.harness.clients.length === 2, "the crashed runtime is replaced");
    agent.serveThread(agent.harness.clients[1]!);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "the replacement reads how the turn ended");

    await answerOnReplacement(agent, 2);
    await agent.eventually(() => agent.read<{ state: string }>(
      "SELECT state FROM execution_turns WHERE agent_id=? AND provider_turn_id='turn-2'")[0]?.state === "terminal", "the next turn is recorded to its end", 5_000)
      .catch((error) => { throw new Error(`${(error as Error).message}: observer ${JSON.stringify(observer())}`); });
    assert.equal(observer().max, observer().last, "the record has no gap");
    assert.deepEqual(agent.read<{ provider_turn_id: string }>("SELECT provider_turn_id FROM execution_turns WHERE agent_id=?"),
      [{ provider_turn_id: "turn-2" }], "and no turn it never saw start");
  } finally {
    await agent.cleanup();
  }
});
