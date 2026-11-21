import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseNodeShim } from "../../../../shared/codex-executable.mjs";
import { loadProviderReplayTranscript } from "../../electron/__tests__/provider-replay/transcript.js";
import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  startEdgeDaemon,
  type EdgeAgentRegistration,
  type EdgeDaemonHarness,
} from "./edge/daemon-edge-harness.js";
import { materializeNodeShim } from "./edge/executable-shim.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLAY_DIR = resolve(HERE, "../../electron/__tests__/provider-replay");
const CODEX_SERVER_SCRIPT = join(REPLAY_DIR, "codex-edge-server.mjs");
const FIXTURES_DIR = join(REPLAY_DIR, "fixtures/codex");

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

async function startCodexScenario(
  scenario: string,
  overrides: Partial<EdgeAgentRegistration> = {},
): Promise<{
  harness: EdgeDaemonHarness;
  controlDir: string;
  agentConfig: EdgeAgentRegistration;
}> {
  const transcriptFile = fixturePath(`edge-${scenario}`);
  const parsed = loadProviderReplayTranscript(transcriptFile);
  assert.equal(parsed.start.provider, "codex");
  assert.equal(parsed.start.protocol, "codex.app-server/websocket");

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

test("edge executable shim generates a parseNodeShim-compatible Windows .cmd wrapper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letagents-shim-check-"));
  try {
    const shimPath = await materializeNodeShim(dir, "codex", CODEX_SERVER_SCRIPT, {
      platform: "win32",
      env: { LETAGENTS_EDGE_MARKER: "ok" },
    });
    assert.ok(shimPath.endsWith(".cmd"));
    const content = await readFile(shimPath, "utf8");
    const parsed = parseNodeShim(shimPath, content);
    assert.ok(parsed, "Expected Windows .cmd shim to satisfy shared/codex-executable parseNodeShim()");
    assert.ok(parsed.args.at(-1)?.endsWith("codex.entry.mjs"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe(
  "daemon edge suite: codex (black-box child process)",
  { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false },
  () => {
    test("1. start agent, deliver one room message, publish exactly one reply", async () => {
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
          text: "Reply with codex-ready",
        });

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        assert.equal(published.length, 1);
        assert.equal(published[0]!.text, "codex-ready");

        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
          15_000,
          "codex back to idle after reply",
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
      const { harness, controlDir, agentConfig } = await startCodexScenario("fifo-two");
      try {
        await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "First Codex FIFO message" });
        await waitForFile(join(controlDir, "turn-1-waiting-gate.json"), 20_000);

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Second Codex FIFO message" });
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => (entry.room_agent_state?.inbox.pending_count ?? 0) >= 2,
          15_000,
          "two pending Codex inbox items",
        );

        await writeFile(join(controlDir, "release-turn-1"), "go\n", "utf8");

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 2,
          20_000,
        );
        assert.deepEqual(
          published.map((m) => m.text),
          ["codex-fifo-1", "codex-fifo-2"],
        );
        const turn1Meta = JSON.parse(await readFile(join(controlDir, "turn-1-started.json"), "utf8")) as { promptText: string };
        const turn2Meta = JSON.parse(await readFile(join(controlDir, "turn-2-started.json"), "utf8")) as { promptText: string };
        assert.match(turn1Meta.promptText, /First Codex FIFO message/);
        assert.match(turn2Meta.promptText, /Second Codex FIFO message/);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "idle with drained Codex FIFO queue",
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
            entry.room_agent_state?.turn.state === "responding" &&
            Boolean(entry.room_agent_state.turn.provider_turn_id) &&
            Boolean(entry.room_agent_state.turn.inbox_item_id) &&
            Boolean(entry.room_agent_state.turn.source_message_id),
          15_000,
          "responding Codex turn with checkpointed provider_turn_id",
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
          (entry) => entry.observed_state === "idle" && entry.room_agent_state?.turn.state === "idle",
          15_000,
          "codex idle after interrupt",
        );
        assert.equal(harness.roomServer.publishedMessages(agentConfig.roomId).length, 0);

        const sqliteAfterStop = harness.openSqlite();
        try {
          const inbox = sqliteAfterStop.inboxItems(agentConfig.entryId);
          assert.equal(inbox.length, 1);
          assert.ok(
            ["cancelled_by_user", "acknowledged_failed"].includes(String(inbox[0]!.state)),
            `expected interrupted Codex turn to settle cleanly without reply, got ${String(inbox[0]!.state)}`,
          );
        } finally {
          sqliteAfterStop.close();
        }

        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Follow-up after stop" });
        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        assert.equal(published.length, 1);
        assert.equal(published[0]!.text, "codex-after-interrupt");
      } finally {
        await harness.dispose();
      }
    });

    test("4. SIGKILL daemon mid-turn, restart it, recover with no lost or duplicate reply", async () => {
      const { harness, controlDir, agentConfig } = await startCodexScenario("kill-recover");
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
          "checkpointed active Codex turn before SIGKILL",
        );

        await harness.kill("SIGKILL");

        await writeFile(join(controlDir, "release-turn-1"), "go\n", "utf8");
        const restarted = await harness.restart();
        assert.ok(restarted.healthy);
        await harness.reinstallCredentials(agentConfig, restarted.generation);

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          25_000,
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        const finalPublished = harness.roomServer.publishedMessages(agentConfig.roomId);
        assert.equal(finalPublished.length, 1);
        assert.equal(published[0]!.text, "codex-survived-kill");

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

    test("5. update handoff keeps Codex alive across successor daemon", async () => {
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
          "successor attached to surviving Codex PID",
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
          ["codex-before-handoff", "codex-after-handoff"],
        );
      } finally {
        await harness.dispose();
      }
    });

    test("6. approval request and signed host approval decision", async () => {
      const { harness, agentConfig } = await startCodexScenario("approval");
      try {
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
          ["resolved", "decision_sent", "decision_recorded", "pending"].includes(status),
          `unexpected decision status: ${status}`,
        );

        const published = await harness.roomServer.waitForPublishedMessages(
          agentConfig.roomId,
          (msgs) => msgs.length >= 1,
          20_000,
        );
        assert.equal(published.length, 1);
        assert.equal(published[0]!.text, "codex-approval-granted");

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
      const { harness, agentConfig } = await startCodexScenario("crash-loop");
      try {
        await harness.startAgent(agentConfig);

        const quarantined = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.condition === "quarantined" && entry.observed_state === "failed",
          45_000,
          "codex crash loop quarantine",
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
