import assert from "node:assert/strict";
import test from "node:test";

import type { CoordinationDecisionResult, CoordinationLeaseLike } from "../coordination-policy.js";
import {
  LETAGENTS_LEASE_CHECK_NAME,
  buildGitHubLeaseEnforcementPlan,
  buildLeasedBranchRef,
  publishGitHubLeaseEnforcement,
} from "../github-lease-enforcement.js";

function lease(overrides: Partial<CoordinationLeaseLike> = {}): CoordinationLeaseLike {
  return {
    id: "tl_lease",
    room_id: "github.com/brosincode/letagents",
    task_id: "task_98",
    kind: "work",
    status: "active",
    agent_key: "EmmyMay/wrenmoon",
    agent_instance_id: "instance:wrenmoon-1",
    actor_label: "WrenMoon | EmmyMay's agent | Agent",
    branch_ref: "letagents/task_98/emmymay-wrenmoon",
    pr_url: null,
    output_intent: "GitHub App branch and PR enforcement",
    expires_at: null,
    ...overrides,
  };
}

function allowDecision(
  overrides: Partial<CoordinationLeaseLike> = {}
): CoordinationDecisionResult {
  return {
    kind: "allow",
    lease: lease(overrides),
  };
}

test("buildLeasedBranchRef creates a deterministic branch namespace per task and agent", () => {
  assert.equal(
    buildLeasedBranchRef({
      taskId: "task_98",
      agentKey: "EmmyMay/WrenMoon",
    }),
    "letagents/task_98/emmymay-wrenmoon"
  );
});

test("buildGitHubLeaseEnforcementPlan emits a successful required check for matching leases", () => {
  const plan = buildGitHubLeaseEnforcementPlan({
    action: "opened",
    linkedTaskId: "task_98",
    pullRequest: {
      number: 214,
      url: "https://github.com/BrosInCode/letagents/pull/214",
      headRef: "letagents/task_98/emmymay-wrenmoon",
      headSha: "abc123",
    },
    decision: allowDecision(),
    mode: "checks",
  });

  assert.equal(plan?.checkRun?.name, LETAGENTS_LEASE_CHECK_NAME);
  assert.equal(plan?.checkRun?.conclusion, "success");
  assert.equal(plan?.commentBody, null);
  assert.equal(plan?.closePullRequest, false);
});

test("buildGitHubLeaseEnforcementPlan flags and closes unauthorized PRs in close mode", () => {
  const plan = buildGitHubLeaseEnforcementPlan({
    action: "opened",
    linkedTaskId: "task_98",
    pullRequest: {
      number: 215,
      url: "https://github.com/BrosInCode/letagents/pull/215",
      headRef: "random/unleased-work",
      headSha: "def456",
    },
    decision: {
      kind: "deny",
      code: "missing_lease",
      reason: "Mutation webhook_projection requires an active work lease matching the workflow artifact.",
    },
    mode: "close",
  });

  assert.equal(plan?.checkRun?.conclusion, "failure");
  assert.equal(plan?.commentBody?.includes("active work lease"), true);
  assert.equal(plan?.closePullRequest, true);
});

test("buildGitHubLeaseEnforcementPlan fails protected head branches even with an allow decision", () => {
  const plan = buildGitHubLeaseEnforcementPlan({
    action: "synchronize",
    linkedTaskId: "task_98",
    pullRequest: {
      number: 216,
      url: "https://github.com/BrosInCode/letagents/pull/216",
      headRef: "staging",
      headSha: "fed789",
    },
    decision: allowDecision({ branch_ref: "staging" }),
    mode: "checks",
  });

  assert.equal(plan?.checkRun?.conclusion, "failure");
  assert.equal(plan?.checkRun?.summary.includes("protected"), true);
  assert.equal(plan?.closePullRequest, false);
});

test("publishGitHubLeaseEnforcement skips without GitHub App credentials", async () => {
  let fetchCalls = 0;
  const result = await publishGitHubLeaseEnforcement({
    config: {
      appId: undefined,
      appSlug: undefined,
      clientId: undefined,
      clientSecret: undefined,
      privateKey: undefined,
      webhookSecret: "secret",
      baseUrl: "https://letagents.chat",
      callbackUrl: "https://letagents.chat/auth/github/app/callback",
      setupUrl: "https://letagents.chat/auth/github/app/callback",
    },
    installationId: "123",
    repositoryFullName: "BrosInCode/letagents",
    pullRequestNumber: 216,
    plan: buildGitHubLeaseEnforcementPlan({
      action: "opened",
      linkedTaskId: "task_98",
      pullRequest: {
        number: 216,
        url: "https://github.com/BrosInCode/letagents/pull/216",
        headRef: "letagents/task_98/emmymay-wrenmoon",
        headSha: "fed789",
      },
      decision: allowDecision(),
      mode: "checks",
    }),
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("unexpected fetch");
    }) as typeof fetch,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "missing_github_app_credentials");
  assert.equal(fetchCalls, 0);
});
