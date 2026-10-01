import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PERSON_PASSES, peopleFirstOrder, queuedDeliveryKind, queuedNoticeIds, queuedNoticeReason, queuedNoticesFor, wakeNoticeSubject,
} from "../queued-delivery-order.js";

const wake = (occurrence: string, details: string[] = [], rule = "wake_1") => ({
  sender: "letagents", source: "wake_rule", agent_identity: null,
  text: [`Your wake rule ${rule} fired: ${occurrence}.`, "Your note: watch it.", "", ...details, "", "This rule is finished."].join("\n"),
});

test("only server-classified human room messages are people and only LetAgents system rows are notices", () => {
  assert.equal(queuedDeliveryKind("msg_4", { source: "browser", sender: "Dana", agent_identity: null }), "person");
  assert.equal(queuedDeliveryKind("4", { source: "browser", sender: "Dana" }), "person");
  assert.equal(queuedDeliveryKind("msg_4", { source: "browser", sender: "Dana", agent_identity: { agent_key: "dana/peer" } }), "automated",
    "an agent identity is never a person");
  assert.equal(queuedDeliveryKind("msg_4", { source: "agent", sender: "Dana" }), "automated", "a sender name is not authority");
  assert.equal(queuedDeliveryKind("msg_4", { source: "system", sender: "letagents" }), "notice");
  assert.equal(queuedDeliveryKind("msg_4", { source: "wake_rule", sender: "LetAgents" }), "notice");
  assert.equal(queuedDeliveryKind("msg_4", { source: "browser", sender: "letagents" }), "person", "a person cannot pose as a notice");
  assert.equal(queuedDeliveryKind("msg_4", { source: "system", sender: "Dana" }), "automated");
  assert.equal(queuedDeliveryKind("msg_4", { source: "github", sender: "letagents" }), "automated");
  assert.equal(queuedDeliveryKind("msg_4", null), "automated");
  for (const synthetic of ["correction:action-1", "task-continuation:item", "desktop-initial-message:agent"]) {
    assert.equal(queuedDeliveryKind(synthetic, { source: "browser" }), "fixed");
  }
});

test("wake notices name their rule and task or pull request only from server-formatted lines", () => {
  assert.deepEqual(wakeNoticeSubject(wake("task_4 moved to done", ["- task_4: merged → done"])), { rule: "wake_1", subject: "task_4" });
  assert.equal(wakeNoticeSubject(wake("task_4 moved to done")), null, "a task subject needs its detail line");
  assert.deepEqual(wakeNoticeSubject(wake("#8 was merged", ["- https://github.com/o/r/pull/8"])), { rule: "wake_1", subject: "#8" });
  assert.deepEqual(wakeNoticeSubject(wake("octo-reviewer requested changes on #12")), { rule: "wake_1", subject: "#12" });
  assert.deepEqual(wakeNoticeSubject(wake("task_9 moved to x approved #7", ["- https://github.com/o/r/pull/7"])), { rule: "wake_1", subject: "#7" },
    "a GitHub reviewer name cannot pose as a task");
  assert.equal(wakeNoticeSubject(wake("CI finished on feature: 2 passed")), null);
  assert.equal(wakeNoticeSubject(wake("Scheduled check-in")), null);
  assert.equal(wakeNoticeSubject({ ...wake("#8 was merged"), source: "system" }), null);
});

test("a notice batch marks only newer firings of the same rule as superseding, and points truncated text at the room", () => {
  const row = (id: string, message: unknown) => ({ source_message_id: id, source_message: message });
  const payload = queuedNoticesFor(row("msg_1", wake("reviewer requested changes on #8", [], "wake_a")), [
    row("msg_2", wake("reviewer approved #8", [], "wake_b")),
    row("msg_3", wake("#8 was merged", [], "wake_a")),
    row("msg_4", { source: "system", sender: "letagents", text: "x".repeat(2_000) }),
  ]);
  assert.equal(payload.activating_superseded_by, "msg_3", "the same rule fired again about #8");
  assert.deepEqual(payload.notices.map(({ id, superseded_by }) => [id, superseded_by]), [["msg_2", null], ["msg_3", null], ["msg_4", null]],
    "a different rule about the same pull request is not superseded");
  assert.ok(payload.notices[2]!.text.endsWith("… (truncated; read msg_4 in the room)"));
  assert.equal(payload.notices[2]!.text.length, 1_200 + "… (truncated; read msg_4 in the room)".length);
  const activation = { queued_notices: { notices: [...payload.notices, { id: 5 }, "junk", { id: "msg_9", superseded_by: "msg_10" }] } };
  assert.deepEqual(queuedNoticeIds(activation), ["msg_2", "msg_3", "msg_4", "msg_9"]);
  assert.deepEqual(queuedNoticeIds({ queued_notices: "junk" }), []);
  assert.match(queuedNoticeReason(activation, "msg_1", "msg_9"), /^Superseded by msg_10, a newer firing of the same wake rule\./);
  assert.match(queuedNoticeReason(activation, "msg_1", "msg_2"), /^Delivered in the turn for msg_1 together with other queued notices/);
});

test("people pass earlier automated deliveries, FIFO among people, and each delivery is passed a bounded number of times", () => {
  const entry = (kind: "person" | "automated" | "notice", arrival: number) => ({ kind, arrival: BigInt(arrival), label: `${kind[0]}${arrival}` });
  const labels = (rows: ReturnType<typeof entry>[]) => peopleFirstOrder(rows).order.map((row) => row.label);
  assert.deepEqual(labels([entry("automated", 1), entry("notice", 2), entry("person", 3), entry("automated", 4), entry("person", 5)]),
    ["p3", "p5", "a1", "n2", "a4"]);
  assert.deepEqual(labels([entry("person", 1), entry("automated", 2)]), ["p1", "a2"], "a person never passes a later delivery");
  const run = [entry("automated", 1), ...Array.from({ length: MAX_PERSON_PASSES + 2 }, (_, index) => entry("person", index + 2))];
  const { order, passed } = peopleFirstOrder(run);
  assert.deepEqual(order.map((row) => row.label), ["p2", "p3", "p4", "p5", "p6", "a1", "p7", "p8"]);
  assert.deepEqual([...passed.values()], [1, 1, 1, 1, 1]);
  assert.deepEqual(peopleFirstOrder(order).order.map((row) => row.label), order.map((row) => row.label), "reordering is stable");
});
