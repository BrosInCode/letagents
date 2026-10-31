import assert from "node:assert/strict";
import test from "node:test";

import type { TrackerRuleTrigger } from "../../../shared/ticket-connectors.mjs";
import { matchTrackerRules, rulesNeedApprovalCount, triggerMatches, type TrackerRuleEventFacts } from "../connectors/rules/matcher.js";
import { renderTrackerRuleTemplate } from "../connectors/rules/template.js";
import { parseTrackerRuleInput, parseTrackerRuleTrigger } from "../connectors/rules/validate.js";
import type { TrackerRuleEngineDeps } from "../connectors/rules/engine.js";
import type { LoadedTrackerRule } from "../connectors/rules/store.js";
import type { RepoRoomEvent } from "../repo-workflow.js";

// The engine module holds the default database wiring; nothing here connects.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  createTrackerRuleEngine,
  repoEventIsTrusted,
  repositoryPullRequestUrl,
  eventLinkIsConfirmed,
  trackerRuleEffectKey,
  trackerRuleFacts,
  trackerRuleTemplateValues,
} = await import("../connectors/rules/engine.js");

const opened: TrackerRuleEventFacts = { event: "pull_request", action: "opened", merged: false, draft: false, baseBranch: "main" };
const merged: TrackerRuleEventFacts = { event: "pull_request", action: "closed", merged: true, draft: false, baseBranch: "main" };
const approved: TrackerRuleEventFacts = { event: "pull_request_review", action: "submitted", baseBranch: "main", reviewState: "APPROVED", approvals: 2 };
const checkFailed: TrackerRuleEventFacts = { event: "check_run", action: "completed", conclusion: "failure" };

const cases: Array<{ name: string; trigger: TrackerRuleTrigger; facts: TrackerRuleEventFacts; matches: boolean }> = [
  { name: "event and action", trigger: { event: "pull_request", action: "opened" }, facts: opened, matches: true },
  { name: "another action", trigger: { event: "pull_request", action: "closed" }, facts: opened, matches: false },
  { name: "another event", trigger: { event: "pull_request_review", action: "opened" }, facts: opened, matches: false },
  { name: "merged true", trigger: { event: "pull_request", action: "closed", merged: true }, facts: merged, matches: true },
  { name: "merged false on a merge", trigger: { event: "pull_request", action: "closed", merged: false }, facts: merged, matches: false },
  { name: "merged unknown", trigger: { event: "pull_request", action: "closed", merged: true }, facts: { ...merged, merged: null }, matches: false },
  { name: "draft false", trigger: { event: "pull_request", action: "opened", draft: false }, facts: opened, matches: true },
  { name: "draft true on a ready PR", trigger: { event: "pull_request", action: "opened", draft: true }, facts: opened, matches: false },
  { name: "draft true on a draft", trigger: { event: "pull_request", action: "opened", draft: true }, facts: { ...opened, draft: true }, matches: true },
  { name: "base branch", trigger: { event: "pull_request", action: "opened", baseBranch: "main" }, facts: opened, matches: true },
  { name: "other base branch", trigger: { event: "pull_request", action: "opened", baseBranch: "release" }, facts: opened, matches: false },
  { name: "base branch is case sensitive", trigger: { event: "pull_request", action: "opened", baseBranch: "Main" }, facts: opened, matches: false },
  { name: "base branch unknown", trigger: { event: "pull_request", action: "opened", baseBranch: "main" }, facts: { ...opened, baseBranch: null }, matches: false },
  { name: "review state, any case", trigger: { event: "pull_request_review", action: "submitted", reviewState: "approved" }, facts: approved, matches: true },
  { name: "other review state", trigger: { event: "pull_request_review", action: "submitted", reviewState: "changes_requested" }, facts: approved, matches: false },
  { name: "approvals reached", trigger: { event: "pull_request_review", action: "submitted", approvalsAtLeast: 2 }, facts: approved, matches: true },
  { name: "approvals short", trigger: { event: "pull_request_review", action: "submitted", approvalsAtLeast: 3 }, facts: approved, matches: false },
  { name: "approvals not counted", trigger: { event: "pull_request_review", action: "submitted", approvalsAtLeast: 1 }, facts: { ...approved, approvals: null }, matches: false },
  { name: "check conclusion", trigger: { event: "check_run", action: "completed", conclusion: "failure" }, facts: checkFailed, matches: true },
  { name: "other check conclusion", trigger: { event: "check_run", action: "completed", conclusion: "success" }, facts: checkFailed, matches: false },
  { name: "every field", trigger: { event: "pull_request", action: "closed", merged: true, draft: false, baseBranch: "main" }, facts: merged, matches: true },
];

