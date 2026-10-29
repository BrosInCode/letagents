import "./isolated-home.js";
import assert from "node:assert/strict";
import { supervisedAgentTest as test } from "./platform.js";
import { CodexProviderAdapter, COMMAND_OUTPUT_WINDOW_MS } from "../main/agents/codex-provider-adapter.js";
import type { ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import {
  createHarness,
  spawnRequest,
  flush,
  codexDaemonFixture,
  answerOnReplacement,
  OUTPUT_CLOSED_BY,
  ACTIVITY_RECORD_STOPPED,
  ACTIVITY_RECORD_CONTINUED,
  executionRecord,
  openRecordGap,
  RECORDS_LEFT_BEHIND,
  RECORD_RESTART_PENDING,
} from "./codex-provider-adapter.fixture.js";

test("a command's output is recorded as one fact per window, always ahead of whatever is recorded next", async (t) => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(COMMAND_OUTPUT_WINDOW_MS, 5_000);
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const threadId = handle.providerContinuationId;
  const emit = (method: string, params: Record<string, unknown>) => client.emit({ method, params: { threadId, turnId: "turn-1", ...params } });
  const print = (itemId: string, chunks: number) => {
    for (let chunk = 0; chunk < chunks; chunk += 1) emit("item/commandExecution/outputDelta", { itemId, delta: "1234567890" });
  };
  const recorded = () => observations.splice(0).map(({ fact }) => fact.domain === "execution"
    ? `${fact.executionId}:${fact.kind}${fact.kind === "output" ? `:${fact.outputBytes}` : ""}` : `${fact.domain}:${"state" in fact ? fact.state : ""}`);

  emit("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  emit("item/started", { item: { id: "command-1", type: "commandExecution", status: "inProgress", processId: "pty-1" } });
  recorded();

  // Output is added up, and nothing is recorded while the window is open, even once the burst has been read.
  print("command-1", 300);
  assert.deepEqual(recorded(), []);
  await flush();
  t.mock.timers.tick(COMMAND_OUTPUT_WINDOW_MS - 1);
  assert.deepEqual(recorded(), [], "the window is still open");
  t.mock.timers.tick(1);
  assert.deepEqual(recorded(), ["command-1:output:3000"], "when the window closes");
  t.mock.timers.tick(COMMAND_OUTPUT_WINDOW_MS);
  assert.deepEqual(recorded(), [], "a window with nothing printed records nothing");

  // Another command's output, and the command's own ending, come after what was printed before them.
  emit("item/started", { item: { id: "command-2", type: "commandExecution", status: "inProgress", processId: "pty-2" } });
  print("command-1", 2);
  print("command-2", 3);
  emit("item/completed", { item: { id: "command-2", type: "commandExecution", status: "completed", exitCode: 0 } });
  assert.deepEqual(recorded(), ["command-2:started", "command-1:output:20", "command-2:output:30", "command-2:completed"]);

  // Commands that print in turn are each added up on their own: a burst is one fact per command, not one per switch.
  emit("item/started", { item: { id: "command-3", type: "commandExecution", status: "inProgress", processId: "pty-3" } });
  emit("item/started", { item: { id: "command-4", type: "commandExecution", status: "inProgress", processId: "pty-4" } });
  recorded();
  for (let round = 0; round < 300; round += 1) { print("command-3", 1); print("command-1", 1); print("command-4", 1); }
  assert.deepEqual(recorded(), []);
  t.mock.timers.tick(COMMAND_OUTPUT_WINDOW_MS);
  assert.deepEqual(recorded(), ["command-3:output:3000", "command-1:output:3000", "command-4:output:3000"],
    "in the order they first printed");

  // A turn ending that cannot be read uses up a position in the record; output printed before it is recorded first.
  print("command-1", 4);
  const before = subscription.position().latestSequence;
  client.emit({ method: "turn/completed", params: { threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" } } });
  assert.deepEqual(recorded(), ["command-1:output:40", "control:degraded"]);
  assert.equal(subscription.position().latestSequence, before + 3, "the output, the unreadable ending, and its report");

  // The runtime ending closes the command and the turn; output printed before it is not recorded after them.
  print("command-1", 5);
  client.emit({ method: "process/systemError", params: { status: "systemError" } });
  assert.deepEqual(recorded(), ["command-1:output:50", "command-1:completed", "command-3:completed", "command-4:completed", "turn:lost", "control:lost", "runtime:exited"]);
  print("command-1", 6);
  t.mock.timers.tick(COMMAND_OUTPUT_WINDOW_MS);
  assert.deepEqual(recorded(), [], "nothing is recorded for a runtime that has ended");
});

for (const [closedBy, close] of Object.entries(OUTPUT_CLOSED_BY)) for (const commands of [1, 3] as const) {
  test(`${commands === 1 ? "a command" : `${commands} commands`} streaming one chunk per millisecond for 6,000 chunks ${commands === 1 ? "is" : "are"} recorded once per window and at ${closedBy}, every byte counted and in order`, async (t) => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" }));
    const observations: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => observations.push(event));
    const client = harness.clients[0]!;
    const threadId = handle.providerContinuationId;
    const emit = (method: string, params: Record<string, unknown>) => client.emit({ method, params: { threadId, turnId: "turn-1", ...params } });
    const ids = Array.from({ length: commands }, (_unused, index) => `command-${index + 1}`);
    emit("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
    for (const id of ids) emit("item/started", { item: { id, type: "commandExecution", status: "inProgress", processId: `pty-${id}` } });
    observations.splice(0);
    t.mock.timers.enable({ apis: ["setTimeout"] });

    // One chunk each millisecond, from the next command in turn, as side-by-side installs or test runs print.
    const delta = "line é🙂\n";
    const size = Buffer.byteLength(delta);
    const printed = new Map(ids.map((id) => [id, 0]));
    const seen: Array<[number, string]> = [];
    const collect = (ms: number) => {
      for (const { fact } of observations.splice(0)) {
        seen.push([ms, fact.domain === "execution" ? `${fact.executionId}:${fact.kind}${fact.kind === "output" ? `:${fact.outputBytes / size}` : ""}` : fact.domain]);
      }
    };
    for (let ms = 0; ms < 6_000; ms += 1) {
      const id = ids[ms % commands]!;
      emit("item/commandExecution/outputDelta", { itemId: id, delta });
      printed.set(id, printed.get(id)! + size);
      collect(ms);
      t.mock.timers.tick(1);
    }
    collect(6_000);
    close(emit, ids);
    collect(6_000);
    t.mock.timers.tick(COMMAND_OUTPUT_WINDOW_MS);
    collect(11_000);

    // Output facts carry chunk counts here: each is a whole number of chunks.
    const outputs = seen.filter(([, label]) => label.includes(":output:"));
    assert.deepEqual(outputs, commands === 1 ? [
      [5_000, "command-1:output:5000"],
      [6_000, "command-1:output:1000"],
    ] : [
      // The first window holds chunks 0 to 4,999, in the order the commands first printed in it.
      [5_000, "command-1:output:1667"], [5_000, "command-2:output:1667"], [5_000, "command-3:output:1666"],
      // The second opens on chunk 5,000, printed by command-3, and is closed early.
      [6_000, "command-3:output:334"], [6_000, "command-1:output:333"], [6_000, "command-2:output:333"],
    ]);
    const closing = seen.slice(outputs.length);
    assert.ok(closing.length > 0 && closing.every(([ms, label]) => ms === 6_000 && !label.includes(":output:")),
      `what closed the window is recorded after the output and at once: ${JSON.stringify(closing)}`);
    assert.deepEqual(seen.slice(0, outputs.length), outputs, "no output is recorded after what closed it");
    const counted = new Map(ids.map((id) => [id, 0]));
    for (const [, label] of seen) {
      const [id, kind, chunks] = label.split(":");
      if (kind === "output") counted.set(id!, counted.get(id!)! + Number(chunks) * size);
    }
    assert.deepEqual(counted, printed, "every byte each command printed is counted");
  });
}

test("a command that prints thousands of chunks at once leaves no gap in the agent's record", async () => {
  const agent = await codexDaemonFixture();
  try {
    agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
    const turn = agent.turns[0]!;
    const identity = { threadId: agent.threadId, turnId: turn.id };
    agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    // Two commands, each printing more chunks in one read than the record's intake holds.
    let printed = 0;
    for (const command of ["command-1", "command-2"]) {
      agent.client.emit({ method: "item/started", params: { ...identity,
        item: { id: command, type: "commandExecution", status: "inProgress", processId: `pty-${command}` } } });
      for (let line = 0; line < 2_000; line += 1) {
        const delta = `${command} line ${line}\n`;
        printed += Buffer.byteLength(delta);
        agent.client.emit({ method: "item/commandExecution/outputDelta", params: { ...identity, itemId: command, delta } });
      }
      agent.client.emit({ method: "item/completed", params: { ...identity,
        item: { id: command, type: "commandExecution", status: "completed", exitCode: 0 } } });
    }
    Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 1." }] });
    agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered");
    await agent.turnsRecorded(1);

    const observer = agent.read<{ last: number; max: number }>(
      "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
    assert.equal(observer.max, observer.last, "the record has no gap");
    assert.deepEqual(agent.read<{ provider_turn_id: string; state: string }>(
      "SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=?"), [{ provider_turn_id: "turn-1", state: "terminal" }]);
    const output = agent.read<{ facts: number; bytes: number }>(
      "SELECT COUNT(*) AS facts, SUM(output_bytes) AS bytes FROM execution_facts WHERE agent_id=? AND kind='output'")[0]!;
    assert.equal(output.bytes, printed, "every byte the commands printed is counted");
    assert.equal(output.facts, 2, "as one fact per command, in order with the command's own start and end");
    assert.deepEqual(agent.read<{ kind: string }>(
      "SELECT kind FROM execution_facts WHERE agent_id=? AND domain='execution' ORDER BY source_sequence").map((fact) => fact.kind),
      ["started", "output", "completed", "started", "output", "completed"]);

    // The next message is recorded as well.
    await agent.deliver(2, { answer: "Answer 2." });
    await agent.turnsRecorded(2);
  } finally {
    await agent.cleanup();
  }
});

for (const commands of [2, 5] as const) {
  test(`${commands} commands that print 5,000 chunks in turn leave no gap in the agent's record`, async () => {
    const agent = await codexDaemonFixture();
    try {
      agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
      await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
      const turn = agent.turns[0]!;
      const identity = { threadId: agent.threadId, turnId: turn.id };
      agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
      const ids = Array.from({ length: commands }, (_unused, index) => `command-${index + 1}`);
      for (const id of ids) {
        agent.client.emit({ method: "item/started", params: { ...identity, item: { id, type: "commandExecution", status: "inProgress", processId: `pty-${id}` } } });
      }
      // The commands run side by side and their output arrives chunk by chunk, each chunk from the next command.
      const printed = new Map(ids.map((id) => [id, 0]));
      for (let chunk = 0; chunk < 5_000; chunk += 1) {
        const id = ids[chunk % commands]!;
        const delta = `${id} line ${chunk}: é🙂\n`;
        printed.set(id, printed.get(id)! + Buffer.byteLength(delta));
        agent.client.emit({ method: "item/commandExecution/outputDelta", params: { ...identity, itemId: id, delta } });
      }
      for (const id of ids) {
        agent.client.emit({ method: "item/completed", params: { ...identity, item: { id, type: "commandExecution", status: "completed", exitCode: 0 } } });
      }
      Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 1." }] });
      agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
      agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered");
      await agent.turnsRecorded(1);

      const observer = agent.read<{ last: number; max: number }>(
        "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
      assert.equal(observer.max, observer.last, "the record has no gap");
      assert.deepEqual(agent.read<{ execution_id: string; bytes: number }>(
        "SELECT execution_id, SUM(output_bytes) AS bytes FROM execution_facts WHERE agent_id=? AND kind='output' GROUP BY execution_id ORDER BY MIN(source_sequence)")
        .map((row) => [row.execution_id.replace(/^.*(command-\d+)$/, "$1"), row.bytes]), [...printed],
        "every byte each command printed is counted for it, in the order the commands first printed");
      const kinds = agent.read<{ kind: string }>(
        "SELECT kind FROM execution_facts WHERE agent_id=? AND domain='execution' ORDER BY source_sequence").map((fact) => fact.kind);
      assert.deepEqual(kinds, [...ids.map(() => "started"), ...ids.map(() => "output"), ...ids.map(() => "completed")],
        "as one fact per command, after the commands' starts and before their ends");

      await agent.deliver(2, { answer: "Answer 2." });
      await agent.turnsRecorded(2);
    } finally {
      await agent.cleanup();
    }
  });
}

for (const commands of [1, 3] as const) {
  test(`${commands === 1 ? "a command" : `${commands} commands`} streaming 12,000 chunks, each in its own read, leave${commands === 1 ? "s" : ""} no gap in the agent's record`, async () => {
    const agent = await codexDaemonFixture();
    try {
      agent.roomMessages.push({ id: "msg_1", sender: "someone", text: "request 1", activation: { for_current_agent: { decision: "activate" } } });
      await agent.eventually(async () => agent.turns.length === 1 && Boolean((await agent.receipt("msg_1"))?.provider_turn_id), "msg_1 starts its turn");
      const turn = agent.turns[0]!;
      const identity = { threadId: agent.threadId, turnId: turn.id };
      agent.client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
      const ids = Array.from({ length: commands }, (_unused, index) => `command-${index + 1}`);
      for (const id of ids) {
        agent.client.emit({ method: "item/started", params: { ...identity, item: { id, type: "commandExecution", status: "inProgress", processId: `pty-${id}` } } });
      }
      // More chunks than the record's intake holds, each arriving on its own, as a slow install or test run streams them:
      // adding up only what one read held recorded each of these as its own fact.
      const printed = new Map(ids.map((id) => [id, 0]));
      const started = Date.now();
      for (let chunk = 0; chunk < 12_000; chunk += 1) {
        const id = ids[chunk % commands]!;
        const delta = `${id} line ${chunk}: é🙂\n`;
        printed.set(id, printed.get(id)! + Buffer.byteLength(delta));
        agent.client.emit({ method: "item/commandExecution/outputDelta", params: { ...identity, itemId: id, delta } });
        await flush();
      }
      const windows = Math.ceil((Date.now() - started) / COMMAND_OUTPUT_WINDOW_MS);
      for (const id of ids) {
        agent.client.emit({ method: "item/completed", params: { ...identity, item: { id, type: "commandExecution", status: "completed", exitCode: 0 } } });
      }
      Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 1." }] });
      agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
      agent.client.emit({ method: "turn/completed", params: { ...identity, turn } });
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered");
      await agent.turnsRecorded(1);

      const observer = agent.read<{ last: number; max: number }>(
        "SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")[0]!;
      assert.equal(observer.max, observer.last, "the record has no gap");
      const output = agent.read<{ execution_id: string; facts: number; bytes: number }>(
        "SELECT execution_id, COUNT(*) AS facts, SUM(output_bytes) AS bytes FROM execution_facts WHERE agent_id=? AND kind='output' GROUP BY execution_id ORDER BY MIN(source_sequence)");
      assert.deepEqual(output.map((row) => [row.execution_id.replace(/^.*(command-\d+)$/, "$1"), row.bytes]), [...printed],
        "every byte each command printed is counted for it, in the order the commands first printed");
      for (const row of output) {
        assert.ok(row.facts <= windows + 1, `one fact per window the command printed in and one at its end, not one per chunk: ${row.facts} in ${windows} windows`);
      }
      const kinds = agent.read<{ kind: string }>(
        "SELECT kind FROM execution_facts WHERE agent_id=? AND domain='execution' ORDER BY source_sequence").map((fact) => fact.kind);
      assert.deepEqual(kinds.slice(0, commands), ids.map(() => "started"));
      assert.deepEqual(kinds.slice(-commands), ids.map(() => "completed"), "no output is recorded after a command's end");
      assert.ok(kinds.slice(commands, -commands).every((kind) => kind === "output"));

      await agent.deliver(2, { answer: "Answer 2." });
      await agent.turnsRecorded(2);
    } finally {
      await agent.cleanup();
    }
  });
}

for (const replacement of ["a crash", "a configuration change", "the owner's setup being switched off", "an app update after a refused turn"] as const) {
  test(`an agent whose activity record has a gap keeps taking messages when its runtime is replaced by ${replacement}`, async () => {
    const agent = await codexDaemonFixture(replacement === "the owner's setup being switched off" ? { ownerSetup: true } : {});
    const record = executionRecord(agent);
    try {
      const gap = await openRecordGap(agent);
      if (replacement === "an app update after a refused turn") await agent.deliver(1, { refusal: "The provider refused this turn." });
      else await agent.deliver(1, { answer: "Answer 1." });
      await agent.eventually(async () => (await record.notices()).length === 1, "the owner is told the record stopped");
      assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_STOPPED], "once, and the agent keeps working");
      assert.equal((await agent.view()).condition, "none", "which asks nothing of the owner");

      if (replacement === "a crash") agent.exitProcess(0, null);
      else if (replacement === "a configuration change") assert.equal((await agent.changeEffortAndRestart()).result?.outcome, "restarting");
      else if (replacement === "the owner's setup being switched off") assert.equal((await agent.setOwnerSetup(false)).ok, true);
      else agent.updateApp();
      // An update replaces a runtime when its next message is about to start.
      if (replacement === "an app update after a refused turn") agent.converge();
      await agent.eventually(() => agent.harness.clients.length === 2, "the runtime is replaced", 10_000).catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
      });

      await answerOnReplacement(agent, 2);
      assert.equal(agent.published.at(-1), "Answer 2.", "the next message is delivered and answered without a person");
      assert.equal(agent.harness.launches.length, 2, "by one replacement");
      const current = await agent.view();
      assert.equal(current.condition, "none", current.last_error ?? "");

      // The same boundary "Restart and resume" records, for the runtime that had the gap.
      const boundaries = record.boundaries();
      assert.equal(boundaries.length, 1);
      assert.deepEqual([boundaries[0]!.runtime_generation_id, boundaries[0]!.phase, boundaries[0]!.mode], [gap.runtime, "complete", "resume"]);
      const archived = JSON.parse(boundaries[0]!.observer_json!) as { last_source_sequence: number; max_observed_sequence: number; source_id: string };
      assert.ok(archived.max_observed_sequence > archived.last_source_sequence, "the gap stays on record: no fact was invented to close it");
      assert.equal(archived.source_id, gap.source);
      const ref = JSON.parse(boundaries[0]!.provider_ref_json) as { provider_connection: unknown; native_runtime_death?: { pid: number } };
      assert.equal(ref.provider_connection, null);
      assert.equal(ref.native_runtime_death?.pid, 4100, "with the evidence that the process is gone");
      assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_STOPPED, ACTIVITY_RECORD_CONTINUED], "and once that a new record was started");

      // The replacement has a record of its own, without a gap.
      await agent.eventually(() => record.turns().some((turn) => turn.provider_turn_id === "turn-2" && turn.state === "terminal"), "the next turn is recorded");
      const observer = record.observer()!;
      assert.notEqual(observer.runtime, gap.runtime);
      assert.equal(observer.max, observer.last);
      assert.deepEqual((await agent.receipts()).map((row) => [row.source_message_id, row.state]),
        [["msg_1", replacement === "an app update after a refused turn" ? "acknowledged_failed" : "acknowledged"], ["msg_2", "acknowledged"]],
        "no message was cancelled");
    } finally {
      await agent.cleanup();
    }
  });
}

