import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopHostApproval, HostApprovalStatus } from "../../shared/host-approvals";
import {
  HOST_APPROVAL_ARM_MS,
  hostApprovalActionKey,
  hostApprovalCardHeading,
  hostApprovalCardView,
  hostApprovalDecisionsArmed,
  hostApprovalDeniedAllNotice,
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

const presentation = { agentId: "agent", displayName: "Juniper", provider: "open-model", title: "Run a command",
  details: "{}", denyScope: "session_pending" } as DesktopHostApproval["presentation"];
const waiting = { presentation, status: "unavailable" as const, retryDecision: null };
const pending = { ...waiting, status: "pending" as const };
const recorded = { ...waiting, status: "decision_recorded" as const, retryDecision: "allow_once" as const };
const uncertain = { ...waiting, status: "uncertain" as const };
const calm = { blocksTurn: false, serviceError: false, agentPending: 1 };

test("a card's action key changes when a different button appears on the same request", () => {
  const key = (approval: typeof waiting | typeof pending | typeof recorded, input = calm) => hostApprovalActionKey(hostApprovalCardView(approval, input));
  assert.equal(key(pending), "deny Deny allow_once");
  assert.equal(key(recorded), "retry_allow_once");
  assert.equal(key(waiting), "", "an unavailable card that no turn waits on offers nothing");
  // Same request, same card: only the turn starting to wait on it changes the key.
  assert.equal(key(waiting, { ...calm, blocksTurn: true }), "stop_turn", "Stop turn appears");
  assert.equal(key(pending, { ...calm, serviceError: true }), "retry", "Retry takes Deny's place");
  assert.notEqual(key(pending, { ...calm, serviceError: true }), key(pending), "Deny coming back after Retry holds again");
  assert.notEqual(key(pending, { ...calm, agentPending: 2 }), key(pending, { ...calm, agentPending: 3 }), "a new count holds again");
});

test("each card state, in plain words", () => {
  assert.deepEqual(hostApprovalCardView(pending, calm),
    { kind: "decide", denyLabel: "Deny", denyTitle: "Denies this and every other request from Juniper", alwaysAllow: false });
  assert.deepEqual(hostApprovalCardView(pending, { ...calm, agentPending: 3 }),
    { kind: "decide", denyLabel: "Deny all 3", denyTitle: "Denies this and every other request from Juniper", alwaysAllow: false },
    "a deny that covers the agent's other requests says so on the button");
  const single = { ...pending, presentation: { ...presentation, provider: "codex", denyScope: "request" } } as typeof pending;
  assert.deepEqual(hostApprovalCardView(single, { ...calm, agentPending: 3 }),
    { kind: "decide", denyLabel: "Deny", denyTitle: null, alwaysAllow: false }, "a deny for one request stays Deny");
  assert.deepEqual(hostApprovalCardView(pending, { ...calm, serviceError: true }), { kind: "offline" });
  assert.deepEqual(hostApprovalCardView(waiting, { ...calm, blocksTurn: true }), { kind: "blocked" });
  assert.deepEqual(hostApprovalCardView(waiting, { ...calm, blocksTurn: true, serviceError: true }), { kind: "blocked" },
    "Stop turn does not wait on the approvals service");
  assert.deepEqual(hostApprovalCardView(recorded, calm), { kind: "unconfirmed", label: "Allowed · not confirmed yet", resend: "allow_once" });
  assert.deepEqual(hostApprovalCardView(recorded, { ...calm, serviceError: true }),
    { kind: "unconfirmed", label: "Allowed · not confirmed yet", resend: null }, "offline, Check again only lists again");
  assert.deepEqual(hostApprovalCardView(uncertain, { ...calm, sent: "deny" }), { kind: "unconfirmed", label: "Denied · not confirmed yet", resend: null },
    "an uncertain decision is never sent again");
  assert.deepEqual(hostApprovalCardView(uncertain, calm), { kind: "unconfirmed", label: "Answered · not confirmed yet", resend: null });
  assert.deepEqual(hostApprovalCardView(pending, { ...calm, serviceError: true, sent: "allow_once" }),
    { kind: "unconfirmed", label: "Allowed · not confirmed yet", resend: null }, "a decision whose answer failed is not 'can't answer'");
  assert.deepEqual(hostApprovalCardView(waiting, calm), { kind: "none" });
});

test("the card heading names who waits, and on what", () => {
  assert.equal(hostApprovalCardHeading(waiting, { kind: "blocked" }), "Juniper is waiting on a request you can't answer here");
  assert.equal(hostApprovalCardHeading(pending, hostApprovalCardView(pending, calm)), "Juniper · Run a command");
  assert.equal(hostApprovalCardHeading(uncertain, hostApprovalCardView(uncertain, calm)), "Juniper · Run a command");
  assert.deepEqual(hostApprovalDeniedAllNotice(3, "Juniper"), { lead: "Denied 3 requests from ", name: "Juniper" });
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
