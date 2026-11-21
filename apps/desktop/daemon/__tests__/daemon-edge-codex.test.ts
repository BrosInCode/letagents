import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadProviderReplayTranscript } from "../../electron/__tests__/provider-replay/transcript.js";
import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  findProcessesReferencingPath,
  startEdgeDaemon,
  type EdgeAgentRegistration,
  type EdgeDaemonHarness,
} from "./edge/daemon-edge-harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_EDGE_DIR = resolve(HERE, "edge/codex");
const CODEX_SERVER_SCRIPT = join(CODEX_EDGE_DIR, "server.mjs");
const FIXTURES_DIR = join(CODEX_EDGE_DIR, "fixtures");

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, `${name}.ndjson`);
}

function sourceMessageText(prompt: string): string | null {
  const line = /^Source message: (.*)$/m.exec(prompt)?.[1];
  return line ? (JSON.parse(line) as { text: string }).text : null;
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for synchronization marker ${path}`);
}

async function startCodexScenario(
  scenario: string,
  overrides: Partial<EdgeAgentRegistration> = {},
): Promise<{
  harness: EdgeDaemonHarness;
  controlDir: string;
  agentConfig: EdgeAgentRegistration;
}> {
  const transcriptFile = fixturePath(scenario);
  const parsed = loadProviderReplayTranscript(transcriptFile);
  assert.equal(parsed.start.provider, "codex");
  assert.equal(parsed.start.protocol, "codex.app-server/jsonrpc-ws");

  const controlDir = await mkdtemp(join(tmpdir(), `letagents-codex-ctrl-${scenario}-`));
  const harness = await startEdgeDaemon({
    shims: [
      {
        name: "codex",
        scriptPath: CODEX_SERVER_SCRIPT,
        envVar: "LETAGENTS_CODEX_BIN",
        env: {
          LETAGENTS_CODEX_REPLAY_TRANSCRIPT: transcriptFile,
          LETAGENTS_CODEX_REPLAY_CONTROL_DIR: controlDir,
        },
      },
    ],
  });
  harness.onDispose(() => rm(controlDir, { recursive: true, force: true }));

  const roomId = `edge_codex_${scenario}`;
  const entryId = `agent_codex_${scenario}`;
  const agentConfig: EdgeAgentRegistration = {
    entryId,
    roomId,
    provider: "codex",
    displayName: `Edge Codex ${scenario}`,
    model: "gpt-5.4",
    permissionProfileId: "full_access",
    ...overrides,
  };
  return { harness, controlDir, agentConfig };
}

describe(
  "daemon edge suite: codex (black-box child process)",
  { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false },
  () => {
    test("1. start agent, deliver one room message, publish exactly one reply", { timeout: 60_000 }, async () => {
      const { harness, agentConfig } = await startCodexScenario("simple");
      try {
        await harness.startAgent(agentConfig);
        const ready = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
          "codex idle with thread continuation",
        );
        assert.equal(ready.condition, "none");

        harness.roomServer.enqueueMessage(agentConfig.roomId, {
          text: "Reply with codex-ready-reply",
        });

        await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );

        const settled = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "codex back to idle after reply",
        );

        const published = harness.roomServer.publishedMessages(agentConfig.roomId);
        assert.deepEqual(
          published.map((m) => m.text),
          ["codex-ready-reply"],
        );
        assert.equal(
          harness.roomServer.publishAttempts(agentConfig.roomId).length,
          1,
          "expected exactly one raw POST to room messages",
        );
        if (settled.delivery_receipts?.length) {
          assert.equal(settled.delivery_receipts.length, 1);
          assert.equal(settled.delivery_receipts[0]!.state, "acknowledged");
        }

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
          assert.equal(sqlite.journalMode(), "wal");
          assert.ok(sqlite.userVersion() >= 1);
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
        assert.deepEqual(
          findProcessesReferencingPath(harness.homeDir),
          [],
          `Expected zero processes referencing ${harness.homeDir} after dispose()`,
        );
      }
    });

    test("2. FIFO ordering for three room messages (A in flight, B and C queued)", { timeout: 60_000 }, async () => {
      const { harness, controlDir, agentConfig } = await startCodexScenario("fifo-order");
      try {
        await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        await writeFile(join(controlDir, "hold-turn-1"), "hold\n", "utf8");
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "First Codex FIFO message" });
        await waitForFile(join(controlDir, "turn-1-held.json"), 20_000);

        // Enqueue BOTH B and C while A is in flight so FIFO (B before C) is distinguished from LIFO (C before B).
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Second Codex FIFO message" });
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Third Codex FIFO message" });
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => (entry.room_agent_state?.inbox.pending_count ?? 0) >= 3,
          15_000,
          "three pending Codex inbox items (A in flight, B and C queued)",
        );

        await writeFile(join(controlDir, "release-turn-1"), "go\n", "utf8");

        await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 3,
          25_000,
        );
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "idle with drained Codex FIFO queue",
        );

        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["codex-fifo-1", "codex-fifo-2", "codex-fifo-3"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 3);

        const turn1Meta = JSON.parse(await readFile(join(controlDir, "turn-1-started.json"), "utf8")) as { promptText: string };
        const turn2Meta = JSON.parse(await readFile(join(controlDir, "turn-2-started.json"), "utf8")) as { promptText: string };
        const turn3Meta = JSON.parse(await readFile(join(controlDir, "turn-3-started.json"), "utf8")) as { promptText: string };
        assert.deepEqual(
          [
            sourceMessageText(turn1Meta.promptText),
            sourceMessageText(turn2Meta.promptText),
            sourceMessageText(turn3Meta.promptText),
          ],
          [
            "First Codex FIFO message",
            "Second Codex FIFO message",
            "Third Codex FIFO message",
          ],
          "expected Codex provider turns to execute strictly in FIFO order A -> B -> C",
        );
      } finally {
        await harness.dispose();
      }
    });

    test("3. stop/interrupt during an active turn via manifest.control_turn", { timeout: 60_000 }, async () => {
      const { harness, controlDir, agentConfig } = await startCodexScenario("turn-interrupt");
      try {
        const { daemonGeneration } = await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Long Codex turn" });
        await waitForFile(join(controlDir, "turn-1-waiting-interrupt.json"), 20_000);

        const activeEntry = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "working" &&
            entry.room_agent_state?.turn.state === "responding" &&
            Boolean(entry.room_agent_state.turn.provider_turn_id) &&
            Boolean(entry.room_agent_state.turn.inbox_item_id) &&
            Boolean(entry.room_agent_state.turn.source_message_id),
          15_000,
          "working Codex turn with checkpointed provider_turn_id",
        );

        const controlResult = await harness.rpc.controlTurn({
          id: agentConfig.entryId,
          daemon_generation: daemonGeneration,
          room_id: agentConfig.roomId,
          work_attempt_id: activeEntry.provider_ref!.work_attempt_id,
          execution_generation_id: activeEntry.provider_ref!.execution_generation_id,
          provider_continuation_id: activeEntry.provider_ref!.provider_continuation_id,
          provider_turn_id: activeEntry.room_agent_state!.turn.provider_turn_id!,
          inbox_item_id: activeEntry.room_agent_state!.turn.inbox_item_id!,
          source_message_id: activeEntry.room_agent_state!.turn.source_message_id!,
          action_id: "edge-codex-interrupt-1",
          action_sequence: 1,
          correction: null,
        });
        assert.equal(controlResult.state, "idle");
        assert.equal(existsSync(join(controlDir, "turn-interrupted.json")), true, "Expected Codex server to receive turn/interrupt");

        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "codex idle after interrupt",
        );
        assert.equal(harness.roomServer.publishedMessages(agentConfig.roomId).length, 0);
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 0);

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Follow-up after stop" });
        await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "codex idle after follow-up reply",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["codex-after-interrupt"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 1);
      } finally {
        await harness.dispose();
      }
    });

    test("4. SIGKILL daemon mid-turn, restart it, recover with no lost or duplicate reply", { timeout: 60_000 }, async () => {
      const { harness, controlDir, agentConfig } = await startCodexScenario("kill-recover");
      try {
        await harness.startAgent(agentConfig);
        const before = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_connection?.pid),
          25_000,
        );
        const providerPidBefore = before.provider_ref!.provider_connection!.pid!;

        await writeFile(join(controlDir, "hold-turn-1"), "hold\n", "utf8");
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Survive SIGKILL" });
        await waitForFile(join(controlDir, "turn-1-held.json"), 20_000);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.room_agent_state?.turn.state === "responding" &&
            Boolean(entry.room_agent_state.turn.provider_turn_id),
          15_000,
          "checkpointed active Codex turn before SIGKILL",
        );

        await harness.kill("SIGKILL");

        await writeFile(join(controlDir, "release-turn-1"), "go\n", "utf8");
        const restarted = await harness.restart();
        assert.ok(restarted.healthy);
        await harness.reinstallCredentials(agentConfig, restarted.generation);

        await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          25_000,
        );

        const after = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "codex idle with drained inbox after SIGKILL recovery",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["codex-survived-kill"],
        );
        assert.equal(
          harness.roomServer.publishAttempts(agentConfig.roomId).length,
          1,
          "expected no duplicate room POST on SIGKILL recovery",
        );
        assert.equal(
          existsSync(join(controlDir, "unexpected-turn-2.json")),
          false,
          "restarted daemon must not start a duplicate Codex turn",
        );
        assert.equal(after.provider_ref?.provider_connection?.pid, providerPidBefore);

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });

    test("5. update handoff keeps Codex alive across successor daemon", { timeout: 60_000 }, async () => {
      const { harness, agentConfig } = await startCodexScenario("handoff");
      try {
        await harness.startAgent(agentConfig);
        const before = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_connection?.pid),
          25_000,
        );
        const providerPidBefore = before.provider_ref!.provider_connection!.pid!;

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Before handoff" });
        await harness.roomServer.waitForPublishedMessages(agentConfig.roomId, (msgs) => msgs.length >= 1, 20_000);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
        );

        const { predecessorGeneration, successorStatus } = await harness.handoffToSuccessor();
        assert.ok(successorStatus.generation > predecessorGeneration);
        await harness.reinstallCredentials(agentConfig, successorStatus.generation);

        const attached = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.provider_ref?.provider_connection?.pid === providerPidBefore,
          20_000,
          "successor attached to surviving Codex PID",
        );
        assert.equal(attached.provider_ref?.provider_connection?.pid, providerPidBefore);

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "After handoff" });
        await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 2,
          20_000,
        );
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "codex idle after post-handoff reply",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["codex-before-handoff", "codex-after-handoff"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 2);
      } finally {
        await harness.dispose();
      }
    });

    test("6. approval request and signed host approval decision (ask_before_write)", { timeout: 60_000 }, async () => {
      const { harness, controlDir, agentConfig } = await startCodexScenario("approval", {
        permissionProfileId: "ask_before_write",
      });
      try {
        // Provide a minimal file-backed Codex home config so ask_before_write sandbox setup succeeds.
        const codexDir = join(harness.homeDir, ".codex");
        await mkdir(codexDir, { recursive: true });
        await writeFile(join(codexDir, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");
        await writeFile(join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-edge-local" }), "utf8");

        await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Run Codex command needing approval" });

        const candidate = await harness.waitForApproval(
          agentConfig.roomId,
          (item) => item.status === "pending" && Boolean(item.reference),
          20_000,
        );
        assert.equal(candidate.presentation.provider, "codex");

        const status = await harness.rpc.decideHostApproval(candidate, "allow_once");
        assert.ok(
          ["resolved", "decision_sent", "decision_recorded"].includes(status),
          `expected non-pending approval decision status, got: ${status}`,
        );

        await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "codex idle after approved reply",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["codex-approval-granted"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 1);

        const decisionLog = JSON.parse(
          await readFile(join(controlDir, "turn-1-approval-decision.json"), "utf8"),
        ) as { decision: unknown; accepted: boolean };
        assert.equal(decisionLog.decision, "accept");
        assert.equal(decisionLog.accepted, true);

        const finalApprovals = await harness.rpc.listHostApprovals(agentConfig.roomId);
        assert.equal(
          finalApprovals.some((a) => a.status === "pending"),
          false,
          `expected no approval to remain pending, got: ${JSON.stringify(finalApprovals)}`,
        );
      } finally {
        await harness.dispose();
      }
    });

    test("7. repeated provider exits trigger exponential backoff and crash-loop quarantine", { timeout: 90_000 }, async () => {
      const { harness, agentConfig } = await startCodexScenario("crash-loop");
      try {
        await harness.startAgent(agentConfig);

        const quarantined = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.condition === "quarantined",
          75_000,
          "codex crash-loop quarantine",
          { failOnStartError: false },
        );
        assert.equal(quarantined.condition, "quarantined");

        const exitTimes = [...(quarantined.reconciliation?.exit_timestamps_ms ?? [])].sort((a, b) => a - b);
        assert.ok(exitTimes.length >= 5, `expected at least 5 recorded crash exits via RPC, got ${exitTimes.length}`);
        const gaps: number[] = [];
        for (let i = 1; i < exitTimes.length; i += 1) {
          gaps.push(exitTimes[i]! - exitTimes[i - 1]!);
        }
        assert.ok(
          gaps.every((gap) => gap >= 500),
          `expected every crash-loop restart gap to reflect backoff (>= 500ms), got gaps=${JSON.stringify(gaps)}`,
        );
        const totalSpanMs = exitTimes.at(-1)! - exitTimes[0]!;
        assert.ok(
          totalSpanMs >= 10_000,
          `expected cumulative crash-loop backoff span >= 10000ms (1+2+4+8s schedule), got ${totalSpanMs}ms (gaps=${JSON.stringify(gaps)})`,
        );
        assert.ok(
          Math.max(...gaps) >= 4_000,
          `expected exponential backoff gap >= 4000ms before quarantine, got gaps=${JSON.stringify(gaps)}`,
        );

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });
  },
);