for (const entry of cases) {
  test(`trigger: ${entry.name}`, () => {
    assert.equal(triggerMatches(entry.trigger, entry.facts), entry.matches);
  });
}

test("the matcher returns every enabled matching rule, in order", () => {
  const rules = [
    { id: "a", enabled: true, trigger: { event: "pull_request", action: "opened" } as TrackerRuleTrigger },
    { id: "b", enabled: false, trigger: { event: "pull_request", action: "opened" } as TrackerRuleTrigger },
    { id: "c", enabled: true, trigger: { event: "pull_request", action: "closed" } as TrackerRuleTrigger },
    { id: "d", enabled: true, trigger: { event: "pull_request", action: "opened", draft: false } as TrackerRuleTrigger },
  ];
  assert.deepEqual(matchTrackerRules(rules, opened).map((rule) => rule.id), ["a", "d"]);
  assert.deepEqual(matchTrackerRules([], opened), []);
  assert.equal(rulesNeedApprovalCount(rules), false);
  assert.equal(rulesNeedApprovalCount([{ id: "e", enabled: true, trigger: { event: "pull_request_review", action: "submitted", approvalsAtLeast: 1 } }]), true);
});

test("triggers are validated strictly", () => {
  const refused: Array<[unknown, RegExp]> = [
    [null, /object/],
    [{ event: "push", action: "opened" }, /event must be/],
    [{ event: "pull_request", action: "submitted" }, /action for pull_request/],
    [{ event: "pull_request", action: "opened", extra: 1 }, /unknown field "extra"/],
    [{ event: "pull_request", action: "opened", merged: true }, /only to the closed action/],
    [{ event: "pull_request", action: "closed", merged: "yes" }, /true or false/],
    [{ event: "pull_request", action: "opened", reviewState: "approved" }, /only to pull_request_review/],
    [{ event: "pull_request_review", action: "submitted", draft: true }, /only to pull_request triggers/],
    [{ event: "pull_request_review", action: "submitted", approvalsAtLeast: 0 }, /whole number/],
    [{ event: "pull_request_review", action: "submitted", approvalsAtLeast: 1.5 }, /whole number/],
    [{ event: "pull_request_review", action: "submitted", reviewState: "lgtm" }, /reviewState/],
    [{ event: "check_run", action: "completed", baseBranch: "main" }, /does not apply/],
    [{ event: "check_run", action: "completed", conclusion: "green" }, /conclusion/],
    [{ event: "pull_request", action: "opened", baseBranch: "has space" }, /branch name/],
    [{ event: "pull_request", action: "opened", baseBranch: "a..b" }, /branch name/],
  ];
  for (const [input, error] of refused) {
    const result = parseTrackerRuleTrigger(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match((result as { error: string }).error, error);
  }
  assert.deepEqual(parseTrackerRuleTrigger({ event: "pull_request", action: "closed", merged: true, baseBranch: "release/2026" }), {
    ok: true, value: { event: "pull_request", action: "closed", merged: true, baseBranch: "release/2026" },
  });
});

test("rules are validated strictly", () => {
  const trigger = { event: "pull_request", action: "opened" };
  const base = { name: "Rule", room_id: null, trigger, actions: [{ kind: "transition", toStatus: "In Review" }] };
  assert.equal(parseTrackerRuleInput(base).ok, true);
  const refused: Array<[unknown, RegExp]> = [
    [{ ...base, name: "" }, /name/],
    [{ ...base, owner: "x" }, /unknown field "owner"/],
    [{ ...base, actions: [] }, /1 to 5 actions/],
    [{ ...base, actions: Array.from({ length: 6 }, () => ({ kind: "comment", template: "hi" })) }, /1 to 5 actions/],
    [{ ...base, actions: [{ kind: "transition", toStatus: "" }] }, /tracker status/],
    [{ ...base, actions: [{ kind: "transition", toStatus: "A" }, { kind: "transition", toStatus: "B" }] }, /one status/],
    [{ ...base, actions: [{ kind: "comment", template: "{{secret}}" }] }, /not a template variable/],
    [{ ...base, actions: [{ kind: "comment", template: "{{ pr_url.constructor }}" }] }, /not a template variable/],
    [{ ...base, actions: [{ kind: "comment", template: "hi", connection_id: "x" }] }, /unknown field/],
    [{ ...base, actions: [{ kind: "delete" }] }, /transition or a comment/],
    [{ ...base, room_id: 12 }, /room/],
    [{ ...base, enabled: "yes" }, /enabled/],
  ];
  for (const [input, error] of refused) {
    const result = parseTrackerRuleInput(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match((result as { error: string }).error, error);
  }
});

test("template values are inserted as plain text", () => {
  const values = {
    pr_url: "https://github.com/acme/app/pull/7",
    pr_number: 7,
    pr_title: "Fix [the link](https://evil.example) **now**\n\n@channel please",
    author: "kai",
    branch: "HT-1-x",
    base_branch: "main",
    repo: "acme/app",
    reviewer: null,
  };
  const template = "{{pr_title}} ({{pr_url}}) by {{author}}; reviewer: {{reviewer}}";
  assert.equal(
    renderTrackerRuleTemplate(template, values, "jira"),
    "Fix [the link](https://evil.example) **now** @channel please (https://github.com/acme/app/pull/7) by kai; reviewer: ",
    "Jira gets plain ADF text: one line, no new paragraphs",
  );
  const linear = renderTrackerRuleTemplate(template, values, "linear");
  assert.ok(linear.includes("Fix \\[the link\\]\\(https\\:"), linear);
  assert.ok(linear.includes("\\*\\*now\\*\\*"));
  assert.ok(linear.includes("@\u200bchannel"), "no Linear mention from a PR title");
  assert.equal(renderTrackerRuleTemplate("{{author}}", { author: "a\u202eb\u0085c" }, "jira"), "a b c", "bidi overrides and C1 controls go");
  assert.equal(renderTrackerRuleTemplate("{{author}}", { author: "\u{1F600}".repeat(400) }, "jira"), `${"\u{1F600}".repeat(299)}…`);
  assert.ok(linear.includes("(https://github.com/acme/app/pull/7)"), "the template's own text and the URL stay as written");
  assert.equal(renderTrackerRuleTemplate("{{pr_url}}", { pr_url: "javascript:alert(1)" }, "linear"), "");
  assert.equal(renderTrackerRuleTemplate("{{pr_url}}", { pr_url: "http://github.com/x" }, "jira"), "");
  assert.equal(renderTrackerRuleTemplate("{{author}}", { author: "x".repeat(1_000) }, "jira").length, 300);
  // A value cannot add a placeholder that is filled later.
  assert.equal(renderTrackerRuleTemplate("{{pr_title}}", { pr_title: "{{author}}", author: "kai" }, "jira"), "{{author}}");
});

const pullRequestOpened = {
  provider: "github",
  kind: "pull_request",
  action: "opened",
  repositoryFullName: "acme/app",
  senderLogin: "kai",
  pullRequest: {
    number: 91, title: "Fix", url: "https://github.com/acme/app/pull/91", headRef: "HT-1234-x", authorLogin: "kai", authorAssociation: "MEMBER",
  },
} as RepoRoomEvent;

test("facts come from the event and the stored row", () => {
  assert.deepEqual(trackerRuleFacts(pullRequestOpened, { event_type: "pull_request", base_ref: "main" }, null), {
    event: "pull_request", action: "opened", merged: false, draft: false, baseBranch: "main",
  });
  assert.equal(trackerRuleFacts({ ...pullRequestOpened, kind: "push" } as unknown as RepoRoomEvent, { event_type: "push" }, null), null);
});

type WorkflowEffectLike = Awaited<ReturnType<TrackerRuleEngineDeps["drive"]>>;
type RunRow = Awaited<ReturnType<TrackerRuleEngineDeps["store"]["getRun"]>> & object;

/** The engine on in-memory runs and journal rows. `outcomes` says what each drive of an action index returns. */
function engineHarness(rules: LoadedTrackerRule[], options: { bound?: boolean; trusted?: boolean; outcomes?: Record<number, string[]>; driveMs?: number } = {}) {
  const runs = new Map<string, RunRow>();
  const effects = new Map<string, WorkflowEffectLike>();
  const reserved: string[] = [];
  const driven: string[] = [];
  const pending: Array<Promise<void>> = [];
  const drives = new Map<number, number>();
  const deps: TrackerRuleEngineDeps = {
    store: {
      forRoom: async () => rules,
      claimRun: async (input, claim) => {
        if (claim?.skipReason) return { run: null, claimed: false };
        const existing = [...runs.values()].find((run) => run.rule_id === input.rule_id && run.delivery_id === input.delivery_id);
        if (existing) return { run: existing, claimed: true };
        const run = { ...input, id: `run_${runs.size + 1}`, effect_ids: [], outcome: "pending", detail: null, created_at: "", updated_at: "" } as RunRow;
        runs.set(run.id, run);
        return { run, claimed: true };
      },
      getRun: async (id) => runs.get(id) ?? null,
      appendEffect: async (id, index, effectId) => {
        const run = runs.get(id)!;
        if ((run.effect_ids as string[]).length === index) run.effect_ids = [...(run.effect_ids as string[]), effectId];
      },
      finishRun: async (id, input) => {
        const run = runs.get(id)!;
        if (run.outcome === "pending") Object.assign(run, input);
      },
      takePendingRuns: async (limit) => [...runs.values()].filter((run) => run.outcome === "pending").map((run) => run.id).slice(0, limit),
      stallOldRuns: async () => 0,
    },
    roomScope: async () => ({ sources: [{ filter_id: "f", connection_id: "tcon_1", provider: "jira", filter: "project = HT" }], linearTeamKeys: [] }),
    roomConnection: async () => ({ connection_id: "tcon_1", account_id: "acct_1", provider: "jira" }),
    ticketBound: async () => options.bound ?? true,
    ownerIsRoomAdmin: async () => true,
    countApprovals: async () => 0,
    reserve: async (input) => {
      const id = `effect_${input.idempotency_key}`;
      const existing = effects.get(id);
      if (existing) return { effect: existing, claimed: false, processing_token: null };
      reserved.push(input.idempotency_key);
      const effect = { id, state: "pending", quarantined_at: null, attempt_count: 1, max_attempts: 3 } as WorkflowEffectLike;
      effects.set(id, effect);
      return { effect, claimed: true, processing_token: "t" };
    },
    drive: async (entry) => {
      const index = Number(entry.effect.id.split(":").at(-1));
      const count = drives.get(index) ?? 0;
      drives.set(index, count + 1);
      driven.push(entry.effect.id);
      if (options.driveMs) await new Promise((resolve) => setTimeout(resolve, options.driveMs));
      const state = options.outcomes?.[index]?.[count] ?? "succeeded";
      const effect = { ...effects.get(entry.effect.id)!, state, ...(state === "dead" ? { state: "failed", attempt_count: 3 } : {}) } as WorkflowEffectLike;
      effects.set(effect.id, effect);
      return effect;
    },
    getEffect: async (id) => effects.get(id) ?? null,
    schedule: (work) => { pending.push(work()); },
  };
  const engine = createTrackerRuleEngine(deps);
  return { engine, runs, effects, reserved, driven, settle: () => Promise.all(pending.splice(0)) };
}

const loadedRule: LoadedTrackerRule = {
  id: "trule_1", connection_id: "tcon_1", room_id: null, name: "Opened", enabled: true, version: 1,
  trigger: { event: "pull_request", action: "opened", draft: false },
  actions: [{ kind: "transition", toStatus: "In Review" }, { kind: "comment", template: "{{pr_url}}" }],
};

const keyedInput = {
  deliveryId: "d-1",
  storedEvent: { event_type: "pull_request", base_ref: "main" },
  eventRoomId: "room",
  roomEvent: pullRequestOpened,
  task: { id: "task_1", room_id: "room", external_ref: "jira:HT-1234", pr_url: null, workflow_artifacts: [] },
  matchedByTicketKey: true,
};

test("the engine reserves each action only after the one before it succeeded", async () => {
  const harness = engineHarness([loadedRule]);
  const result = await harness.engine.runForRepoEvent(keyedInput);
  assert.deepEqual(harness.reserved, [trackerRuleEffectKey("trule_1", "d-1", "jira:HT-1234", 0)], "only the first row before the webhook answers");
  await harness.settle();
  assert.deepEqual(result.runs, ["run_1"]);
  assert.deepEqual(harness.reserved, ["trule_1:d-1:jira:HT-1234:0", "trule_1:d-1:jira:HT-1234:1"]);
  assert.equal(harness.runs.get("run_1")!.outcome, "succeeded");
});

test("a retryable failure waits; once the sweep settles it the next action runs", async () => {
  const harness = engineHarness([loadedRule], { outcomes: { 0: ["failed"] } });
  await harness.engine.runForRepoEvent(keyedInput);
  await harness.settle();
  assert.equal(harness.reserved.length, 1, "the comment is not reserved while the transition may still be retried");
  assert.equal(harness.runs.get("run_1")!.outcome, "pending");
  // The journal sweep retries the transition, and it lands.
  const transition = [...harness.effects.values()][0]!;
  harness.effects.set(transition.id, { ...transition, state: "succeeded" });
  await harness.engine.advancePendingRuns();
  assert.equal(harness.reserved.length, 2);
  assert.equal(harness.runs.get("run_1")!.outcome, "succeeded");
});

test("a failure with no attempts left ends the run; later actions are never reserved", async () => {
  const harness = engineHarness([loadedRule], { outcomes: { 0: ["dead"] } });
  await harness.engine.runForRepoEvent(keyedInput);
  await harness.settle();
  await harness.engine.advancePendingRuns();
  assert.equal(harness.reserved.length, 1);
  assert.equal(harness.runs.get("run_1")!.outcome, "failed");
});

test("a retried delivery continues the run and never resets it", async () => {
  const harness = engineHarness([loadedRule]);
  await harness.engine.runForRepoEvent(keyedInput);
  await harness.settle();
  await harness.engine.runForRepoEvent(keyedInput);
  await harness.settle();
  assert.equal(harness.reserved.length, 2);
  assert.equal(harness.runs.get("run_1")!.outcome, "succeeded");
});

test("the engine skips cards without a tracker ref, sync events, and links that are not the ticket key", async () => {
  const harness = engineHarness([loadedRule]);
  assert.deepEqual((await harness.engine.runForRepoEvent({ ...keyedInput, task: { ...keyedInput.task, external_ref: null } })).runs, []);
  assert.deepEqual((await harness.engine.runForRepoEvent({ ...keyedInput, storedEvent: { event_type: "tracker_ticket" } })).runs, []);
  assert.deepEqual((await harness.engine.runForRepoEvent({ ...keyedInput, matchedByTicketKey: false })).runs, [],
    "a lease or a hand-set pr_url is not a confirmed link");
  await harness.settle();
  assert.deepEqual(harness.reserved, []);
});

test("a check run counts as linked only for the pull request the key linked", () => {
  const check = { provider: "github", kind: "check_run", action: "completed", repositoryFullName: "acme/app",
    checkRun: { id: "1", name: "ci", status: "completed", conclusion: "failure", url: "u" } } as RepoRoomEvent;
  const task = { ...keyedInput.task, workflow_artifacts: [
    { provider: "github", kind: "pull_request", number: 91, url: "https://github.com/acme/app/pull/91", linked_by: "ticket_key" },
    { provider: "github", kind: "pull_request", number: 92, url: "https://github.com/acme/app/pull/92" },
  ] } as typeof keyedInput.task;
  const stored = (numbers: number[]) => ({ event_type: "check_run", metadata: { same_repo_pull_request_numbers: numbers } });
  assert.equal(eventLinkIsConfirmed({ roomEvent: check, storedEvent: stored([91]), task, matchedByTicketKey: false }), true);
  assert.equal(eventLinkIsConfirmed({ roomEvent: check, storedEvent: stored([92]), task, matchedByTicketKey: false }), false);
  assert.equal(eventLinkIsConfirmed({ roomEvent: check, storedEvent: stored([]), task, matchedByTicketKey: false }), false);
});

test("only people with access to the repository fire rules", () => {
  const stored = { event_type: "pull_request" };
  const base = (pullRequestOpened as { pullRequest: Record<string, unknown> }).pullRequest;
  const outsider = { ...pullRequestOpened, pullRequest: { ...base, authorAssociation: "NONE" } } as RepoRoomEvent;
  assert.equal(repoEventIsTrusted(pullRequestOpened, stored), true);
  assert.equal(repoEventIsTrusted(outsider, stored), false);
  const mergedOutsider = { ...outsider, action: "closed", pullRequest: { ...base, authorAssociation: "NONE", merged: true } } as RepoRoomEvent;
  assert.equal(repoEventIsTrusted(mergedOutsider, stored), true, "a merge needs write access");
  const review = (association: string) => ({
    provider: "github", kind: "pull_request_review", action: "submitted", repositoryFullName: "acme/app",
    pullRequest: base,
    review: { id: "1", state: "approved", url: "u", authorAssociation: association },
  }) as unknown as RepoRoomEvent;
  assert.equal(repoEventIsTrusted(review("COLLABORATOR"), stored), true);
  assert.equal(repoEventIsTrusted(review("CONTRIBUTOR"), stored), false);
  const check = { provider: "github", kind: "check_run", action: "completed", repositoryFullName: "acme/app",
    checkRun: { id: "1", name: "ci", status: "completed", conclusion: "failure", url: "u" } } as RepoRoomEvent;
  assert.equal(repoEventIsTrusted(check, { event_type: "check_run", metadata: { same_repo_pull_request_numbers: [1] } }), true);
  assert.equal(repoEventIsTrusted(check, { event_type: "check_run", metadata: { same_repo_pull_request_numbers: [] } }), false, "a fork's branch");
});

test("pr_url is only ever the event repository's pull request URL", () => {
  assert.equal(repositoryPullRequestUrl("https://github.com/acme/app/pull/7", "acme/app"), "https://github.com/acme/app/pull/7");
  assert.equal(repositoryPullRequestUrl("https://github.com/other/app/pull/7", "acme/app"), null);
  assert.equal(repositoryPullRequestUrl("https://x/a)![t](https://evil/p.png", "acme/app"), null);
  assert.equal(repositoryPullRequestUrl("https://github.com/acme/app/pull/7)", "acme/app"), null);
  const check = { provider: "github", kind: "check_run", action: "completed", repositoryFullName: "acme/app",
    checkRun: { id: "1", name: "ci", status: "completed", conclusion: "failure", url: "u" } } as RepoRoomEvent;
  const values = trackerRuleTemplateValues(check, { event_type: "check_run" },
    { id: "t", room_id: "r", external_ref: null, pr_url: "https://x/a)![t](https://evil/p.png" });
  assert.equal(values.pr_url, null);
});

test("a card that sync never bound to the ticket runs no rule", async () => {
  const harness = engineHarness([loadedRule], { bound: false });
  const result = await harness.engine.runForRepoEvent({ ...keyedInput, task: { ...keyedInput.task, external_ref: "jira:HR-17" } });
  assert.deepEqual(result.runs, []);
  assert.deepEqual(harness.reserved, []);
});

test("a cut comment never ends in half an escape", () => {
  const body = renderTrackerRuleTemplate(`${"a".repeat(15_997)}{{pr_title}}`, { pr_title: "**" }, "linear");
  assert.ok(body.length < 16_000);
  assert.equal(/\\*$/.exec(body)![0].length % 2, 0);
});

test("a slow tracker does not hold the liveness tick past its budget", async () => {
  const harness = engineHarness([loadedRule], { outcomes: { 0: ["failed", "failed", "failed", "failed"] }, driveMs: 400 });
  for (let index = 0; index < 4; index += 1) {
    await harness.engine.runForRepoEvent({ ...keyedInput, deliveryId: `slow-${index}` });
  }
  await harness.settle();
  // Every run waits on its first write; the sweep settles them, and the next ones are slow.
  for (const effect of harness.effects.values()) harness.effects.set(effect.id, { ...effect, state: "succeeded" });
  const started = Date.now();
  const taken = await harness.engine.advancePendingRuns({ limit: 10, concurrency: 2, budgetMs: 100 });
  assert.equal(taken, 4);
  assert.ok(Date.now() - started < 350, `the tick returned after ${Date.now() - started} ms`);
  // The runs still writing are not taken again by the next tick.
  assert.equal(await harness.engine.advancePendingRuns({ limit: 10, concurrency: 2, budgetMs: 10 }), 2);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
});
