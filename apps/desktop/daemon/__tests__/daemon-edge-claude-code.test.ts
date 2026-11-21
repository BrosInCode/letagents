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
  /** The texts of the user lines the daemon wrote to start `launch`, in order. */
  prompts(launch: number): string[];
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
  for (const file of readdirSync(planDir)) {
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
  return {
    harness,
    agent,
    planDir,
    hold: (label) => writeFileSync(join(planDir, `hold-${label}`), ""),
    release: (label) => rmSync(join(planDir, `hold-${label}`), { force: true }),
    reached: (launch, label) => waitFor(`start ${launch} of the stand-in at ${label}`, () => existsSync(claimFile(launch, `reached-${label}`))),
    prompts: (launch) => readFileSync(claimFile(launch, "outbound.ndjson"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: { content?: Array<{ type: string; text?: string }> } })
      .filter((frame) => frame.type === "user")
      .map((frame) => (frame.message?.content ?? []).map((block) => block.text ?? "").join("")),
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
        const prompts = scenario.prompts(1);
        assert.equal(prompts.length, 2);
        assert.match(prompts[1]!, /EDGE_SAY\[claude-ready\]/);

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
