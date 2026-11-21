import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  startEdgeDaemon,
  type EdgeAgentRegistration,
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

describe(
  "daemon edge suite: cursor (black-box child process)",
  { skip: EDGE_DAEMON_UNSUPPORTED_REASON ?? false },
  () => {
    test("a Cursor that is not signed in starts no turn, and the daemon reports the sign-in state", async () => {
      // The daemon runs its checks of Cursor in a sandbox that reads the folder of the program
      // only. So the harness copies the stand-in there (`copyScript`).
      const harness = await startEdgeDaemon({
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
    });
  },
);
