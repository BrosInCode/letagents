import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopHostApproval, HostApprovalStatus } from "../../shared/host-approvals";
import {
  HOST_APPROVAL_ARM_MS,
  hostApprovalActionKey,
  hostApprovalDecisionsArmed,
  hostApprovalHistoryCount,
  hostApprovalHistoryLabel,
  hostApprovalTrayOrder,
} from "../src/components/desktop/content/room-chat/host-approval-presentation";

const SHOWN_AT = Date.parse("2026-10-09T10:00:00.000Z");

test("a request that becomes the visible card holds its decisions for the arming hold", () => {
  assert.equal(HOST_APPROVAL_ARM_MS, 600);
  assert.equal(hostApprovalDecisionsArmed(SHOWN_AT, SHOWN_AT), false, "held the moment it appears");
  assert.equal(hostApprovalDecisionsArmed(SHOWN_AT, SHOWN_AT + HOST_APPROVAL_ARM_MS - 1), false, "held one millisecond before the end");
  assert.equal(hostApprovalDecisionsArmed(SHOWN_AT, SHOWN_AT + HOST_APPROVAL_ARM_MS), true, "armed when the hold ends");
  assert.equal(hostApprovalDecisionsArmed(SHOWN_AT, SHOWN_AT + 60_000), true, "stays armed while it is shown");
});

test("a card's action key changes when a decision button appears on the same request", () => {
  const presentation = { agentId: "agent", displayName: "Agent", provider: "open-model", title: "Run a command",
    details: "{}", denyScope: "session_pending" } as DesktopHostApproval["presentation"];
  const waiting = { presentation, status: "unavailable" as const, retryDecision: null };
  const pending = { ...waiting, status: "pending" as const };
  const recorded = { ...waiting, status: "decision_recorded" as const, retryDecision: "allow_once" as const };
  assert.equal(hostApprovalActionKey(pending, false), "deny allow_once");
  assert.equal(hostApprovalActionKey(recorded, false), "retry_allow_once");
  assert.equal(hostApprovalActionKey(waiting, false), "", "an unavailable card that no turn waits on offers nothing");
  // Same request, same card: only the turn starting to wait on it changes the key.
  assert.notEqual(hostApprovalActionKey(waiting, false), hostApprovalActionKey(waiting, true), "Stop turn appears");
  assert.equal(hostApprovalActionKey(waiting, true), "stop_turn");
  assert.equal(hostApprovalActionKey(waiting, true), hostApprovalActionKey(waiting, true), "a steady card keeps its key");
});

const card = (id: string, status: HostApprovalStatus) => ({ id, status });

test("requests that can still be answered lead the stack and unavailable ones follow", () => {
  const order = hostApprovalTrayOrder([card("u1", "unavailable"), card("p1", "pending"), card("c1", "uncertain"),
    card("r1", "decision_recorded"), card("p2", "pending")]);
  assert.deepEqual(order.map(item => item.id), ["p1", "r1", "p2", "u1", "c1"]);
});

test("each group keeps the order it has, so a stable stack never reshuffles", () => {
  const stable = [card("p2", "pending"), card("p1", "pending"), card("u2", "unavailable"), card("u1", "unavailable")];
  assert.deepEqual(hostApprovalTrayOrder(stable).map(item => item.id), ["p2", "p1", "u2", "u1"]);
  assert.deepEqual(hostApprovalTrayOrder([]), []);
});

test("the history line counts only the unavailable and unconfirmed requests", () => {
  const every: HostApprovalStatus[] = ["pending", "decision_recorded", "decision_sent", "uncertain", "request_closed", "resolved", "unavailable"];
  assert.equal(hostApprovalHistoryCount(every.map(status => ({ status }))), 2);
  assert.equal(hostApprovalHistoryCount([{ status: "pending" }]), 0, "a pending request is shown, not counted");
});

test("the history label says exactly what it counts", () => {
  assert.equal(hostApprovalHistoryLabel(1, false), "Show 1 unavailable or unconfirmed approval");
  assert.equal(hostApprovalHistoryLabel(2, false), "Show 2 unavailable or unconfirmed approvals");
  assert.equal(hostApprovalHistoryLabel(2, true), "Hide 2 unavailable or unconfirmed approvals");
});
