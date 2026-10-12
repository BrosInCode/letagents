import assert from "node:assert/strict";
import test from "node:test";
import { formatRoomTurnContext } from "../main/agents/desktop-event-prompt-format.js";

test("current guidance appears once; historical guidance cannot become a new instruction", () => {
  const activation = { decision: "activate", guidance: "You are an equal participant." };
  const source = { id: "msg_2", text: "Your views?", activation: { for_current_agent: activation } };
  const earlier = { id: "msg_1", text: "Previous question", activation: { for_current_agent: { guidance: "Obsolete guidance" } } };
  const reply = { id: "msg_3", sender: "Alice", text: "My approach", thread_root_id: "msg_2", reply_to: source.id };
  const request = { sourceMessage: source, observedContext: [earlier, source, reply], activation };
  const before = structuredClone(request);
  const lines = formatRoomTurnContext(request);
  assert.deepEqual(JSON.parse(lines[0]!.slice("Recent bounded room context: ".length)), [
    { id: "msg_1", text: "Previous question" }, { id: "msg_2", text: "Your views?" }, reply,
  ]);
  assert.deepEqual(JSON.parse(lines[1]!.slice("Source message: ".length)), { id: "msg_2", text: "Your views?" });
  assert.deepEqual(JSON.parse(lines[2]!.slice("Activation: ".length)), activation);
  assert.equal(lines.join("\n").split(activation.guidance).length - 1, 1);
  assert.ok(!lines.join("\n").includes("Obsolete guidance"));
  assert.deepEqual(request, before, "never mutate the durable inbox or caller's context");
});

test("ordinary turns preserve conversation data and handle synthetic context", () => {
  assert.deepEqual(formatRoomTurnContext({ sourceMessage: null, activation: { decision: "activate" } }), [
    "Recent bounded room context: []", "Source message: null", 'Activation: {"decision":"activate"}',
  ]);
  const source = { text: "Answer in the main room", sender: "Human", reply_to: { text: "Earlier answer" } };
  const lines = formatRoomTurnContext({ sourceMessage: source, observedContext: [null, "correction", source], activation: {} });
  assert.deepEqual(JSON.parse(lines[0]!.slice("Recent bounded room context: ".length)), [null, "correction", source]);
});
