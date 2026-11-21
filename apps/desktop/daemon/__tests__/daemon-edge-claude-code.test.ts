import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadProviderReplayTranscript } from "../../electron/__tests__/provider-replay/transcript.js";
import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  startEdgeDaemon,
  type EdgeAgentRegistration,
  type EdgeDaemonHarness,
} from "./edge/daemon-edge-harness.js";
import { promptSourceText } from "./edge/claude-code/prompt-source.js";

// The daemon edge scenarios for Claude Code. The daemon is a real process, and
// a test talks to it over the control socket only. In place of the `claude`
// program the daemon starts a stand-in that replays a recording of the real
// one (edge/claude-code/replay-cli.mjs).
//
// A scenario is a plan folder: one recorded transcript for each start of the
// program. The recordings are made by edge/claude-code/record-scenarios.ts
// and redact-capture.ts, never by hand.

const REPLAY_CLI = fileURLToPath(new URL("./edge/claude-code/replay-cli.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./edge/claude-code/fixtures", import.meta.url));
const WAIT_MS = 30_000;

interface ClaudeScenario {
  harness: EdgeDaemonHarness;
  agent: EdgeAgentRegistration;
  planDir: string;
  /** Stop the stand-in before the inbound entry with this label, from now on. */
  hold(label: string): void;
  release(label: string): void;
  /** Wait until start `launch` of the stand-in stands at the hold `label`. */
  reached(launch: number, label: string): Promise<void>;
  /** Wait until start `launch` of the stand-in has written the inbound entry with this label. */
  emitted(launch: number, label: string): Promise<void>;
  /** The texts of the user lines the daemon wrote to start `launch`, in order. */
  prompts(launch: number): string[];
  /**
   * The text of the room message each prompt of start `launch` is for, in order. A prompt also
   * quotes other recent room messages, so only its "Source message" line says which one it answers.
   * The first prompt of a session is for no room message: null.
   */
  sources(launch: number): Array<string | null>;
  /** What went wrong in a stand-in, if anything did: a line the recording does not have. */
  standInErrors(): string[];
}

