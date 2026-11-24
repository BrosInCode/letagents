import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const OPEN_MODEL_EDGE_DIR = resolve(HERE, "edge/open-model");
const OPENCODE_SERVER_SCRIPT = join(OPEN_MODEL_EDGE_DIR, "server.mjs");
const FIXTURES_DIR = join(OPEN_MODEL_EDGE_DIR, "fixtures");

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

async function waitForFileImmediate(dir: string, filename: string, timeoutMs = 20_000): Promise<void> {
  const target = join(dir, filename);
  if (existsSync(target)) return;
  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      try { watcher?.close(); } catch { /* ignore */ }
      if (error) rejectWait(error);
      else resolveWait();
    };
    const check = () => {
      if (existsSync(target)) finish();
    };
    try {
      watcher = watch(dir, () => check());
      watcher.on("error", () => { /* fall back to poll */ });
    } catch {
      /* fall back to poll */
    }
    const poll = setInterval(check, 2);
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for synchronization marker ${target}`));
    }, timeoutMs);
    check();
  });
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
    test("1. start agent, deliver one room message, publish exactly one reply", { timeout: 60_000 }, async () => {
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
          "open-model back to idle after reply",
        );

        const published = harness.roomServer.publishedMessages(agentConfig.roomId);
        assert.deepEqual(
          published.map((m) => m.text),
          ["open-model-ready"],
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
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("fifo-order");
      try {
        await harness.startAgent(agentConfig);
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_continuation_id),
          25_000,
        );

        await writeFile(join(controlDir, "hold-turn-1"), "hold\n", "utf8");
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "First FIFO message" });
        await waitForFile(join(controlDir, "turn-1-held.json"), 20_000);

        // Enqueue BOTH B and C while A is in flight so FIFO (B before C) is distinguished from LIFO (C before B).
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Second FIFO message" });
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Third FIFO message" });
        await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => (entry.room_agent_state?.inbox.pending_count ?? 0) >= 3,
          15_000,
          "three pending inbox items in FIFO queue (A in flight, B and C queued)",
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
          "idle with drained FIFO queue",
        );

        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["fifo-reply-1", "fifo-reply-2", "fifo-reply-3"],
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
            "First FIFO message",
            "Second FIFO message",
            "Third FIFO message",
          ],
          "expected OpenCode provider turns to execute strictly in FIFO order A -> B -> C",
        );
      } finally {
        await harness.dispose();
      }
    });

    test("3. stop/interrupt during an active turn via manifest.control_turn", { timeout: 60_000 }, async () => {
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
            entry.observed_state === "working" &&
            entry.room_agent_state?.turn.state === "responding" &&
            Boolean(entry.room_agent_state.turn.provider_turn_id) &&
            Boolean(entry.room_agent_state.turn.inbox_item_id) &&
            Boolean(entry.room_agent_state.turn.source_message_id),
          15_000,
          "working open-model turn with checkpointed provider_turn_id",
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
          (entry) =>
            entry.observed_state === "idle" &&
            entry.room_agent_state?.turn.state === "idle" &&
            (entry.room_agent_state?.inbox.pending_count ?? 0) === 0,
          15_000,
          "idle after interrupt",
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
          "idle after follow-up reply",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["after-interrupt-reply"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 1);
      } finally {
        await harness.dispose();
      }
    });

    test("4. SIGKILL daemon mid-turn, restart it, recover with no lost or duplicate reply", { timeout: 60_000 }, async () => {
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("kill-recover");
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
          "checkpointed active turn before SIGKILL",
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
          "open-model idle with drained inbox after SIGKILL recovery",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["survived-daemon-kill"],
        );
        assert.equal(
          harness.roomServer.publishAttempts(agentConfig.roomId).length,
          1,
          "expected no duplicate room POST on SIGKILL recovery",
        );
        assert.equal(
          existsSync(join(controlDir, "unexpected-turn-2.json")),
          false,
          "restarted daemon must not start a duplicate OpenCode turn",
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

    test("4b. SIGKILL immediately when provider receives turn (0ms, before active-turn projection) recovers with one reply and no source_gap", { timeout: 60_000 }, async () => {
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("kill-recover");
      try {
        await harness.startAgent(agentConfig);
        const before = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.observed_state === "idle" && Boolean(entry.provider_ref?.provider_connection?.pid),
          25_000,
        );
        const providerPidBefore = before.provider_ref!.provider_connection!.pid!;

        await writeFile(join(controlDir, "hold-turn-1"), "hold\n", "utf8");
        harness.roomServer.enqueueMessage(agentConfig.roomId, { text: "Survive immediate SIGKILL" });
        // Kill immediately when OpenCode receives prompt_async (before sending HTTP 204
        // and before the daemon can project observed_state === "working" or drain turn/active).
        await waitForFileImmediate(controlDir, "turn-1-started.json", 20_000);
        await harness.kill("SIGKILL");

        const preRestartSqlite = harness.openSqlite();
        try {
          const inboxRow = preRestartSqlite.get<{ state: string; provider_turn_id: string | null }>(
            "SELECT state, provider_turn_id FROM inbox_items WHERE agent_id = ? ORDER BY fifo_sequence DESC LIMIT 1",
            agentConfig.entryId,
          );
          assert.ok(inboxRow, "expected durable inbox row before restart");
          assert.ok(inboxRow.provider_turn_id, "provider_turn_id must already be durable before promptAsync reaches OpenCode");
          const observerRow = preRestartSqlite.get<{ last_source_sequence: number; max_observed_sequence: number }>(
            "SELECT last_source_sequence, max_observed_sequence FROM execution_observers WHERE agent_id = ?",
            agentConfig.entryId,
          );
          assert.ok(observerRow, "expected execution_observers row before restart");
          assert.equal(
            Number(observerRow.max_observed_sequence),
            Number(observerRow.last_source_sequence),
            "crash right after dispatch must not leave max_observed_sequence ahead of last_source_sequence",
          );
        } finally {
          preRestartSqlite.close();
        }

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
          "open-model idle with drained inbox after 0ms SIGKILL recovery",
        );
        assert.equal(after.condition, "none");
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["survived-daemon-kill"],
        );
        assert.equal(
          harness.roomServer.publishAttempts(agentConfig.roomId).length,
          1,
          "expected no duplicate room POST on 0ms SIGKILL recovery",
        );
        assert.equal(
          existsSync(join(controlDir, "unexpected-turn-2.json")),
          false,
          "restarted daemon must not start a duplicate OpenCode turn",
        );
        assert.equal(after.provider_ref?.provider_connection?.pid, providerPidBefore);

        const stderr = harness.daemonOutput().stderr;
        assert.doesNotMatch(stderr, /"code":"source_gap"/, `unexpected source_gap in restarted daemon stderr:\n${stderr}`);
        assert.doesNotMatch(stderr, /"code":"invalid_observation"/, `unexpected invalid_observation in restarted daemon stderr:\n${stderr}`);

        const sqlite = harness.openSqlite();
        try {
          assert.equal(sqlite.integrityCheck(), "ok");
          const blockedRows = sqlite.all<{ inbox_item_id: string }>(
            "SELECT inbox_item_id FROM inbox_items WHERE agent_id = ? AND state = 'blocked'",
            agentConfig.entryId,
          );
          assert.deepEqual(blockedRows, [], "expected zero blocked inbox rows after 0ms SIGKILL recovery");
          const observerRow = sqlite.get<{ last_source_sequence: number; max_observed_sequence: number }>(
            "SELECT last_source_sequence, max_observed_sequence FROM execution_observers WHERE agent_id = ?",
            agentConfig.entryId,
          );
          assert.ok(observerRow);
          assert.equal(Number(observerRow.max_observed_sequence), Number(observerRow.last_source_sequence));
        } finally {
          sqlite.close();
        }
      } finally {
        await harness.dispose();
      }
    });

    test("5. update handoff keeps Open Model alive across successor daemon", { timeout: 60_000 }, async () => {
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
          "successor attached to surviving OpenCode PID",
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
          "idle after post-handoff reply",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["before-handoff-reply", "after-handoff-reply"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 2);
      } finally {
        await harness.dispose();
      }
    });

    test(
      "6. approval request and signed host approval decision (ask_before_write)",
      {
        timeout: 60_000,
        // A daemon started through LETAGENTS_EDGE_DAEMON_CMD has no Node IPC channel, and the host
        // approval key reaches the daemon over that channel only.
        skip: process.env.LETAGENTS_EDGE_DAEMON_CMD?.trim()
          ? "needs the Node IPC channel for the host approval key; an external daemon command has none"
          : false,
      },
      async () => {
      const { harness, controlDir, agentConfig } = await startOpenModelScenario("approval", {
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
          "idle after approved reply",
        );
        assert.deepEqual(
          harness.roomServer.publishedMessages(agentConfig.roomId).map((m) => m.text),
          ["approval-granted-reply"],
        );
        assert.equal(harness.roomServer.publishAttempts(agentConfig.roomId).length, 1);

        const decisionLog = JSON.parse(
          await readFile(join(controlDir, "turn-1-permission-decision.json"), "utf8"),
        ) as { reply: string };
        assert.equal(decisionLog.reply, "once");

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
      const { harness, agentConfig } = await startOpenModelScenario("crash-loop");
      try {
        await harness.startAgent(agentConfig);

        const quarantined = await harness.waitForEntry(
          agentConfig.entryId,
          (entry) => entry.condition === "quarantined",
          75_000,
          "open-model crash-loop quarantine",
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