for (const [left, shape] of Object.entries(RECORDS_LEFT_BEHIND)) {
  test(`an agent whose record was left with ${left} is started again, records its next turns and keeps answering`, async () => {
    const agent = await codexDaemonFixture();
    const record = executionRecord(agent);
    const replaced = (count: number) => agent.eventually(() => agent.harness.clients.length === count, `runtime ${count} is started`).catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
    });
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      // The runtime the state is left on: the agent's last one, or one a crash has since replaced.
      const damaged = record.observer()!.runtime;
      const damagedGeneration = agent.read<{ id: string }>("SELECT execution_generation_id AS id FROM execution_generations WHERE agent_id=?")[0]!.id;
      if (shape.on === "earlier") {
        agent.exitProcess(0, null);
        await replaced(2);
        await agent.eventually(() => record.observer()!.runtime !== damaged, "the replacement is being recorded");
      }
      // The agent is not running, as most of the agents found in these states were not.
      assert.equal((await agent.request("manifest.set_desired_state", { id: agent.id, desired_state: "paused" })).ok, true);
      await agent.eventually(async () => (await agent.view()).observed_state === "paused", "the agent pauses");
      const runtimes = agent.harness.clients.length;
      const before = Date.parse("2026-01-01T00:00:00.000Z");

      // Build the state.
      if (shape.runtime) {
        agent.write("UPDATE execution_runtime_generations SET runtime_state=?,control_state=?,ended_at_ms=? WHERE runtime_generation_id=?",
          shape.runtime[0], shape.runtime[1], shape.runtime[0] === "exited" ? Date.now() : null, damaged);
      }
      if (shape.ending) {
        agent.write(`UPDATE work_attempt_executions SET terminal_json=json_set(json_remove(terminal_json,'$.native_runtime_death'),'$.terminal_cause',?)
          WHERE execution_generation_id=?`, shape.ending, damagedGeneration);
      }
      const leftOpen: Array<[string, string]> = [...(shape.turn ? [["turn-left-open", shape.turn] as [string, string]] : []),
        ...Array.from({ length: shape.unstarted }, (_unused, index) => [`turn-unstarted-${index}`, "none"] as [string, string])];
      for (const [index, [turn, state]] of leftOpen.entries()) {
        // Each belongs to a message that was settled long ago: nothing will read its turn back.
        const attempt = `attempt-${turn}`;
        agent.write("INSERT INTO execution_message_attempts VALUES(?,?,?,?,?,?,?,?)", attempt, agent.id, "room_1", `message-${turn}`,
          "failed", "failed", before + index, before + 60_000);
        agent.write("INSERT INTO execution_attempt_generations VALUES(?,?,?,?,?,?)", attempt, agent.id, "room_1", damagedGeneration, agent.workAttemptId, before + index);
        agent.write(`INSERT INTO execution_turns(turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,
          provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'none',?,?)`,
          turn, attempt, agent.id, "room_1", damagedGeneration, damaged, agent.threadId, turn, state, before + index, state === "lost" ? before + 60_000 : null);
      }
      if (shape.gap) agent.write("UPDATE execution_observers SET max_observed_sequence=last_source_sequence+? WHERE agent_id=?", shape.gap, agent.id);

      // The agent is started again, as an update or its owner does.
      assert.equal((await agent.request("manifest.set_desired_state", { id: agent.id, desired_state: "running" })).ok, true);
      await replaced(runtimes + 1);
      await answerOnReplacement(agent, 2);
      assert.equal(agent.published.at(-1), "Answer 2.", "the next message is delivered and answered without a person");

      // Its turn is in the record, on a new observer with no gap, behind one boundary for the runtime that was left damaged.
      const recorded = (turn: string) => agent.eventually(() => record.turns().some((row) => row.provider_turn_id === turn && row.state === "terminal"),
        `${turn} is recorded to its end`, 5_000).catch((error) => {
        throw new Error(`${(error as Error).message}: observer ${JSON.stringify(record.observer())}, turns ${JSON.stringify(record.turns())}`);
      });
      await recorded("turn-2");
      assert.equal(record.observer()!.max, record.observer()!.last, "the new record has no gap");
      assert.deepEqual(record.boundaries().map((row) => [row.runtime_generation_id, row.phase]), [[damaged, "complete"]]);
      assert.deepEqual(record.turns().filter((row) => row.provider_turn_id.startsWith("turn-left") || row.provider_turn_id.startsWith("turn-unstarted"))
        .map((row) => row.state), leftOpen.map(() => "lost"), "what was left open is recorded as lost, never as finished");
      assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_CONTINUED], "the owner is told once");

      // And it stays that way through the next replacement.
      agent.exitProcess(runtimes, null);
      await replaced(runtimes + 2);
      await answerOnReplacement(agent, 3);
      await recorded("turn-3");
      assert.deepEqual(agent.published, ["Answer 1.", "Answer 2.", "Answer 3."]);
      assert.equal(record.observer()!.max, record.observer()!.last);
      assert.equal(record.boundaries().length, 1, "a healthy replacement needs no boundary");
      assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_CONTINUED]);
      assert.deepEqual((await agent.receipts()).map((row) => [row.source_message_id, row.state]),
        [["msg_1", "acknowledged"], ["msg_2", "acknowledged"], ["msg_3", "acknowledged"]], "no message was cancelled");
    } finally {
      await agent.cleanup();
    }
  });
}

