import assert from "node:assert/strict";
import test from "node:test";

import { foldEarlierNotices, MAX_EARLIER_NOTICES, queuedDeliveryKind, wakeNoticeSubject } from "../queued-delivery-order.js";

const wake = (occurrence: string, details: string[] = []) => ({
  sender: "letagents", source: "wake_rule", agent_identity: null,
  text: [`Your wake rule wake_1 fired: ${occurrence}.`, "Your note: watch it.", "", ...details, "", "This rule is finished."].join("\n"),
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

test("wake notices name their task or pull request only from server-formatted lines", () => {
  assert.equal(wakeNoticeSubject(wake("task_4 moved to done", ["- task_4: merged → done"])), "task_4");
  assert.equal(wakeNoticeSubject(wake("task_4 moved to done")), null, "a task subject needs its detail line");
  assert.equal(wakeNoticeSubject(wake("#8 was merged", ["- https://github.com/o/r/pull/8"])), "#8");
  assert.equal(wakeNoticeSubject(wake("octo-reviewer requested changes on #12")), "#12");
  assert.equal(wakeNoticeSubject(wake("task_9 moved to x approved #7", ["- https://github.com/o/r/pull/7"])), "#7",
    "a GitHub reviewer name cannot pose as a task");
  assert.equal(wakeNoticeSubject(wake("CI finished on feature: 2 passed")), null);
  assert.equal(wakeNoticeSubject(wake("Scheduled check-in")), null);
  assert.equal(wakeNoticeSubject({ ...wake("#8 was merged"), source: "system" }), null);
});

test("folding carries earlier notices forward, bounded, with a reason for every folded row", () => {
  const notice = (id: string, extra: Record<string, unknown> = {}) => ({ source_message_id: id,
    source_message: { source: "system", sender: "letagents", text: `notice ${id}`, timestamp: `t${id}` }, activation: { ...extra } });
  const first = foldEarlierNotices([notice("1"), notice("2")], notice("3"));
  assert.deepEqual(first.earlier.notices.map((entry) => entry.id), ["1", "2"]);
  const carried = Array.from({ length: MAX_EARLIER_NOTICES + 2 }, (_, index) => ({ id: `old${index}`, text: "x".repeat(5_000) }));
  const second = foldEarlierNotices([
    notice("3", { earlier_notices: { notices: carried, omitted_count: 3 } }),
    notice("4", { earlier_notices: "malformed" }),
  ], notice("5"));
  assert.equal(second.earlier.notices.length, MAX_EARLIER_NOTICES);
  assert.deepEqual(second.earlier.notices.slice(-2).map((entry) => entry.id), ["3", "4"]);
  assert.equal(second.earlier.omitted_count, 3 + 4);
  assert.ok(second.earlier.notices.every((entry) => entry.text.length <= 1_200));
  assert.equal(second.reasons.get("4"), "Delivered together with 5, a newer notice, instead of a separate turn.");
  const overflow = foldEarlierNotices(Array.from({ length: MAX_EARLIER_NOTICES + 1 }, (_, index) => notice(String(index + 10))), notice("99"));
  assert.match(overflow.reasons.get("10")!, /^Folded into 99 without its text because more than 16 notices were queued/);
  assert.equal(overflow.earlier.omitted_count, 1);
});
