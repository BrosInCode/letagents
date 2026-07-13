import assert from "node:assert/strict";
import test from "node:test";

import type { BoardIntent, Task } from "../db.js";
import type { EscalationCandidateBoardIntent } from "../db/coordination/board-intents.js";
import {
  buildAutoApproveAnnouncementText,
  buildHumanEscalationText,
  createIntentEscalationSweeper,
  INTENT_AUTO_APPROVE_MAX_PER_WINDOW,
  INTENT_ESCALATION_AFTER_MS,
  selectIntentEscalationAction,
  type IntentEscalationSweeperDeps,
} from "../rooms/board-intent-escalation-sweep.js";

const NOW = Date.parse("2026-07-13T23:00:00.000Z");

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function buildIntent(overrides: Partial<BoardIntent> = {}): BoardIntent {
  return {
    id: overrides.id ?? "bi_stuck",
    room_id: overrides.room_id ?? "focus_34",
    task_id: overrides.task_id ?? null,
    action_type: overrides.action_type ?? "task_create",
    payload: overrides.payload ?? { kind: "task_create", title: "Ship Phase C" },
    payload_hash: overrides.payload_hash ?? "hash",
    status: overrides.status ?? "pending",
    proposer_actor_label: overrides.proposer_actor_label ?? "RiverGrove | EmmyMay's agent | Claude Code",
    proposer_actor_key:
      overrides.proposer_actor_key === undefined ? "EmmyMay/river-grove" : overrides.proposer_actor_key,
    proposer_actor_instance_id: overrides.proposer_actor_instance_id ?? null,
    proposer_agent_session_id: overrides.proposer_agent_session_id ?? "agent_session_400",
    decision_by: overrides.decision_by ?? null,
    decision_reason: overrides.decision_reason ?? null,
    approval_token_hash: overrides.approval_token_hash ?? null,
    decided_at: overrides.decided_at ?? null,
    expires_at: overrides.expires_at ?? null,
    escalated_at: overrides.escalated_at ?? null,
    auto_approved: overrides.auto_approved ?? false,
    created_at: overrides.created_at ?? isoMinutesAgo(15),
    updated_at: overrides.updated_at ?? isoMinutesAgo(15),
  };
}

function candidate(
  intent: BoardIntent,
  managerMode: EscalationCandidateBoardIntent["manager_mode"] = "manager_optional"
): EscalationCandidateBoardIntent {
  return { intent, manager_mode: managerMode };
}

test("selectIntentEscalationAction gates auto-approval strictly", () => {
  const base = { intent: buildIntent(), auto_approvals_in_window: 0 };

  assert.equal(
    selectIntentEscalationAction({ ...base, manager_mode: "manager_optional" }),
    "auto_approve"
  );
  assert.equal(
    selectIntentEscalationAction({ ...base, manager_mode: "intent_required" }),
    "notify_humans",
    "intent_required is an explicit human gate"
  );
  assert.equal(
    selectIntentEscalationAction({ ...base, manager_mode: "off" }),
    "notify_humans"
  );
  assert.equal(
    selectIntentEscalationAction({
      intent: buildIntent({ action_type: "task_close" }),
      manager_mode: "manager_optional",
      auto_approvals_in_window: 0,
    }),
    "notify_humans",
    "only task_create may self-approve"
  );
  assert.equal(
    selectIntentEscalationAction({
      ...base,
      manager_mode: "manager_optional",
      auto_approvals_in_window: INTENT_AUTO_APPROVE_MAX_PER_WINDOW,
    }),
    "notify_humans",
    "the rate cap blocks the next auto-approval"
  );
});

test("escalation texts name the proposer, title, wait, and cap", () => {
  const autoText = buildAutoApproveAnnouncementText({
    intent: buildIntent(),
    waited_for_ms: 12 * 60_000,
  });
  assert.ok(autoText.includes("No Board Manager responded for 12m"));
  assert.ok(autoText.includes("RiverGrove"));
  assert.ok(autoText.includes('"Ship Phase C"'));

  const humanText = buildHumanEscalationText({
    intent: buildIntent({ action_type: "task_close", payload: { kind: "task_close" } }),
    manager_mode: "manager_optional",
    waited_for_ms: 30 * 60_000,
    rate_capped: false,
  });
  assert.ok(humanText.includes("task_close board intent"));
  assert.ok(humanText.includes("waited 30m"));
  assert.ok(humanText.includes("room admin"));

  const cappedText = buildHumanEscalationText({
    intent: buildIntent(),
    manager_mode: "manager_optional",
    waited_for_ms: 11 * 60_000,
    rate_capped: true,
  });
  assert.ok(cappedText.includes("rate cap"));

  const requiredText = buildHumanEscalationText({
    intent: buildIntent(),
    manager_mode: "intent_required",
    waited_for_ms: 11 * 60_000,
    rate_capped: false,
  });
  assert.ok(requiredText.includes("requires intent approval"));
});

interface FakeDepsOptions {
  candidates: EscalationCandidateBoardIntent[];
  reachableManagerRooms?: Set<string>;
  autoApprovalsInWindow?: number;
  autoApproveResult?: Task | null;
  notifyResult?: boolean;
  failCountsForRoom?: string;
}