for (const state of ["lost", "active"] as const) {
  test(`a running agent with a turn left ${state} on an earlier runtime has it archived where it runs, and records its next turn`, async () => {
    const agent = await codexDaemonFixture();
    const record = executionRecord(agent);
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      const earlier = record.observer()!.runtime;
      const generation = agent.read<{ id: string }>("SELECT execution_generation_id AS id FROM execution_generations WHERE agent_id=?")[0]!.id;
      agent.exitProcess(0, null);
      await agent.eventually(() => agent.harness.clients.length === 2, "the crashed runtime is replaced");
      await agent.eventually(() => record.observer()!.runtime !== earlier, "the replacement is being recorded");
      assert.deepEqual(record.boundaries(), [], "a clean crash needs no boundary");

      // The state an earlier build left: a turn of the ended runtime that was never closed, for a message settled long ago.
      const before = Date.parse("2026-01-01T00:00:00.000Z");
      agent.write("INSERT INTO execution_message_attempts VALUES(?,?,?,?,?,?,?,?)", "attempt-left-open", agent.id, "room_1", "message-left-open", "failed", "failed", before, before + 60_000);
      agent.write("INSERT INTO execution_attempt_generations VALUES(?,?,?,?,?,?)", "attempt-left-open", agent.id, "room_1", generation, agent.workAttemptId, before);
      agent.write(`INSERT INTO execution_turns(turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,
        provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'none',?,?)`,
        "turn-left-open", "attempt-left-open", agent.id, "room_1", generation, earlier, agent.threadId, "turn-left-open", state, before, state === "lost" ? before + 60_000 : null);

      // The next convergence pass archives it; the agent is neither stopped nor restarted.
      agent.converge();
      await agent.eventually(() => record.boundaries().length === 1, "the earlier runtime is archived");
      assert.deepEqual(record.boundaries().map((row) => [row.runtime_generation_id, row.observer_json]), [[earlier, null]]);
      await answerOnReplacement(agent, 2);
      await agent.eventually(() => record.turns().some((turn) => turn.provider_turn_id === "turn-2" && turn.state === "terminal"), "the next turn is recorded", 5_000)
        .catch((error) => { throw new Error(`${(error as Error).message}: observer ${JSON.stringify(record.observer())}, turns ${JSON.stringify(record.turns())}`); });
      assert.equal(record.observer()!.max, record.observer()!.last, "with no gap");
      assert.equal(record.turns().find((turn) => turn.provider_turn_id === "turn-left-open")?.state, "lost");
      assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_CONTINUED]);
      assert.equal(agent.harness.launches.length, 2, "only the crash replaced a runtime");
      assert.deepEqual(agent.harness.signals, []);
    } finally {
      await agent.cleanup();
    }
  });
}

