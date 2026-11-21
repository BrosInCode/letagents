import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadProviderReplayTranscript } from "../../electron/__tests__/provider-replay/transcript.js";
import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  startEdgeDaemon,
  type EdgeAgentRegistration,
  type EdgeDaemonHarness,
} from "./edge/daemon-edge-harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLAY_DIR = resolve(HERE, "../../electron/__tests__/provider-replay");
const OPENCODE_SERVER_SCRIPT = join(REPLAY_DIR, "open-model-edge-server.mjs");
const FIXTURES_DIR = join(REPLAY_DIR, "fixtures/open-model");

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, `${name}.ndjson`);
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for synchronization marker ${path}`);
}

async function startOpenModelScenario(
  scenario: string,
  overrides: Partial<EdgeAgentRegistration> = {},
): Promise<{
  harness: EdgeDaemonHarness;
  controlDir: string;
  agentConfig: EdgeAgentRegistration;
}> {
  const transcriptFile = fixturePath(scenario);
  const parsed = loadProviderReplayTranscript(transcriptFile);
  assert.equal(parsed.start.provider, "open-model");
  assert.equal(parsed.start.protocol, "opencode.server/http-sse");

  const controlDir = await mkdtemp(join(tmpdir(), `letagents-om-ctrl-${scenario}-`));
  const harness = await startEdgeDaemon({
    shims: [
      {
        name: "opencode",
        scriptPath: OPENCODE_SERVER_SCRIPT,
        envVar: "LETAGENTS_OPENCODE_BIN",
        env: {
          LETAGENTS_OPENCODE_REPLAY_TRANSCRIPT: transcriptFile,
          LETAGENTS_OPENCODE_REPLAY_CONTROL_DIR: controlDir,
        },
      },
    ],
  });
  harness.onDispose(() => rm(controlDir, { recursive: true, force: true }));

  const roomId = `edge_open_model_${scenario}`;
  const entryId = `agent_om_${scenario}`;
  const agentConfig: EdgeAgentRegistration = {
    entryId,
    roomId,
    provider: "open-model",
    displayName: `Edge OpenModel ${scenario}`,
    model: "edge-model",
    permissionProfileId: "full_access",
    openModelCredential: {
      apiKey: "edge-test-key",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "edge-model",
      contextWindow: 128_000,
    },
    ...overrides,
  };
  return { harness, controlDir, agentConfig };
}

describe(
  "daemon edge suite: open-model (black-box child process)",
  { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false },
  () => {
    test("1. start agent, deliver one room message, publish exactly one reply", async () => {
      const { harness, agentConfig } = await startOpenModelScenario("simple");
      try {
        await harness.startAgent(agentConfig);
        const ready = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
          "open-model idle with continuation",
        );
        assert.equal(ready.condition, "none");

        harness.roomServer.enqueueMessage(agentConfig.roomId, {
          text: "Reply with open-model-ready",
        });

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        assert.equal(published.length, 1);
        assert.equal(published[0]!.text, "open-model-ready");

        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
          15_000,
          "open-model back to idle after reply",
        );

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
          assert.equal(sqlite.journalMode(), "wal");
          assert.ok(sqlite.userVersion() >= 1);
          const inbox = sqlite.inboxItems(agentConfig.entryId);
          assert.equal(inbox.length, 1);
          assert.equal(inbox[0]!.state, "acknowledged");
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });

    test("2. FIFO ordering for two queued room messages", async () => {
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("fifo-two");
      try {
        await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        // Enqueue message 1 and wait until turn 1 is actively held at its gate.
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "First FIFO message" });
        await waitForFile(join(controlDir, "turn-1-waiting-gate.json"), 20_000);

        // Enqueue message 2 while turn 1 is still running so both sit in FIFO queue.
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Second FIFO message" });
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => (entry.room_agent_state?.inbox.pending_count ?? 0) >= 2,
          15_000,
          "two pending inbox items in FIFO queue",
        );

        // Release turn 1; turn 2 must execute strictly after turn 1 publishes.
        await writeFile(join(controlDir, "release-turn-1"), "go\n", "utf8");

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 2,
          20_000,
        );
        assert.deepEqual(
          published.map((m) => m.text),
          ["fifo-reply-1", "fifo-reply-2"],
        );
        const turn1Meta = JSON.parse(await readFile(join(controlDir, "turn-1-started.json"), "utf8")) as { promptText: string };
        const turn2Meta = JSON.parse(await readFile(join(controlDir, "turn-2-started.json"), "utf8")) as { promptText: string };
        assert.match(turn1Meta.promptText, /First FIFO message/);
        assert.match(turn2Meta.promptText, /Second FIFO message/);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle" && (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "idle with drained FIFO queue",
        );

        const sqlite = harness.openSqlite();
        try {
          const inbox = sqlite.inboxItems(agentConfig.entryId);
          assert.equal(inbox.length, 2);
          assert.ok(Number(inbox[0]!.fifo_sequence) < Number(inbox[1]!.fifo_sequence));
          assert.equal(inbox[0]!.state, "acknowledged");
          assert.equal(inbox[1]!.state, "acknowledged");
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });

    test("3. stop/interrupt during an active turn via manifest.control_turn", async () => {
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("turn-interrupt");
      try {
        const { daemonGeneration } = await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Long running turn" });
        await waitForFile(join(controlDir, "turn-1-waiting-abort.json"), 20_000);

        const activeEntry = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.room_agent_state?.turn.state === "responding" &&
            Boolean(entry.room_agent_state.turn.provider_turn_id) &&
            Boolean(entry.room_agent_state.turn.inbox_item_id) &&
            Boolean(entry.room_agent_state.turn.source_message_id),
          15_000,
          "responding turn with checkpointed provider_turn_id",
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
          action_id: "edge-interrupt-1",
          action_sequence: 1,
          correction: null,
        });
        assert.equal(controlResult.state, "idle");
        assert.equal(existsSync(join(controlDir, "turn-aborted.json")), true, "Expected OpenCode server to receive POST /session/:id/abort");

        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
          15_000,
          "idle after interrupt",
        );
        // The interrupted turn must not have published a bogus reply.
        assert.equal(harness.roomServer.publishedMessages(agentConfig.roomId).length, 0);

        const sqliteAfterStop = harness.openSqlite();
        try {
          const inbox = sqliteAfterStop.inboxItems(agentConfig.entryId);
          assert.equal(inbox.length, 1);
          assert.ok(
            ["cancelled_by_user", "acknowledged_failed"].includes(String(inbox[0]!.state)),
            `expected interrupted turn to settle cleanly without reply, got ${String(inbox[0]!.state)}`,
          );
        } finally {
          sqliteAfterStop.close();
        }

        // A follow-up room message still executes cleanly on the same session.
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Follow-up after stop" });
        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        assert.equal(published.length, 1);
        assert.equal(published[0]!.text, "after-interrupt-reply");
      } finally {
        await harness.dispose();
      }
    });

    test("4. SIGKILL daemon mid-turn, restart it, recover with no lost or duplicate reply", async () => {
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("kill-recover");
      try {
        await harness.startAgent(agentConfig);
        const before = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_connection?.pid),
          25_000,
        );
        const providerPidBefore = before.provider_ref!.provider_connection!.pid!;

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Survive SIGKILL" });
        await waitForFile(join(controlDir, "turn-1-waiting-gate.json"), 20_000);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.room_agent_state?.turn.state === "responding" &&
            Boolean(entry.room_agent_state.turn.provider_turn_id),
          15_000,
          "checkpointed active turn before SIGKILL",
        );

        // Hard-kill the daemon process while the turn is mid-flight.
        await harness.kill("SIGKILL");

        // Release the provider turn while the daemon is dead, then restart the daemon.
        await writeFile(join(controlDir, "release-turn-1"), "go\n", "utf8");
        const restarted = await harness.restart();
        assert.ok(restarted.healthy);
        await harness.reinstallCredentials(agentConfig, restarted.generation);

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          25_000,
        );
        // Wait briefly to confirm no duplicate publication arrives.
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        const finalPublished = harness.roomServer.publishedMessages(agentConfig.roomId);
        assert.equal(finalPublished.length, 1);
        assert.equal(published[0]!.text, "survived-daemon-kill");

        const after = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
          15_000,
        );
        assert.equal(after.provider_ref?.provider_connection?.pid, providerPidBefore);

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
          const inbox = sqlite.inboxItems(agentConfig.entryId);
          assert.equal(inbox.length, 1);
          assert.equal(inbox[0]!.state, "acknowledged");
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });

    test("5. update handoff keeps Open Model alive across successor daemon", async () => {
      const { harness, agentConfig } = await startOpenModelScenario("handoff");
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
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
          15_000,
        );

        const { predecessorGeneration, successorStatus } = await harness.handoffToSuccessor();
        assert.ok(successorStatus.generation > predecessorGeneration);
        await harness.reinstallCredentials(agentConfig, successorStatus.generation);

        const attached = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.provider_ref?.provider_connection?.pid === providerPidBefore,
          20_000,
          "successor attached to surviving OpenCode PID",
        );
        assert.equal(attached.provider_ref?.provider_connection?.pid, providerPidBefore);

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "After handoff" });
        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 2,
          20_000,
        );
        assert.deepEqual(
          published.map((m) => m.text),
          ["before-handoff-reply", "after-handoff-reply"],
        );
      } finally {
        await harness.dispose();
      }
    });

    test("6. approval request and signed host approval decision", async () => {
      const { harness, agentConfig } = await startOpenModelScenario("approval", {
        permissionProfileId: "ask_before_write",
      });
      try {
        await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Run command needing approval" });

        const candidate = await harness.waitForApproval(
          agentConfig.roomId,
          (item) => item.status === "pending" && Boolean(item.reference),
          20_000,
        );
        assert.equal(candidate.presentation.provider, "open-model");

        const status = await harness.rpc.decideHostApproval(candidate, "allow_once");
        assert.ok(["resolved", "decision_recorded", "pending"].includes(status), `unexpected decision status: ${status}`);

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        assert.equal(published.length, 1);
        assert.equal(published[0]!.text, "approval-granted-reply");

        const sqlite = harness.openSqlite();
        try {
          const approvals = sqlite.approvalRequests(agentConfig.entryId);
          assert.ok(approvals.length >= 1);
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });

    test("7. crash loop triggers backoff and quarantines the agent", async () => {
      const { harness, agentConfig } = await startOpenModelScenario("crash-loop");
      try {
        await harness.startAgent(agentConfig);

        const quarantined = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.condition === "quarantined" && entry.observed_state === "failed",
          45_000,
          "open-model crash loop quarantine",
        );
        assert.equal(quarantined.condition, "quarantined");
        assert.equal(quarantined.observed_state, "failed");

        const sqlite = harness.openSqlite();
        try {
          const exits = sqlite.reconciliationExitTimestamps(agentConfig.entryId);
          assert.ok(exits.length >= 5, `expected at least 5 recorded exits before quarantine, got ${exits.length}`);
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });
  },
);