async function waitFor(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function startClaudeScenario(name: string): Promise<ClaudeScenario> {
  const planDir = mkdtempSync(join(tmpdir(), `edge-claude-${name}-`));
  cpSync(join(FIXTURES, name), planDir, { recursive: true });
  for (const file of readdirSync(planDir).filter((name) => name.startsWith("launch-"))) {
    const transcript = loadProviderReplayTranscript(join(planDir, file));
    assert.equal(transcript.start.provider, "claude-code");
    assert.equal(transcript.start.protocol, "claude-code.cli/stream-json-stdio");
  }
  const harness = await startEdgeDaemon({
    shims: [{
      name: "claude",
      scriptPath: REPLAY_CLI,
      envVar: "LETAGENTS_CLAUDE_CODE_BIN",
      env: { LETAGENTS_EDGE_CLAUDE_REPLAY_DIR: planDir },
    }],
  });
  harness.onDispose(() => rmSync(planDir, { recursive: true, force: true }));
  const agent: EdgeAgentRegistration = {
    entryId: `agent_claude_${name}`,
    roomId: `edge_claude_${name}`,
    provider: "claude-code",
    displayName: `Edge Claude ${name}`,
    model: "sonnet",
    permissionProfileId: "full_access",
  };
  const claimFile = (launch: number, file: string): string => join(planDir, `claim-${launch}`, file);
  const prompts = (launch: number): string[] => readFileSync(claimFile(launch, "outbound.ndjson"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; message?: { content?: Array<{ type: string; text?: string }> } })
    .filter((frame) => frame.type === "user")
    .map((frame) => (frame.message?.content ?? []).map((block) => block.text ?? "").join(""));
  return {
    harness,
    agent,
    planDir,
    hold: (label) => writeFileSync(join(planDir, `hold-${label}`), ""),
    release: (label) => rmSync(join(planDir, `hold-${label}`), { force: true }),
    reached: (launch, label) => waitFor(`start ${launch} of the stand-in at ${label}`, () => existsSync(claimFile(launch, `reached-${label}`))),
    emitted: (launch, label) => waitFor(`start ${launch} of the stand-in to emit ${label}`, () => {
      const path = claimFile(launch, "emitted.ndjson");
      return existsSync(path) && readFileSync(path, "utf8").split("\n").filter(Boolean)
        .some((line) => (JSON.parse(line) as { label: string | null }).label === label);
    }),
    prompts,
    sources: (launch) => prompts(launch).map(promptSourceText),
    standInErrors: () => readdirSync(planDir).filter((entry) => entry.startsWith("claim-"))
      .map((entry) => join(planDir, entry, "error.txt")).filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8")),
  };
}

async function startAgentAndWaitIdle(scenario: ClaudeScenario): Promise<void> {
  await scenario.harness.startAgent(scenario.agent);
  const ready = await scenario.harness.waitForEntry(
    scenario.agent.entryId,
    (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
    WAIT_MS,
    "claude idle with a session",
  );
  assert.equal(ready.condition, "none");
}

async function waitTurnIdle(scenario: ClaudeScenario): Promise<void> {
  await scenario.harness.waitForEntry(
    scenario.agent.entryId,
    (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
    WAIT_MS,
    "claude idle after the turn",
  );
}

/** On a failure, say what the stand-in and the daemon saw: the assertion alone does not. */
async function inScenario(scenario: ClaudeScenario, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    assert.deepEqual(scenario.standInErrors(), [], "the daemon sent only what the recording has");
  } catch (error) {
    const errors = scenario.standInErrors();
    if (errors.length) console.error(`stand-in claude:\n${errors.join("")}`);
    console.error(`daemon stderr (end):\n${scenario.harness.daemonOutput().stderr.slice(-3000)}`);
    throw error;
  } finally {
    await scenario.harness.dispose();
  }
}

describe(
  "daemon edge suite: claude-code (black-box child process)",
  { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false },
  () => {
    test("1. start agent, deliver one room message, publish exactly one reply", async () => {
      const scenario = await startClaudeScenario("simple");
      const { harness, agent } = scenario;
      await inScenario(scenario, async () => {
        await startAgentAndWaitIdle(scenario);
        harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[claude-ready]" });

        const published = await harness.roomServer.waitForPublishedMessages(agent.roomId, (messages) => messages.length >= 1, WAIT_MS);
        await waitTurnIdle(scenario);
        assert.deepEqual(harness.roomServer.publishedMessages(agent.roomId).map((message) => message.text), ["claude-ready"]);
        assert.equal(published.length, 1);

        // One start of the program, and two prompts on it: the first prompt of the session, then the room message.
        assert.equal(existsSync(join(scenario.planDir, "claim-2")), false);
        assert.deepEqual(scenario.sources(1), [null, "EDGE_SAY[claude-ready]"]);

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
          const inbox = sqlite.inboxItems(agent.entryId);
          assert.equal(inbox.length, 1);
          assert.equal(inbox[0]!.state, "acknowledged");
        } finally {
          sqlite.close();
        }
      });
    });

    test("2. FIFO order: one message in a turn, two more in the queue", async () => {
      const scenario = await startClaudeScenario("fifo-three");
      const { harness, agent } = scenario;
      await inScenario(scenario, async () => {
        await startAgentAndWaitIdle(scenario);

        // Keep the turn of A open. B and C then both wait, so the daemon has a choice to make:
        // with one message in the queue, any order of taking is the right one.
        scenario.hold("t2-result");
        harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[reply-a]" });
        await scenario.reached(1, "t2-result");
        harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[reply-b]" });
        harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[reply-c]" });
        await harness.waitForEntry(
          agent.entryId,
          (entry) => entry.room_agent_state?.inbox.pending_count === 3 && entry.room_agent_state.turn.state === "responding",
          WAIT_MS,
          "B and C in the queue behind the open turn of A",
        );
        assert.equal(harness.roomServer.publishedMessages(agent.roomId).length, 0);
        scenario.release("t2-result");

        // Check the order as soon as the daemon takes the next message, so that a wrong order
        // fails here, by name, and not later by a wait for replies that never come.
        await waitFor("the prompt for the next room message", () => scenario.sources(1).length >= 3);
        assert.equal(scenario.sources(1)[2], "EDGE_SAY[reply-b]", "the daemon takes B, the older waiting message, before C");

        await harness.roomServer.waitForPublishedMessages(agent.roomId, (messages) => messages.length >= 3, WAIT_MS);
        await harness.waitForEntry(
          agent.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle"
            && entry.room_agent_state.inbox.pending_count === 0,
          WAIT_MS,
          "claude idle with an empty queue",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agent.roomId).map((message) => message.text),
          ["reply-a", "reply-b", "reply-c"],
        );

        // The stand-in does not compare prompt text, so the order at the program is proved here:
        // the daemon gave it B before C.
        assert.deepEqual(scenario.sources(1), [null, "EDGE_SAY[reply-a]", "EDGE_SAY[reply-b]", "EDGE_SAY[reply-c]"]);

        const sqlite = harness.openSqlite();
        try {
          const inbox = sqlite.inboxItems(agent.entryId);
          assert.deepEqual(inbox.map((item) => item.state), ["acknowledged", "acknowledged", "acknowledged"]);
        } finally {
          sqlite.close();
        }
      });
    });

    test("3. interrupt during a turn", async () => {
      const scenario = await startClaudeScenario("turn-interrupt");
      const { harness, agent } = scenario;
      await inScenario(scenario, async () => {
        const { daemonGeneration } = await harness.startAgent(agent);
        await harness.waitForEntry(
          agent.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          WAIT_MS,
          "claude idle with a session",
        );

        // The recording has no answer for this turn: after its start the program waits for the interrupt.
        harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[never-sent]" });
        const active = await harness.waitForEntry(
          agent.entryId,
          (entry) => entry.room_agent_state?.turn.state === "responding"
            && Boolean(entry.room_agent_state.turn.provider_turn_id)
            && Boolean(entry.room_agent_state.turn.inbox_item_id)
            && Boolean(entry.room_agent_state.turn.source_message_id),
          WAIT_MS,
          "a responding turn",
        );

        const control = await harness.rpc.controlTurn({
          id: agent.entryId,
          daemon_generation: daemonGeneration,
          room_id: agent.roomId,
          work_attempt_id: active.provider_ref!.work_attempt_id,
          execution_generation_id: active.provider_ref!.execution_generation_id,
          provider_continuation_id: active.provider_ref!.provider_continuation_id,
          provider_turn_id: active.room_agent_state!.turn.provider_turn_id!,
          inbox_item_id: active.room_agent_state!.turn.inbox_item_id!,
          source_message_id: active.room_agent_state!.turn.source_message_id!,
          action_id: "edge-claude-interrupt-1",
          action_sequence: 1,
          correction: null,
        });
        assert.equal(control.state, "idle");
        await waitTurnIdle(scenario);

        // The interrupt went to the program as a control request, on the session that stays alive.
        const outbound = readFileSync(join(scenario.planDir, "claim-1", "outbound.ndjson"), "utf8").split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; request?: { subtype?: string } });
        assert.deepEqual(outbound.map((frame) => frame.request?.subtype ?? frame.type), ["user", "user", "interrupt"]);
        assert.equal(existsSync(join(scenario.planDir, "claim-2")), false);
        assert.equal(harness.roomServer.publishedMessages(agent.roomId).length, 0);

        const sqlite = harness.openSqlite();
        try {
          const inbox = sqlite.inboxItems(agent.entryId);
          assert.equal(inbox.length, 1);
          assert.ok(
            ["cancelled_by_user", "acknowledged_failed"].includes(String(inbox[0]!.state)),
            `the interrupted turn settles with no reply, got ${String(inbox[0]!.state)}`,
          );
        } finally {
          sqlite.close();
        }
      });
    });

    test("4. kill the daemon during a turn, restart it: no lost reply and no duplicate reply", async () => {
      const scenario = await startClaudeScenario("kill-recover");
      const { harness, agent } = scenario;
      await inScenario(scenario, async () => {
        await startAgentAndWaitIdle(scenario);

        // The program reports its answer, and the daemon dies before the end of the turn reaches it:
        // the recording has the assistant message of this turn and no result.
        harness.roomServer.enqueueMessage(agent.roomId, { text: "EDGE_SAY[survived-kill]" });
        await scenario.emitted(1, "t2-assistant");
        await harness.waitForEntry(
          agent.entryId,
          (entry) => entry.room_agent_state?.turn.state === "responding" && Boolean(entry.room_agent_state.turn.provider_turn_id),
          WAIT_MS,
          "a responding turn that the daemon has recorded",
        );
        assert.equal(harness.roomServer.publishedMessages(agent.roomId).length, 0);
        await harness.kill("SIGKILL");

        // The test does not wait for the program to end here. What becomes of a program whose daemon
        // died differs by platform, and the daemon that starts next has to deal with each case. The
        // end of the turn is in the program's session file, which the stand-in wrote when it reported
        // its answer.
        assert.equal(existsSync(join(scenario.planDir, "claim-1", "session-error.txt")), false);
        assert.equal(harness.roomServer.publishedMessages(agent.roomId).length, 0);

        const restarted = await harness.restart();
        assert.ok(restarted.healthy);
        await harness.reinstallCredentials(agent, restarted.generation);

        await harness.roomServer.waitForPublishedMessages(agent.roomId, (messages) => messages.length >= 1, WAIT_MS);
        const after = await harness.waitForEntry(
          agent.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle"
            && entry.room_agent_state.inbox.pending_count === 0,
          WAIT_MS,
          "claude idle on a new start, with an empty queue",
        );
        assert.equal(after.condition, "none");

        // Idle with an empty queue: the daemon has nothing left to publish. One reply, the recorded one.
        assert.deepEqual(harness.roomServer.publishedMessages(agent.roomId).map((message) => message.text), ["survived-kill"]);

        // The room message went to the program once. The second start resumed the session and got the first prompt only.
        assert.deepEqual(scenario.sources(1), [null, "EDGE_SAY[survived-kill]"]);
        assert.deepEqual(scenario.sources(2), [null]);
        const resumed = JSON.parse(readFileSync(join(scenario.planDir, "claim-2", "launch.json"), "utf8")) as { argv: string[]; sessionId: string };
        const first = JSON.parse(readFileSync(join(scenario.planDir, "claim-1", "launch.json"), "utf8")) as { sessionId: string };
        assert.ok(resumed.argv.includes("--resume"));
        assert.equal(resumed.sessionId, first.sessionId);
        assert.equal(existsSync(join(scenario.planDir, "claim-3")), false);

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
          const inbox = sqlite.inboxItems(agent.entryId);
          assert.equal(inbox.length, 1);
          assert.equal(inbox[0]!.state, "acknowledged");
        } finally {
          sqlite.close();
        }
      });
    });
  },
);