test("a daemon that is stopped while it is still writing an agent's activity finishes stopping, and its successor takes the agent over", async () => {
  const agent = await codexDaemonFixture();
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);

    // The app-server reports something, and the daemon is stopped before it has written it down.
    const writes = agent.holdActivityWrites();
    agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    await agent.eventually(() => writes.waiting() > 0, "the daemon starts writing the agent's activity");
    const restarting = agent.restartDaemon();
    // The stop has raised its fence, and the write is refused by it.
    writes.release();
    await restarting;

    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's process");
    assert.equal(agent.harness.launches.length, 1, "the same process: nothing was started in its place");
    await answerOnReplacement(agent, 2);
    assert.equal(agent.published.at(-1), "Answer 2.");
  } finally {
    await agent.cleanup();
  }
});

test("an agent's activity that a notice overtakes on its way to being written is kept, after the notice", async () => {
  const { EXIT_UNSETTLED_NOTICE } = await import(new URL("../../daemon/provider-terminal-coordinator.ts", import.meta.url).href);
  const agent = await codexDaemonFixture();
  type Activity = Array<{ sequence: number; summary: string; method?: string }>;
  const activity = async () => ((await agent.request("manifest.list")).result[0] as { activity?: Activity }).activity ?? [];
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    // The app-server reports something; the daemon has taken the next position for it, and its write is held there.
    const writes = agent.holdActivityWrites();
    agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    await agent.eventually(() => writes.waiting() > 0, "the daemon starts writing the agent's activity");
    // Notices are written meanwhile, as the notice of an exit that could not be recorded is, until one takes that position.
    for (let exit = 1; (await activity()).at(-1)!.sequence < writes.heldSequence(); exit += 1) {
      const before = (await activity()).at(-1)!.sequence;
      agent.exitSettlement().ports.exitUnsettled(agent.id, `exit-${exit}`);
      await agent.eventually(async () => (await activity()).at(-1)!.sequence > before, `notice ${exit} is written`);
    }
    const notice = (await activity()).at(-1)!;
    assert.deepEqual([notice.summary, notice.sequence], [EXIT_UNSETTLED_NOTICE, writes.heldSequence()], "a notice holds the position the held write took");
    writes.release();
    const after = async () => (await activity()).filter((event) => event.sequence > notice.sequence);
    await agent.eventually(async () => (await after()).some((event) => event.method === "thread/status/changed"), "the held activity is written");
    // Every write that was held goes after the notice, in turn, and none is refused for the position the notice took.
    assert.deepEqual((await after()).map((event) => event.sequence), Array.from({ length: (await after()).length }, (_unused, index) => notice.sequence + 1 + index));
  } finally {
    // A refused write would fail the stop here.
    await agent.cleanup();
  }
});

