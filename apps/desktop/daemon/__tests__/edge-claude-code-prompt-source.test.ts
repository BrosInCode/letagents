import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { promptSourceText } from "./edge/claude-code/prompt-source.js";

// How the Claude Code edge tests read which room message a prompt is for.
// The FIFO scenario rests on it, so it is tested by itself: a real daemon
// that takes the queue in a wrong order is not at hand in a test.

const message = (id: string, text: string): string => JSON.stringify({ id, room_id: "room", sender: "alice", text });

/** A prompt in the form the daemon writes: every recent message quoted, one of them named as the source. */
const prompt = (source: string, context: string[]): string => [
  "You are responding to a daemon-owned room inbox item.",
  "Inbox item: 2e970ff3-31e6-40bf-b3ff-ec5510ddfd06",
  `Recent bounded room context: [${context.join(",")}]`,
  `Source message: ${source}`,
  'Activation: {"decision":"activate","reason":"mention","addressed":true}',
].join("\n");

describe("the source message of a daemon prompt", () => {
  const a = message("msg_1", "EDGE_SAY[reply-a]");
  const b = message("msg_2", "EDGE_SAY[reply-b]");
  const c = message("msg_3", "EDGE_SAY[reply-c]");

  it("is the message of the Source message line, whatever else the prompt quotes", () => {
    assert.equal(promptSourceText(prompt(b, [a, b, c])), "EDGE_SAY[reply-b]");
    assert.equal(promptSourceText(prompt(c, [a, b, c])), "EDGE_SAY[reply-c]");
  });

  it("is null for a prompt that answers no room message", () => {
    assert.equal(promptSourceText("Initialize this supervised Claude Code continuation."), null);
  });

  it("shows a daemon that takes C before B, as the FIFO scenario asserts it", () => {
    const wrongOrder = [null, a, c, b].map((source) => (source ? prompt(source, [a, b, c]) : "first prompt"));
    const sources = wrongOrder.map(promptSourceText);
    assert.deepEqual(sources, [null, "EDGE_SAY[reply-a]", "EDGE_SAY[reply-c]", "EDGE_SAY[reply-b]"]);
    // The assertion of the scenario, on these prompts: it must fail, and name the order.
    assert.throws(
      () => assert.equal(sources[2], "EDGE_SAY[reply-b]", "the daemon takes B, the older waiting message, before C"),
      /the daemon takes B, the older waiting message, before C/,
    );
  });
});
