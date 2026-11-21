import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  resolveDefaultDaemonCommand,
  startEdgeDaemon,
  type EdgeAgentRegistration,
  type EdgeDaemonCommand,
} from "./edge/daemon-edge-harness.js";

// The daemon edge test for Cursor. Before each Cursor turn the daemon proves
// the live Cursor account against the real Cursor service, and the host of
// that proof is fixed in the product on purpose (room decision, task_1). So no
// offline test can run a Cursor turn. What an offline test can show is the
// refusal: with a Cursor that is not signed in, no turn starts and the daemon
// says why. Full Cursor turns are covered by the in-process adapter tests and
// by QA with a signed-in Cursor.

const SIGNED_OUT_CLI = fileURLToPath(new URL("./edge/cursor/signed-out-cli.mjs", import.meta.url));
const WAIT_MS = 45_000;

/** The scenario: with a Cursor that is not signed in, no turn starts, and the daemon reports the sign-in state. */
async function assertSignedOutCursorStartsNoTurn(daemonCommand?: EdgeDaemonCommand): Promise<void> {
  // The daemon runs its checks of Cursor in a sandbox that reads the folder of the program
  // only. So the harness copies the stand-in there (`copyScript`).
  const harness = await startEdgeDaemon({
    daemonCommand,
    shims: [{ name: "cursor-agent", scriptPath: SIGNED_OUT_CLI, envVar: "LETAGENTS_CURSOR_AGENT_BIN", copyScript: true }],
  });
  try {
    const agent: EdgeAgentRegistration = {
      entryId: "agent_cursor_signed_out",
      roomId: "edge_cursor_signed_out",
      provider: "cursor",
      displayName: "Edge Cursor signed out",
      model: "auto",
      permissionProfileId: "full_access",
    };
    await harness.startAgent(agent);
    harness.roomServer.enqueueMessage(agent.roomId, { text: "A message for a Cursor that is not signed in" });

    const blocked = await harness.waitForEntry(
      agent.entryId,
      (entry) => entry.room_agent_state?.inbox.state === "blocked",
      WAIT_MS,
      "the room message blocked before any Cursor turn",
    );
    // The daemon says why, in the words a person reads in the app.
    assert.equal(blocked.condition, "coordination_blocked");
    assert.match(String(blocked.last_error), /Cursor Agent needs sign-in/);
    const attention = blocked.delivery_attention as
      | { reason?: string; detail?: string; provider_work_started?: boolean; retry?: string }
      | null
      | undefined;
    assert.equal(attention?.reason, "message_blocked");
    assert.match(String(attention?.detail), /Cursor Agent needs sign-in/);
    // No turn started: the program got no prompt, and the message can be tried again after sign-in.
    assert.equal(attention?.provider_work_started, false);
    assert.equal(attention?.retry, "start_turn");
    assert.equal(blocked.room_agent_state?.turn.provider_turn_id, null);
    assert.equal(harness.roomServer.publishedMessages(agent.roomId).length, 0);
  } catch (error) {
    console.error(`daemon stderr (end):\n${harness.daemonOutput().stderr.slice(-3000)}`);
    throw error;
  } finally {
    await harness.dispose();
  }
}

/**
 * A copy of the Node program at a different path. It is the same program for the operating system,
 * and a different one for a rule that compares paths, as the daemon's sandbox does.
 */
async function copyOfNodeAtAnotherPath(): Promise<{ program: string; remove: () => Promise<void> }> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "letagents-edge-node-copy-")));
  const program = join(folder, basename(process.execPath));
  await copyFile(process.execPath, program);
  await chmod(program, 0o755);
  return { program, remove: () => rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

describe(
  "daemon edge suite: cursor (black-box child process)",
  { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false },
  () => {
    test("a Cursor that is not signed in starts no turn, and the daemon reports the sign-in state", async () => {
      await assertSignedOutCursorStartsNoTurn();
    });

    // The daemon's sandbox admits the daemon's own program and no other. A daemon that runs under a
    // different program than the test process (a slow runner, a packaged daemon) must still get a
    // stand-in that it can run: the harness starts the stand-in under the daemon's program.
    test(
      "the same refusal with a daemon that runs under a program at a different path than the test process",
      { skip: !resolveDefaultDaemonCommand().useNodeIpc ? "the daemon command is overridden from outside" : false },
      async () => {
        const copy = await copyOfNodeAtAnotherPath();
        try {
          const standard = resolveDefaultDaemonCommand();
          assert.notEqual(copy.program, process.execPath);
          await assertSignedOutCursorStartsNoTurn({ ...standard, command: copy.program });
        } finally {
          await copy.remove();
        }
      },
    );

    // The same, with the other program chosen by the PATH of the daemon command: the command is a bare
    // name, and only the daemon's environment says which program that name is.
    test(
      "the same refusal with a daemon whose program is chosen by the PATH of the daemon command",
      { skip: !resolveDefaultDaemonCommand().useNodeIpc ? "the daemon command is overridden from outside" : false },
      async () => {
        const copy = await copyOfNodeAtAnotherPath();
        try {
          const standard = resolveDefaultDaemonCommand();
          await assertSignedOutCursorStartsNoTurn({
            ...standard,
            command: basename(copy.program),
            env: { ...(standard.env ?? {}), PATH: [dirname(copy.program), process.env.PATH ?? ""].join(delimiter) },
          });
        } finally {
          await copy.remove();
        }
      },
    );
  },
);