test("a daemon whose activity write fails while it stops still closes its socket and stores, reports the failure, and lets its successor take the agent over", async () => {
  const { createConnection } = await import("node:net");
  const agent = await codexDaemonFixture();
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);

    // A write of the agent's activity is still running when the daemon is stopped, and then fails, not on the stop's fence.
    const failure = new Error("Native activity sequence 10 is not newer than 10.");
    const writes = agent.holdActivityWrites(failure);
    agent.client.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
    await agent.eventually(() => writes.waiting() > 0, "the daemon starts writing the agent's activity");
    const stopping = agent.restartDaemon().then(() => null, (error: unknown) => error);
    writes.release();
    assert.equal(await stopping, failure, "the stop reports the failure");

    // The stop closed its socket all the same: nothing answers on it.
    assert.equal(await new Promise<boolean>((resolve) => {
      const socket = createConnection(agent.socketPath);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    }), false, "the daemon's socket server is closed");

    // Its lock and stores were released: a successor starts on the same paths and takes the agent over.
    await agent.startSuccessor();
    await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's process");
    await answerOnReplacement(agent, 2);
    assert.equal(agent.published.at(-1), "Answer 2.");
  } finally {
    await agent.cleanup();
  }
});

for (const gap of ["left by the daemon before it", "made by the re-attach itself"] as const) {
  test(`an idle agent that a new daemon re-attaches over a gap ${gap} is restarted once, and answers the message that was waiting`, async () => {
    const agent = await codexDaemonFixture({ recordGraceMs: 400 });
    const record = executionRecord(agent);
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      if (gap === "left by the daemon before it") await openRecordGap(agent);
      // Otherwise the gap opens during the re-attach: a turn notification that
      // arrives beside the attach's own reading of the thread cannot be
      // ordered against it, and uses up a position in the record. Here the
      // app-server repeats the ending of the last turn.
      else agent.whenNextConnects((server) => server.emit({ method: "turn/completed", params: {
        threadId: agent.threadId, turnId: "turn-1", turn: agent.turns[0] } }));
      const stuck = record.observer()!.runtime;

      // What an app update does: a new daemon finds the app-server running and attaches to it.
      await agent.restartDaemon();
      await agent.eventually(() => agent.harness.clients.length === 2, "the new daemon attaches to the running app-server");
      agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2", activation: { for_current_agent: { decision: "activate" } } });
      await agent.eventually(async () => (await agent.view()).room_agent_state.ingress.detail === RECORD_RESTART_PENDING,
        "the owner is told the agent will be restarted").catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); ingress ${JSON.stringify(current.room_agent_state.ingress)}`);
      });
      const waiting = await agent.view();
      assert.equal(waiting.condition, "none", "which is not yet a matter for the owner");
      assert.notEqual(waiting.room_agent_state.inbox.state, "blocked");

      // The daemon restarts the idle agent by itself, once.
      await agent.eventually(() => agent.harness.launches.length === 2, "the agent is restarted").catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
      });
      await agent.eventually(() => agent.harness.clients.length === 3, "the replacement is up");
      await answerOnReplacement(agent, 2);
      assert.equal(agent.published.at(-1), "Answer 2.", "the message that was waiting is answered without a person");
      assert.deepEqual(agent.harness.signals.map((signal) => signal.signal), ["SIGTERM"], "one runtime was stopped, once");
      assert.equal(agent.harness.launches.length, 2);

      // Behind the same boundary a replacement by any other cause gets.
      assert.deepEqual(record.boundaries().map((row) => [row.runtime_generation_id, row.phase]), [[stuck, "complete"]]);
      assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_STOPPED, ACTIVITY_RECORD_CONTINUED],
        "the owner is told once that the record stopped, however many daemons saw it, and once that a new one was started");
      await agent.eventually(() => record.turns().some((turn) => turn.provider_turn_id === "turn-2" && turn.state === "terminal"), "the next turn is recorded");
      assert.equal(record.observer()!.max, record.observer()!.last);
      const current = await agent.view();
      assert.equal(current.condition, "none", current.last_error ?? "");
      assert.deepEqual((await agent.receipts()).map((row) => [row.source_message_id, row.state]),
        [["msg_1", "acknowledged"], ["msg_2", "acknowledged"]], "no message was cancelled");

      // And it is left alone from then on.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(agent.harness.launches.length, 2);
    } finally {
      await agent.cleanup();
    }
  });
}

for (const gap of ["left by the daemon before it", "made by the re-attach itself"] as const) {
  test(`an agent a new daemon re-attaches mid-turn over a gap ${gap}, with its saved state still working, is restarted once the turn ends and answers`, async () => {
    const agent = await codexDaemonFixture({ recordGraceMs: 400 });
    try {
      await agent.deliver(1, { answer: "Answer 1." });
      await agent.turnsRecorded(1);
      agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2", activation: { for_current_agent: { decision: "activate" } } });
      await agent.eventually(async () => agent.turns.length === 2 && Boolean((await agent.receipt("msg_2"))?.provider_turn_id), "msg_2 starts its turn");
      const turn = agent.turns[1]!;
      agent.client.emit({ method: "turn/started", params: { threadId: agent.threadId, turnId: turn.id, turn: { id: turn.id, status: "inProgress" } } });
      await agent.eventually(async () => (await agent.view()).observed_state === "working", "the agent is saved as working");
      if (gap === "left by the daemon before it") await openRecordGap(agent);
      // A notification the attach reads beside its own snapshot uses up a position without a fact.
      else agent.whenNextConnects((server) => server.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: "turn-1", turn: agent.turns[0] } }));
      await agent.restartDaemon();
      await agent.eventually(() => agent.holdsRuntime(), "the new daemon attaches the agent's process");
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal((await agent.view()).observed_state, "working", "the blocked record leaves the saved state at working");
      assert.deepEqual(agent.harness.signals, [], "and the running turn is not interrupted");

      // The turn ends on the process the new daemon attached.
      const attached = agent.harness.clients.at(-1)!;
      Object.assign(turn, { status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answer 2." }] });
      attached.emit({ method: "thread/status/changed", params: { threadId: agent.threadId, status: { type: "idle" } } });
      attached.emit({ method: "turn/completed", params: { threadId: agent.threadId, turnId: turn.id, turn } });
      agent.whenNextConnects((server) => agent.serveThread(server));
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered", 12_000).catch(async (error) => {
        const row = await agent.receipt("msg_2");
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: row is ${row?.state}; agent is ${current.observed_state}/${current.condition}; ${current.room_agent_state.ingress.detail}`);
      });
      await answerOnReplacement(agent, 3);
      assert.deepEqual(agent.published, ["Answer 1.", "Answer 2.", "Answer 3."], "each answer once; the turn was not run again");
      assert.equal(agent.harness.launches.length, 2, "one restart");
    } finally {
      await agent.cleanup();
    }
  });
}

