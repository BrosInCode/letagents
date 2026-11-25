import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  type EdgeHostApprovalCandidate,
} from "./edge/daemon-edge-harness.js";

// The daemon edge scenarios for Antigravity. The daemon is a real process, and
// a test talks to it over the control socket only. In place of `agy acp` the
// daemon starts a stand-in that replays a recording of the real one
// (edge/antigravity/replay-cli.mjs).
//
// The `approval` plan is one real room turn under Ask before writes (agy
// 1.5.16): agy asks to write a file and the answer was allow, then asks to run
// a command and the answer was deny. `launch-2` is a real `session/resume` in a
// new agy process. The turns after the two other answers are derived from the
// same recording (edge/antigravity/derive-branches.mjs); their headers say so.

const REPLAY_CLI = fileURLToPath(new URL("./edge/antigravity/replay-cli.mjs", import.meta.url));
const PLAN = fileURLToPath(new URL("./edge/antigravity/fixtures/approval", import.meta.url));
const WAIT_MS = 30_000;

interface AgyScenario {
  harness: EdgeDaemonHarness;
  agent: EdgeAgentRegistration;
  planDir: string;
  /** The permission answers start `launch` got, and the path each took. */
  answers(launch: number): Array<{ label: string | null; outcome: { outcome?: string; optionId?: string } | null; path: string }>;
  /** The ACP methods the daemon called on start `launch`, in order (probes left out). */
  methods(launch: number): string[];
  launches(): number;
  standInErrors(): string[];
}

const readLines = (path: string): Array<Record<string, any>> => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
  : [];

async function startAgyScenario(name: string): Promise<AgyScenario> {
  const planDir = mkdtempSync(join(tmpdir(), `edge-agy-${name}-`));
  cpSync(PLAN, planDir, { recursive: true });
  for (const file of readdirSync(planDir).filter((entry) => entry.endsWith(".ndjson"))) {
    const transcript = loadProviderReplayTranscript(join(planDir, file));
    assert.equal(transcript.start.provider, "antigravity");
    assert.equal(transcript.start.protocol, "antigravity.acp/stdio");
  }
  const harness = await startEdgeDaemon({
    shims: [{
      name: "agy",
      scriptPath: REPLAY_CLI,
      envVar: "LETAGENTS_ANTIGRAVITY_BIN",
      env: { LETAGENTS_EDGE_AGY_REPLAY_DIR: planDir },
    }],
  });
  harness.onDispose(() => rmSync(planDir, { recursive: true, force: true }));
  const agent: EdgeAgentRegistration = {
    entryId: `agent_agy_${name}`,
    roomId: `edge_agy_${name}`,
    provider: "antigravity",
    displayName: `Edge Antigravity ${name}`,
    model: null,
    permissionProfileId: "ask_before_write",
  };
  const claim = (launch: number, file: string): string => join(planDir, `claim-${launch}`, file);
  return {
    harness,
    agent,
    planDir,
    answers: (launch) => readLines(claim(launch, "answers.ndjson")) as ReturnType<AgyScenario["answers"]>,
    methods: (launch) => readLines(claim(launch, "outbound.ndjson"))
      .filter((message) => typeof message.method === "string" && message.method !== "letagents/probe")
      .map((message) => message.method as string),
    launches: () => readdirSync(planDir).filter((entry) => entry.startsWith("claim-")).length,
    standInErrors: () => readdirSync(planDir).filter((entry) => entry.startsWith("claim-"))
      .map((entry) => join(planDir, entry, "error.txt")).filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8")),
  };
}