function buildFakeDeps(options: FakeDepsOptions) {
  const autoApproveCalls: Array<{ intentId: string; text: string; clientMessageId: string }> = [];
  const notifyCalls: Array<{ intentId: string; text: string }> = [];
  const managerChecks: string[] = [];

  const task: Task = {
    id: "task_9",
    room_id: "focus_34",
    title: "Ship Phase C",
    description: null,
    status: "accepted",
    assignee: null,
    created_by: "RiverGrove | EmmyMay's agent | Claude Code",
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
  };

  const deps: IntentEscalationSweeperDeps = {
    listCandidates: async () => options.candidates,
    hasReachableManager: async (roomId) => {
      managerChecks.push(roomId);
      if (options.failCountsForRoom === roomId) {
        throw new Error("manager lookup failed");
      }
      return options.reachableManagerRooms?.has(roomId) ?? false;
    },
    countRecentAutoApprovals: async () => options.autoApprovalsInWindow ?? 0,
    autoApproveIntent: async (input) => {
      autoApproveCalls.push({
        intentId: input.intent_id,
        text: input.text,
        clientMessageId: input.client_message_id,
      });
      return options.autoApproveResult === undefined ? task : options.autoApproveResult;
    },
    notifyHumans: async (input) => {
      notifyCalls.push({ intentId: input.intent_id, text: input.text });
      return options.notifyResult ?? true;
    },
    now: () => NOW,
  };

  return { deps, autoApproveCalls, notifyCalls, managerChecks };
}

test("sweepOnce auto-approves a stuck task_create intent with the fence key", async () => {
  const fake = buildFakeDeps({ candidates: [candidate(buildIntent())] });
  const summary = await createIntentEscalationSweeper(fake.deps).sweepOnce();

  assert.equal(summary.auto_approved, 1);
  assert.equal(summary.notified, 0);
  assert.equal(fake.autoApproveCalls.length, 1);
  assert.equal(fake.autoApproveCalls[0]?.clientMessageId, "board_intent_escalation:bi_stuck");
  assert.ok(fake.autoApproveCalls[0]!.text.includes("auto-approving"));
});

test("sweepOnce leaves intents alone while a reachable manager exists", async () => {
  const fake = buildFakeDeps({
    candidates: [candidate(buildIntent())],
    reachableManagerRooms: new Set(["focus_34"]),
  });
  const summary = await createIntentEscalationSweeper(fake.deps).sweepOnce();

  assert.equal(summary.auto_approved, 0);
  assert.equal(summary.notified, 0);
  assert.deepEqual(fake.autoApproveCalls, []);
  assert.deepEqual(fake.notifyCalls, []);
});

test("sweepOnce caches the manager check per room within a pass", async () => {
  const fake = buildFakeDeps({
    candidates: [
      candidate(buildIntent({ id: "bi_1" })),
      candidate(buildIntent({ id: "bi_2" })),
    ],
  });
  await createIntentEscalationSweeper(fake.deps).sweepOnce();

  assert.deepEqual(fake.managerChecks, ["focus_34"]);
});

test("sweepOnce notifies humans for capped, non-create, and intent_required cases", async () => {
  const capped = buildFakeDeps({
    candidates: [candidate(buildIntent())],
    autoApprovalsInWindow: INTENT_AUTO_APPROVE_MAX_PER_WINDOW,
  });
  const cappedSummary = await createIntentEscalationSweeper(capped.deps).sweepOnce();
  assert.equal(cappedSummary.auto_approved, 0);
  assert.equal(cappedSummary.notified, 1);
  assert.ok(capped.notifyCalls[0]!.text.includes("rate cap"));

  const close = buildFakeDeps({
    candidates: [candidate(buildIntent({ action_type: "task_close", payload: { kind: "task_close" } }))],
  });
  assert.equal((await createIntentEscalationSweeper(close.deps).sweepOnce()).notified, 1);

  const required = buildFakeDeps({
    candidates: [candidate(buildIntent(), "intent_required")],
  });
  const requiredSummary = await createIntentEscalationSweeper(required.deps).sweepOnce();
  assert.equal(requiredSummary.auto_approved, 0);
  assert.equal(requiredSummary.notified, 1);
});

test("anonymous proposers never self-approve", async () => {
  const fake = buildFakeDeps({
    candidates: [candidate(buildIntent({ proposer_actor_key: null }))],
  });
  const summary = await createIntentEscalationSweeper(fake.deps).sweepOnce();

  assert.equal(summary.auto_approved, 0);
  assert.equal(summary.notified, 1);
});

test("a lost fence counts nothing and per-intent failures are isolated", async () => {
  const lost = buildFakeDeps({
    candidates: [candidate(buildIntent())],
    autoApproveResult: null,
  });
  const lostSummary = await createIntentEscalationSweeper(lost.deps).sweepOnce();
  assert.equal(lostSummary.auto_approved, 0);

  const mixed = buildFakeDeps({
    candidates: [
      candidate(buildIntent({ id: "bi_bad", room_id: "focus_broken" })),
      candidate(buildIntent({ id: "bi_good" })),
    ],
    failCountsForRoom: "focus_broken",
  });
  const mixedSummary = await createIntentEscalationSweeper(mixed.deps).sweepOnce();
  assert.equal(mixedSummary.rooms_with_errors, 1);
  assert.equal(mixedSummary.auto_approved, 1);
  assert.ok(INTENT_ESCALATION_AFTER_MS > 0);
});