test("an agent whose replacement is blocked by its record as well is not restarted again: it waits for its owner, with the reason", async () => {
  const agent = await codexDaemonFixture({ recordGraceMs: 400 });
  const record = executionRecord(agent);
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    await openRecordGap(agent);
    await agent.restartDaemon();
    await agent.eventually(() => agent.harness.clients.length === 2, "the new daemon attaches to the running app-server");
    // The replacement's record gets a gap before it is admitted: its app-server
    // reports the ending of a turn nobody can place while it is still starting.
    agent.whenNextConnects((server) => server.emit({ method: "turn/completed", params: {
      threadId: agent.threadId, turnId: "unknown-turn", turn: { id: "another-turn", status: "completed" } } }));
    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2", activation: { for_current_agent: { decision: "activate" } } });

    await agent.eventually(() => agent.harness.launches.length === 2, "the agent is restarted once");
    const reason = "Part of this agent's activity record is missing, and restarting the agent did not get past it. "
      + "Messages wait until you use Restart and resume in Diagnostics.";
    await agent.eventually(async () => (await agent.view()).last_error === reason, "the owner is told why the agent needs attention").catch(async (error) => {
      const current = await agent.view();
      throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); ingress ${JSON.stringify(current.room_agent_state.ingress)}`);
    });
    const blocked = await agent.view();
    assert.equal(blocked.condition, "coordination_blocked");
    assert.equal(blocked.room_agent_state.inbox.state, "blocked");

    // Ten more waits of the same length: nothing else is stopped or started.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.equal(agent.harness.launches.length, 2, "no second restart");
    assert.deepEqual(agent.harness.signals.map((signal) => signal.signal), ["SIGTERM"]);
    assert.equal((await agent.view()).last_error, reason);
    assert.equal((await agent.receipt("msg_2"))?.state ?? "pending", "pending", "the waiting message is kept, not cancelled");
    assert.equal(record.boundaries().length, 1, "one boundary, for the runtime that was restarted");
  } finally {
    await agent.cleanup();
  }
});

test("an agent whose record is full keeps answering, and its next runtime starts a new record", async () => {
  const agent = await codexDaemonFixture({ recordGraceMs: 400 });
  const record = executionRecord(agent);
  try {
    await agent.deliver(1, { answer: "Answer 1." });
    await agent.turnsRecorded(1);
    // The record holds 10,000 facts for one agent. Fill it up to there, as weeks of work do.
    const filled = record.observer()!;
    const generation = agent.read<{ id: string }>("SELECT execution_generation_id AS id FROM execution_generations WHERE agent_id=?")[0]!.id;
    agent.write(`WITH RECURSIVE positions(value) AS (SELECT 1000001 UNION ALL SELECT value+1 FROM positions WHERE value<1010000)
      INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,
        source_sequence,domain,kind,state,side_effects,observed_at_ms)
      SELECT 'filler-'||value,?,?,?,1,value,'control','state_changed','responsive','none',value FROM positions`, agent.id, generation, filled.runtime);
    // Each with its settled effect, as every recorded fact has.
    agent.write(`INSERT INTO execution_lifecycle_effects(fact_id,fact_sequence,agent_id,observer_execution_generation_id,observer_runtime_generation_id,
        observer_epoch,subject_authority_mode,observer_authority_mode,effect_kind,state,created_at_ms,disposed_at_ms)
      SELECT fact_id,sequence,agent_id,execution_generation_id,runtime_generation_id,1,'typed','typed','none','applied',observed_at_ms,observed_at_ms
      FROM execution_facts WHERE agent_id=? AND fact_id LIKE 'filler-%'`, agent.id);

    // The next turn cannot be recorded. It is still delivered and answered, and the owner is told the record stopped.
    await agent.deliver(2, { answer: "Answer 2." });
    await agent.eventually(async () => (await record.notices()).includes(ACTIVITY_RECORD_STOPPED), "the owner is told the record stopped");
    assert.equal((await agent.view()).condition, "none", "which asks nothing of the owner");
    assert.ok(record.observer()!.max > record.observer()!.last, "the record stops at the fact it had no room for");

    // Its next runtime is recorded again, from the start of a new window; nothing was deleted to make room.
    agent.exitProcess(0, null);
    await agent.eventually(() => agent.harness.clients.length === 2, "the crashed runtime is replaced");
    await answerOnReplacement(agent, 3);
    assert.deepEqual(agent.published, ["Answer 1.", "Answer 2.", "Answer 3."]);
    await agent.eventually(() => record.turns().some((turn) => turn.provider_turn_id === "turn-3" && turn.state === "terminal"), "the next turn is recorded", 5_000)
      .catch(async (error) => {
        const current = await agent.view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); observer ${JSON.stringify(record.observer())}`);
      });
    assert.equal(record.observer()!.max, record.observer()!.last);
    assert.deepEqual(record.boundaries().map((row) => row.runtime_generation_id), [filled.runtime]);
    assert.deepEqual(await record.notices(), [ACTIVITY_RECORD_STOPPED, ACTIVITY_RECORD_CONTINUED]);
    assert.ok(agent.read<{ n: number }>("SELECT COUNT(*) AS n FROM execution_facts WHERE agent_id=?")[0]!.n > 10_000, "the full record is still there");
    assert.equal(agent.harness.launches.length, 2, "one replacement, and no restart for the record's sake");
  } finally {
    await agent.cleanup();
  }
});