async function startAgentAndWaitIdle(scenario: AgyScenario): Promise<string> {
  await scenario.harness.startAgent(scenario.agent);
  const ready = await scenario.harness.waitForEntry(
    scenario.agent.entryId,
    (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
    WAIT_MS,
    "antigravity idle with a session",
  );
  assert.equal(ready.condition, "none");
  return ready.provider_ref!.provider_continuation_id!;
}

/** The pending prompt that is not one of `seen`, by its reference. */
function nextPrompt(scenario: AgyScenario, seen: Set<string>): Promise<EdgeHostApprovalCandidate> {
  return scenario.harness.waitForApproval(
    scenario.agent.roomId,
    (candidate) => candidate.status === "pending" && Boolean(candidate.reference) && !seen.has(JSON.stringify(candidate.reference)),
    WAIT_MS,
  );
}

async function decide(scenario: AgyScenario, seen: Set<string>, decision: "allow_once" | "deny"): Promise<EdgeHostApprovalCandidate> {
  const prompt = await nextPrompt(scenario, seen);
  seen.add(JSON.stringify(prompt.reference));
  assert.equal(await scenario.harness.rpc.decideHostApproval(prompt, decision), "decision_sent");
  return prompt;
}

async function waitTurnSettled(scenario: AgyScenario): Promise<void> {
  await scenario.harness.waitForEntry(
    scenario.agent.entryId,
    (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn?.state === "idle"
      && (entry.room_agent_state?.inbox?.pending_count ?? 0) === 0,
    WAIT_MS,
    "antigravity idle after the turn",
  );
}

const EDIT_REQUEST = "Edge recording. Write approval-a.txt, then run touch approval-b.txt.";

describe("daemon edge: Antigravity", { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false }, () => {
  test("the recorded turn: write allowed, command denied, so the turn ends with no reply", async () => {
    const scenario = await startAgyScenario("recorded");
    try {
      await startAgentAndWaitIdle(scenario);
      scenario.harness.roomServer.enqueueMessage(scenario.agent.roomId, { text: EDIT_REQUEST });
      const seen = new Set<string>();
      await decide(scenario, seen, "allow_once");
      await decide(scenario, seen, "deny");
      await waitTurnSettled(scenario);
      assert.deepEqual(scenario.harness.roomServer.publishedMessages(scenario.agent.roomId), []);
      assert.deepEqual(scenario.answers(1).map((answer) => [answer.outcome?.optionId, answer.path]), [["allow", "recorded"], ["deny", "recorded"]]);
      assert.deepEqual(scenario.methods(1), ["initialize", "session/new", "session/set_mode", "session/prompt"]);
      assert.deepEqual(scenario.standInErrors(), []);
    } finally {
      await scenario.harness.dispose();
    }
  });

  test("a denied write ends the turn at once with no reply and no second prompt", async () => {
    const scenario = await startAgyScenario("deny-first");
    try {
      await startAgentAndWaitIdle(scenario);
      scenario.harness.roomServer.enqueueMessage(scenario.agent.roomId, { text: EDIT_REQUEST });
      await decide(scenario, new Set(), "deny");
      await waitTurnSettled(scenario);
      assert.deepEqual(scenario.harness.roomServer.publishedMessages(scenario.agent.roomId), []);
      assert.deepEqual(scenario.answers(1).map((answer) => [answer.outcome?.optionId, answer.path]), [["deny", "branch"]]);
      const pending = (await scenario.harness.rpc.listHostApprovals(scenario.agent.roomId)).filter((candidate) => candidate.status === "pending");
      assert.deepEqual(pending, []);
      assert.deepEqual(scenario.standInErrors(), []);
    } finally {
      await scenario.harness.dispose();
    }
  });

  test("two allowed actions end the turn with exactly one reply", async () => {
    const scenario = await startAgyScenario("allow-both");
    try {
      await startAgentAndWaitIdle(scenario);
      scenario.harness.roomServer.enqueueMessage(scenario.agent.roomId, { text: EDIT_REQUEST });
      const seen = new Set<string>();
      await decide(scenario, seen, "allow_once");
      await decide(scenario, seen, "allow_once");
      const reply = readLines(join(scenario.planDir, "branch-permission-2-allow.ndjson"))
        .find((entry) => entry.label === "reply")!.frame.params.update.content.text as string;
      const posts = await scenario.harness.roomServer.waitForPublishedMessages(scenario.agent.roomId, (messages) => messages.length >= 1, WAIT_MS);
      await waitTurnSettled(scenario);
      assert.deepEqual(posts.map((message) => message.text), [reply]);
      assert.equal(scenario.harness.roomServer.publishedMessages(scenario.agent.roomId).length, 1);
      assert.deepEqual(scenario.answers(1).map((answer) => [answer.outcome?.optionId, answer.path]), [["allow", "recorded"], ["allow", "branch"]]);
      assert.deepEqual(scenario.standInErrors(), []);
    } finally {
      await scenario.harness.dispose();
    }
  });

  test("a daemon kill while a prompt is open: the new daemon resumes the session and closes the old prompt", async () => {
    const scenario = await startAgyScenario("kill-open-prompt");
    try {
      const session = await startAgentAndWaitIdle(scenario);
      scenario.harness.roomServer.enqueueMessage(scenario.agent.roomId, { text: EDIT_REQUEST });
      const prompt = await nextPrompt(scenario, new Set());
      await scenario.harness.kill("SIGKILL");
      const status = await scenario.harness.restart();
      await scenario.harness.reinstallCredentials(scenario.agent, status.generation);
      const resumed = await scenario.harness.waitForEntry(
        scenario.agent.entryId,
        (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id) && scenario.launches() >= 2,
        WAIT_MS,
        "antigravity idle again after the take-over",
      );
      assert.equal(resumed.provider_ref?.provider_continuation_id, session);
      assert.deepEqual(scenario.methods(2), ["initialize", "session/resume", "session/set_mode"]);
      // agy keeps a permission request in its own process only: the daemon has closed the prompt of the old process.
      assert.equal(await scenario.harness.rpc.decideHostApproval(prompt, "allow_once"), "request_closed");
      await waitTurnSettled(scenario);
      // The turn is not sent again to the new process: its transcript has no prompt, and it got no answer.
      assert.deepEqual(scenario.answers(2), []);
      const pending = (await scenario.harness.rpc.listHostApprovals(scenario.agent.roomId)).filter((candidate) => candidate.status === "pending");
      assert.deepEqual(pending, []);
      assert.deepEqual(scenario.harness.roomServer.publishedMessages(scenario.agent.roomId), []);
      assert.deepEqual(scenario.standInErrors(), []);
    } finally {
      await scenario.harness.dispose();
    }
  });
});
