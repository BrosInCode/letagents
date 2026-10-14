import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assessAcknowledgment, buildAcknowledgmentRequest, type AcknowledgmentInput } from "../messages/jev-acknowledgment.js";

const input: AcknowledgmentInput = { source: "human", text: "Thanks everyone.", attachmentCount: 0, recentConversation: [] };
const answer = (ack: unknown, substantive: unknown) => ({ answers: {
  acknowledgment_only: { probability: ack }, substantive_or_ambiguous: { probability: substantive },
} });

test("only a complete human text request can be evaluated", () => {
  assert.ok(buildAcknowledgmentRequest(input));
  for (const invalid of [
    { source: "agent" as const }, { attachmentCount: 1 }, { attachmentCount: -1 },
    { text: " " }, { text: "x".repeat(1201) },
    { recentConversation: [{ kind: "agent" as const, text: "x".repeat(1201) }] },
    { recentConversation: Array.from({ length: 7 }, () => ({ kind: "human" as const, text: "hello" })) },
  ]) assert.equal(buildAcknowledgmentRequest({ ...input, ...invalid }), null);
  const text = "x".repeat(1200);
  assert.equal(buildAcknowledgmentRequest({ ...input, text })?.state.latest_human_message, text);
  for (const invalid of [null, { ...input, text: null }, { ...input, recentConversation: null },
    { ...input, recentConversation: [null] }, { ...input, recentConversation: [{ kind: "system", text: "hello" }] },
    { ...input, recentConversation: [{ kind: "agent", text: 42 }] }]) {
    assert.equal(buildAcknowledgmentRequest(invalid as unknown as AcknowledgmentInput), null);
  }
  const extra = { ...input, recentConversation: [{ kind: "agent" as const, text: "hello", secret: "must not leave" }] };
  assert.deepEqual(buildAcknowledgmentRequest(extra)?.state.recent_conversation, [{ kind: "agent", text: "hello" }]);
});

test("both question scores must satisfy conservative thresholds", () => {
  assert.equal(assessAcknowledgment(answer(.95, .05)).decision, "independent_acknowledgment");
  for (const [ack, substantive] of [[.949, 0], [1, .051], [1, 1], [0, 0]]) {
    assert.equal(assessAcknowledgment(answer(ack, substantive)).decision, "keep_turn_order");
  }
  assert.equal(assessAcknowledgment({ answers: {
    acknowledgment_only: { noul: .99 }, substantive_or_ambiguous: { noul: .01 },
  } }).decision, "independent_acknowledgment");
});

test("missing, malformed and contradictory provider fields fail closed and are not valid measurements", () => {
  for (const body of [null, [], {}, { answers: [] }, answer("1", 0), answer(1, NaN), answer(2, 0),
    answer(1, -1), answer(undefined, 0), { answers: { acknowledgment_only: { probability: 1 } } },
    { answers: { acknowledgment_only: { probability: 1, noul: 0 }, substantive_or_ambiguous: { probability: 0 } } },
  ]) {
    assert.equal(assessAcknowledgment(body).decision, "keep_turn_order");
    assert.equal(assessAcknowledgment(body).valid, false);
  }
});

test("evaluation fixture includes contextual approvals and mixed requests; ineligible cases cannot claim to be model passes", async () => {
  const cases = JSON.parse(await readFile(new URL("../../../scripts/room-acknowledgment-eval.cases.json", import.meta.url), "utf8")) as
    Array<{ id: string; expect: string; input: AcknowledgmentInput }>;
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.ok(cases.some(item => item.id === "contextual-yes" && item.input.recentConversation.length));
  assert.ok(cases.some(item => item.id === "thanks-question" && item.expect === "keep_turn_order"));
  for (const item of cases) {
    if (!buildAcknowledgmentRequest(item.input)) assert.equal(item.expect, "keep_turn_order", item.id);
  }
});