test("an error activity line is generic without a reason, bounded, and free of credentials", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
  const handle = await adapter.spawn(spawnRequest());
  for (const error of [undefined, {}, { message: "   " }, { message: 7 }]) {
    harness.clients[0]!.emit({ method: "error", params: { threadId: handle.providerContinuationId, error } });
  }
  harness.clients[0]!.emit({ method: "error", params: {
    threadId: handle.providerContinuationId, error: { message: `first line\n  second line ${"x".repeat(600)}` },
  } });
  // Only the `error` notification is the provider's reason for a failed turn.
  // Another notification that happens to carry an error keeps its own summary.
  harness.clients[0]!.emit({ method: "thread/tokenUsage/updated", params: {
    threadId: handle.providerContinuationId, error: { message: "not a failed turn" },
  } });
  assert.doesNotMatch(stream.find((event) => event.method === "thread/tokenUsage/updated")?.summary ?? "", /^Codex error:/);
  const lines = stream.filter((event) => event.method === "error").map((event) => event.summary);
  assert.deepEqual(lines.slice(0, 4), Array(4).fill("Codex runtime event: error"));
  assert.match(lines[4] ?? "", /^Codex error: first line second line x+$/);
  assert.equal(lines[4]?.length, 500, "the line is bounded");

  // A provider can echo the credential it rejected. Built at run time so no
  // credential-shaped literal sits in this file.
  const echoed = "ab12".repeat(8);
  harness.clients[0]!.emit({ method: "error", params: {
    threadId: handle.providerContinuationId, error: { message: `The key was rejected: Bearer ${echoed}` },
  } });
  const redacted = stream.filter((event) => event.method === "error").at(-1)?.summary ?? "";
  assert.equal(redacted, "Codex error: The key was rejected: Bearer [REDACTED]");
  assert.equal(redacted.includes(echoed), false, "a credential in the provider's reason never reaches the activity line");
});
