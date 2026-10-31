import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { claudeApiFailureClass, defaultFollowUpDelayMs, MAX_AUTOMATIC_FOLLOW_UPS, parseClaudeApiFailure, SHORT_FAULT_FOLLOW_UP_DELAYS_MS, taskFailurePolicy } from "../task-continuity.js";
import { NO_REPLY_FAILURE } from "../../../../shared/room-turn-no-reply.mjs";
import {
  agent,
  currentAuthority,
  provider,
  waitForAsync,
  ingest,
  continuityTask,
  runNoReplyContinuity,
  ClaudeFacts,
  RETRY_DELIVERY,
  SHORT_FAULT_WAITS,
  temporaryAt,
  DOES_NOT_FIT,
  STOPPED_AFTER_THREE,
  runFailingLeaseHolder,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("a transient provider failure continues its unfinished task without another room message", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-task-continuity-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let runs = 0;
  let partialWrites = 0;
  let completed = false;
  const task = { id: "task_1", title: "Finish the existing change", leaseId: "lease-1", epoch: 0 };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs === 1) {
      partialWrites += 1;
      return { turnId, providerContinuationId: "thread", outcome: "failed", text: null,
        evidence: "stream", error: "HTTP 503 Service Unavailable" };
    }
    assert.match(JSON.stringify(request.sourceMessage), /task_1/);
    assert.match(JSON.stringify(request.sourceMessage), /existing work/i);
    completed = true;
    return { turnId, outcome: "reply", text: "The remaining work is finished." };
  }), {
    poll: async () => ({}),
    ownedTasks: async () => completed ? [] : [task],
    publish: async () => ({ roomId: agent.roomId, messageId: "msg_2" }),
  }, currentAuthority, 0, async () => {});
  try {
    await ingest(store);
    await delivery.pump(agent);
    assert.equal(runs, 2, "the failed turn must not strand the task when the room stays quiet");
    assert.equal(partialWrites, 1, "the original turn and its completed work must not be replayed");
    assert.equal(completed, true);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_failed");
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "1");
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const kind of ["outputLimit", "emptyAnswer", "deniedTool"] as const) {
  test(`a lease holder's ${kind} failure gets one follow-up turn that says why, without blocking later messages`, async () => {
    const policy = taskFailurePolicy(NO_REPLY_FAILURE[kind], 1);
    assert.equal(policy.automatic, true);
    assert.equal(taskFailurePolicy(NO_REPLY_FAILURE[kind], 2).settle, true, "a repeat stops instead of blocking");
    const { receipts, sources, prompts } = await runNoReplyContinuity([NO_REPLY_FAILURE[kind]], [["1"], ["2"]]);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"]);
    assert.deepEqual(sources, ["1", "continuation", "2"], "the follow-up is a new turn and the next room message still runs");
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes(policy.note!), "the follow-up prompt says why the previous turn failed");
    if (kind === "deniedTool") assert.match(policy.note!, /a tool call was denied.*Do not run it again/);
  });
}

test("a model that hits its output limit every turn never blocks later room messages", async () => {
  const limit = NO_REPLY_FAILURE.outputLimit;
  const { receipts, sources } = await runNoReplyContinuity([limit, limit, limit, limit, limit], [["1"], ["2", "3"]]);
  assert.deepEqual(sources, ["1", "continuation", "2", "3", "continuation"]);
  assert.ok(receipts.every((item) => item.state === "acknowledged_failed"), JSON.stringify(receipts.map((item) => item.state)));
  assert.equal(receipts.length, 5, "no blocked follow-up was queued");
  for (const index of [0, 1, 3, 4]) {
    assert.match(receipts[index]!.last_error ?? "", /happened again.*send a message to continue it/,
      "the reason reaches the follow-up and the room message it continued");
    assert.ok(receipts[index]!.updated_at > receipts[index]!.acknowledged_at!, "the change is visible to change detection");
  }
  assert.equal(receipts[2]!.last_error, limit, "a message with no follow-up keeps its own reason");
});

test("a content-filter failure is settled without a follow-up and without blocking later messages", async () => {
  const { receipts, sources } = await runNoReplyContinuity([NO_REPLY_FAILURE.contentFilter], [["1"], ["2"]]);
  assert.deepEqual(sources, ["1", "2"]);
  assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
  assert.match(receipts[0]!.last_error ?? "", /content filter.*not continued automatically/);
});

test("a provider's refusal of a lease holder's turn is settled with its reason and never blocks later messages", async () => {
  const reason = "This content was flagged by the provider. Try rephrasing your request.";
  const policy = taskFailurePolicy(reason, 1, true);
  assert.deepEqual({ automatic: policy.automatic, settle: policy.settle }, { automatic: false, settle: true });
  assert.ok(policy.detail.startsWith(reason), "the provider's own reason leads the message");
  // A follow-up turn that is refused as well is settled the same way, however many came before it.
  for (const attempt of [2, 3, 4, 9]) assert.deepEqual(taskFailurePolicy(reason, attempt, true), policy, `attempt ${attempt}`);

  const { receipts, sources } = await runNoReplyContinuity([reason, reason], [["1"], ["2"], ["3"]], [1, 2]);
  assert.deepEqual(sources, ["1", "2", "3"], "no follow-up turn repeats the refused context, and each next message still runs");
  assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_no_reply"],
    "a second refusal in a row is settled the same way; no blocked follow-up was queued");
  for (const refused of receipts.slice(0, 2)) {
    assert.equal(Object.hasOwn(refused.activation, "task_continuity_refusal"), false, "nothing is kept on the message that would need clearing");
    assert.ok(refused.last_error?.startsWith(reason), refused.last_error ?? "");
    assert.match(refused.last_error ?? "", /not continued automatically.*send a message to continue it/);
  }
});

test("a lease holder's failure that the owner can clear still blocks until Retry delivery", async () => {
  // The same wording without the provider's refusal mark is an unknown
  // failure, and a rejected key is one only the owner can fix. Continuing is
  // how the held task resumes after that, so the follow-up waits, blocked.
  for (const reason of [
    "This content was flagged by the provider. Try rephrasing your request.",
    "unexpected status 401 Unauthorized: the provider rejected this key.",
  ]) {
    assert.equal(taskFailurePolicy(reason, 1).settle, undefined, reason);
    const { receipts, sources } = await runNoReplyContinuity([reason], [["1"], ["2"]]);
    assert.deepEqual(sources, ["1"], reason);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], reason);
    assert.match(receipts[1]!.last_error ?? "", /use Retry delivery to continue the existing task/, reason);
  }
});

test("only the provider's own result marks a turn refused: a message that arrives claiming it is treated as any other", async () => {
  const reason = "unexpected status 401 Unauthorized: the provider rejected this key.";
  const { receipts, sources } = await runNoReplyContinuity([reason], [["1"], ["2"]], [], { task_continuity_refusal: true });
  assert.deepEqual(sources, ["1"]);
  assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"],
    "the failure blocks until Retry delivery, as without the claim");
});

test("a lease holder's turn that ended on an unrecognized result is settled with its text, whatever the text says: no follow-up and no block", async () => {
  // The text of such a failure may be the model's own words. The first reads
  // like a temporary provider failure and the second like nothing at all.
  for (const words of ["Done. I changed 500 lines and all tests pass.", "Merged the PR.", "429 rate limit overloaded 401 unauthorized credit limit"]) {
    const reason = `Claude ended this turn with a result LetAgents does not recognize (subtype "success", no is_error), so nothing was posted. Claude's text: ${words}`;
    const policy = taskFailurePolicy(reason, 1, false, true);
    assert.deepEqual({ automatic: policy.automatic, settle: policy.settle }, { automatic: false, settle: true }, words);
    assert.ok(policy.detail.startsWith(reason), "the text stays for the owner to read");
    for (const attempt of [2, 3, 4, 9]) assert.deepEqual(taskFailurePolicy(reason, attempt, false, true), policy, `attempt ${attempt}`);

    const { receipts, sources } = await runNoReplyContinuity([reason], [["1"], ["2"]], [], {}, [1]);
    assert.deepEqual(sources, ["1", "2"], `${words}: no follow-up turn is started, and the next message runs`);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"], `${words}: no blocked follow-up is queued`);
    assert.ok(receipts[0]!.last_error?.startsWith(reason), receipts[0]!.last_error ?? "");
    assert.match(receipts[0]!.last_error ?? "", /not continued automatically.*send a message to continue it/);
  }
});

test("only the adapter's mark keeps a failure text from being read: the same words without it are a provider error as before", async () => {
  // Without the mark the text is a provider's error text, and what it says decides what happens next.
  const temporary = "Done. I changed 500 lines and all tests pass.";
  assert.equal(taskFailurePolicy(temporary, 1).automatic, true);
  const continued = await runNoReplyContinuity([temporary], [["1"], ["2"]]);
  assert.deepEqual(continued.sources, ["1", "continuation", "2"], "a follow-up turn is started");

  const unknown = "Merged the PR.";
  assert.deepEqual({ automatic: taskFailurePolicy(unknown, 1).automatic, settle: taskFailurePolicy(unknown, 1).settle }, { automatic: false, settle: undefined });
  const blocked = await runNoReplyContinuity([unknown], [["1"], ["2"]]);
  assert.deepEqual(blocked.receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], "the next message waits behind a blocked follow-up");

  // A message from the room cannot set the mark: it is read from the saved result of the turn alone.
  const claimed = await runNoReplyContinuity([unknown], [["1"], ["2"]], [], { unrecognizedResult: true, task_continuity_unrecognized_result: true });
  assert.deepEqual(claimed.receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"]);
});

test("Claude's structured account of a failure makes its kind: the status of a refused credential, then its name for the error, then the provider's status", () => {
  const kind = (status: number | null, terminalReason: string | null, category: string | null) => claudeApiFailureClass({ status, terminalReason, category });
  // A short fault: a rate limit, a server error, and a connection that was refused or lost (no status at all).
  for (const facts of [[429, "api_error", "rate_limit"], [500, "api_error", "server_error"], [529, "api_error", "server_error"],
    [null, "api_error", "server_error"], [503, null, null], [429, "api_error", "unknown"], [529, "api_error", "overloaded"]] as const) {
    assert.equal(kind(...facts), "short_fault", JSON.stringify(facts));
  }
  // Only the owner can clear these.
  assert.equal(kind(401, "api_error", "authentication_failed"), "authentication");
  assert.equal(kind(403, null, null), "authentication");
  assert.equal(kind(404, "api_error", "model_not_found"), "model");
  // A low credit balance and a malformed request are both HTTP 400. Claude's name for the error tells them apart.
  assert.equal(kind(400, "api_error", "billing_error"), "billing");
  assert.equal(kind(413, "image_error", "invalid_request"), "request");
  // `invalid_request` is Claude's name for many failures. A 400 with that name is a request that cannot succeed as
  // it was sent, and it is the same kind with the result's terminal reason (the stream) and without it (the session).
  for (const terminalReason of ["api_error", null]) {
    assert.equal(kind(400, terminalReason, "invalid_request"), "request", `terminal reason ${terminalReason}`);
    assert.equal(kind(413, terminalReason, "invalid_request"), "request", `terminal reason ${terminalReason}`);
    // A refused credential is the owner's to put right, whatever name Claude gave it: the status is read before that name.
    assert.equal(kind(401, terminalReason, "invalid_request"), "authentication", `terminal reason ${terminalReason}`);
    assert.equal(kind(403, terminalReason, "invalid_request"), "authentication", `terminal reason ${terminalReason}`);
    assert.equal(kind(403, terminalReason, "unknown"), "authentication", `terminal reason ${terminalReason}`);
  }
  // That status is read before every name: a 401 that Claude named a server error is not retried as a short fault.
  for (const category of ["server_error", "rate_limit", "model_not_found", "billing_error", "max_output_tokens", "authentication_failed", null]) {
    assert.equal(kind(401, "api_error", category), "authentication", `a 401 named ${category}`);
    assert.equal(kind(403, "api_error", category), "authentication", `a 403 named ${category}`);
  }
  assert.equal(kind(404, "api_error", "model_not_found"), "model");
  // A 400 is a request that cannot succeed only when Claude named the error at all, if only as `unknown`. A bare
  // 400 says too little: a low credit balance is a 400 too. Its text is read.
  assert.equal(kind(400, "api_error", "unknown"), "request");
  assert.equal(kind(400, "api_error", null), null);
  assert.equal(kind(400, null, null), null);
  assert.equal(kind(413, null, null), "request", "a request that is too large says so by its status");
  // A request that does not fit the model's context is told by the result's terminal reason: the provider refused
  // it (`prompt_too_long`), or Claude Code did not send it (`blocking_limit`, with no status). The session keeps no
  // terminal reason: there the start of the error's text says it, and nothing else does.
  assert.equal(kind(400, "prompt_too_long", "invalid_request"), "conversation");
  assert.equal(kind(400, "prompt_too_long", null), "conversation");
  assert.equal(kind(413, "prompt_too_long", "invalid_request"), "conversation");
  assert.equal(kind(null, "blocking_limit", "invalid_request"), "conversation");
  assert.equal(kind(null, "blocking_limit", null), "conversation");
  assert.equal(claudeApiFailureClass({ status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true }), "conversation");
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: "invalid_request", promptTooLong: true }), "conversation");
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: null, promptTooLong: true }), "conversation");
  assert.equal(kind(null, null, "invalid_request"), "request", "the name alone, with nothing that says the context is full");
  assert.equal(kind(null, "rapid_refill_breaker", "invalid_request"), "request");
  // The account's usage limit and a brief rate limit have one name and one status. A usage window that rejected the turn tells them apart.
  assert.equal(claudeApiFailureClass({ status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true }), "billing");
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: "rate_limit", usageLimit: true }), "billing");
  for (const category of [null, "unknown", "invalid_request"]) {
    assert.equal(claudeApiFailureClass({ status: 429, terminalReason: null, category, usageLimit: true }), "billing", `a 429 named ${category}`);
  }
  assert.equal(kind(429, null, null), "short_fault");
  assert.equal(claudeApiFailureClass({ status: 401, terminalReason: "api_error", category: "authentication_failed", usageLimit: true }), "authentication",
    "a rejected usage window makes no other failure a usage limit");
  assert.equal(claudeApiFailureClass({ status: 500, terminalReason: "api_error", category: "server_error", usageLimit: true }), "short_fault");
  assert.equal(kind(null, "api_error", "max_output_tokens"), "output_limit");
  // The fields say nothing that decides: the text is read, as for any provider.
  for (const facts of [[null, "api_error", "unknown"], [null, null, null], [404, "api_error", "unknown"], [418, "api_error", "a_name_from_the_future"]] as const) {
    assert.equal(kind(...facts), null, JSON.stringify(facts));
  }
  assert.equal(claudeApiFailureClass(null), null);
  // What was saved is read back with no trust in it: a status and short names, and nothing else.
  assert.deepEqual(parseClaudeApiFailure({ status: 500, terminalReason: "api_error", category: "server_error", more: "ignored" }),
    { status: 500, terminalReason: "api_error", category: "server_error" });
  assert.deepEqual(parseClaudeApiFailure({ status: "500", terminalReason: "rate limit, retry at once", category: ["server_error"], usageLimit: "true" }),
    { status: null, terminalReason: null, category: null });
  assert.deepEqual(parseClaudeApiFailure({ status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true }),
    { status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true });
  assert.deepEqual(parseClaudeApiFailure({ status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true }),
    { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true });
  for (const saved of [undefined, null, "server_error", ["server_error"], 500]) assert.equal(parseClaudeApiFailure(saved), null);
});

test("what was saved of Claude's account is read back within bounds: an HTTP status, short names, and marks that are exactly true", () => {
  const read = (saved: Record<string, unknown>) => parseClaudeApiFailure({ terminalReason: "api_error", category: "server_error", ...saved });
  // A status is a whole number from 100 to 599. Anything else is not a status, and decides nothing.
  for (const status of [100, 400, 429, 599]) assert.equal(read({ status })?.status, status, String(status));
  for (const status of [99, 600, 0, -429, 429.5, 4290, Number.NaN, Number.POSITIVE_INFINITY, "429", true, null, [429], { status: 429 }]) {
    assert.equal(read({ status })?.status, null, JSON.stringify(status) ?? String(status));
  }
  // So a saved value out of range cannot make a kind by its status: with no name, nothing is said.
  assert.equal(claudeApiFailureClass(parseClaudeApiFailure({ status: 4290, terminalReason: null, category: null })), null);
  assert.equal(claudeApiFailureClass(parseClaudeApiFailure({ status: 600, terminalReason: null, category: null })), null);
  assert.equal(claudeApiFailureClass(parseClaudeApiFailure({ status: 599, terminalReason: null, category: null })), "short_fault");
  // A name is lower case, starts with a letter, and has at most 64 characters.
  for (const name of ["rate_limit", "a", "x9_y", `a${"b".repeat(63)}`]) {
    assert.deepEqual([read({ category: name })?.category, read({ terminalReason: name })?.terminalReason], [name, name], name);
  }
  for (const name of ["", "Rate_Limit", "rate limit", "9lives", "_private", "rate-limit", `a${"b".repeat(64)}`, "prompt_too_long\n", 429, null, ["rate_limit"]]) {
    assert.deepEqual([read({ category: name })?.category, read({ terminalReason: name })?.terminalReason], [null, null], JSON.stringify(name));
  }
  // A mark is kept only when it is exactly true.
  for (const mark of ["true", 1, {}, [], null, false]) {
    assert.deepEqual(parseClaudeApiFailure({ status: 429, terminalReason: null, category: "rate_limit", usageLimit: mark, promptTooLong: mark }),
      { status: 429, terminalReason: null, category: "rate_limit" }, JSON.stringify(mark));
  }
});

test("each kind of Claude failure has its own decision for a lease holder, whatever else its text reads like", () => {
  // The text of every failure here reads like something else than its kind.
  const policy = (text: string, attempt: number, facts: ClaudeFacts) => taskFailurePolicy(text, attempt, false, false, facts);
  const shortFault = { status: null, terminalReason: "api_error", category: "server_error" };
  for (const attempt of [1, 2, 3]) {
    assert.deepEqual(policy("Connection refused. 401 unauthorized, credit limit.", attempt, shortFault), temporaryAt(attempt));
  }
  assert.deepEqual(policy("Connection refused.", 4, shortFault), { automatic: false, detail: STOPPED_AFTER_THREE }, "the bound holds for a short fault");
  for (const attempt of [1, 4]) {
    assert.deepEqual(policy("Invalid API key. 503 temporarily overloaded.", attempt, { status: 401, terminalReason: "api_error", category: "authentication_failed" }),
      { automatic: false, detail: `The model provider needs authentication or account access. ${RETRY_DELIVERY}` });
    assert.deepEqual(policy("Credit balance is too low", attempt, { status: 400, terminalReason: "api_error", category: "billing_error" }),
      { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` });
    assert.deepEqual(policy("There's an issue with the selected model. 500.", attempt, { status: 404, terminalReason: "api_error", category: "model_not_found" }),
      { automatic: false, detail: `The model provider cannot find the selected model, or this account cannot use it. ${RETRY_DELIVERY}` });
    assert.deepEqual(policy("Request too large (max 32MB). 429 rate limit.", attempt, { status: 413, terminalReason: "image_error", category: "invalid_request" }),
      { automatic: false, settle: true, detail: "Request too large (max 32MB). 429 rate limit. Sending it again unchanged cannot help, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it." });
    // A request that does not fit the model's context is the owner's to clear. The follow-up shows Claude's own
    // text, which says what takes the room, and says what the action that can clear it costs.
    for (const tooLong of [{ status: 400, terminalReason: "prompt_too_long", category: "invalid_request" }, { status: null, terminalReason: "blocking_limit", category: "invalid_request" },
      { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true as const }]) {
      assert.deepEqual(policy("Prompt is too long. 429 rate limit.", attempt, tooLong), { automatic: false, detail: `Prompt is too long. 429 rate limit. ${DOES_NOT_FIT}` });
    }
    // A 400 that Claude names `invalid_request` and that is no such request is settled with Claude's own text, in the
    // stream and in the session alike. It is never called a conversation that is too long.
    for (const terminalReason of ["api_error", null]) {
      for (const text of ["API Error: 400 due to tool use concurrency issues.", "PDF too large (max 100 pages, 20MB). Try reading the file a different way (e.g., extract text with pdftotext).",
        "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.",
        "Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.",
        "Your ANTHROPIC_API_KEY belongs to a disabled organization \u00b7 Update or unset the environment variable"]) {
        assert.deepEqual(policy(text, attempt, { status: 400, terminalReason, category: "invalid_request" }), { automatic: false, settle: true,
          detail: `${text} Sending it again unchanged cannot help, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` }, text);
      }
      // A key or an access that the owner can put right blocks, and Retry delivery then continues the task. It is not settled.
      for (const [status, text] of [[403, "Your organization has disabled API key authentication \u00b7 Unset ANTHROPIC_API_KEY and run /login to sign in with your claude.ai account"],
        [401, "Your apiKeyHelper script is failing \u00b7 This usually means you need to re-authenticate with your provider \u00b7 Run /status to see the script's error output"]] as const) {
        assert.deepEqual(policy(text, attempt, { status, terminalReason, category: "invalid_request" }),
          { automatic: false, detail: `The model provider needs authentication or account access. ${RETRY_DELIVERY}` }, text);
      }
    }
    // A bare 400 is not settled on its status: its text is read. A low credit balance is a 400.
    for (const facts of [{ status: 400, terminalReason: "api_error", category: null }, { status: 400, terminalReason: null, category: null }]) {
      assert.deepEqual(policy("Credit balance is too low", attempt, facts), { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` });
      // With no words that say more, it is blocked for the owner as any unknown failure is. It is not settled.
      assert.deepEqual(policy("API Error: 400 messages.0.content: this request is invalid", attempt, facts), { automatic: false,
        detail: attempt > 3 ? STOPPED_AFTER_THREE : `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}` });
    }
  }
  assert.deepEqual(policy("", 1, { status: 400, terminalReason: "prompt_too_long", category: "invalid_request" }),
    { automatic: false, detail: `Claude reported that the prompt is too long. ${DOES_NOT_FIT}` }, "with no text of Claude's to show");
  // The output limit takes the path every provider's output limit takes: one follow-up that says why, then no more.
  const outputLimit = { status: null, terminalReason: "api_error", category: "max_output_tokens" };
  assert.deepEqual(policy("API Error: Claude's response exceeded the 64000 output token maximum.", 1, outputLimit), taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1));
  assert.deepEqual(policy("API Error: Claude's response exceeded the 64000 output token maximum.", 2, outputLimit), taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 2));
  assert.equal(taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1).automatic, true);
  assert.equal(taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 2).settle, true);
  // A refusal, and a result of a shape nobody knows, are decided before any account is read.
  assert.deepEqual(taskFailurePolicy("refused", 1, true, false, shortFault), taskFailurePolicy("refused", 1, true));
  assert.deepEqual(taskFailurePolicy("words", 1, false, true, shortFault), taskFailurePolicy("words", 1, false, true));
});

test("the account's usage limit is never retried as a short fault: a rejected usage window, or the text that names the limit, decides first", async () => {
  const quota = { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` };
  const temporary = temporaryAt(1);
  const rateLimit = { status: 429, terminalReason: "api_error", category: "rate_limit" };
  // A brief rate limit, as Claude Code 2.1.278 words it with an API key: retried, as before.
  const brief = "API Error: Request rejected (429) · This request would exceed your organization's rate limit.";
  assert.deepEqual(taskFailurePolicy(brief, 1, false, false, rateLimit), temporary);
  // Claude reported the usage window that rejected the turn: whatever the text says, it is the account's limit.
  for (const attempt of [1, 2, 4]) assert.deepEqual(taskFailurePolicy(brief, attempt, false, false, { ...rateLimit, usageLimit: true }), quota, `attempt ${attempt}`);
  // The window wins for any failure with the status of a rate limit, whatever its name.
  for (const category of [null, "unknown"]) {
    assert.deepEqual(taskFailurePolicy(brief, 1, false, false, { status: 429, terminalReason: null, category, usageLimit: true }), quota, `a 429 named ${category}`);
  }
  // No window was reported: a turn that is read back from its session has none. The text that names the limit
  // decides, for a failure Claude names a rate limit and for one that has only the status of one.
  const bare429 = { status: 429, terminalReason: null, category: null };
  const unknown = { automatic: false, detail: `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}` };
  /** A failure of Claude Code that has no account at all, as from a CLI that sends none of the fields. */
  const claudeWithNoAccount = (text: string, attempt = 1) => taskFailurePolicy(text, attempt, false, false, null, true);
  /** The same text from any other provider. */
  const anotherProvider = (text: string, attempt = 1) => taskFailurePolicy(text, attempt, false, false, null, false);
  // Words that name a usage, spend or credit limit are a limit of the account for every provider, as before.
  for (const text of ["Claude AI usage limit reached", "You've hit your monthly spend limit", "You've hit your org's monthly spend limit", "Your group's usage limit is set to $0",
    "quota exceeded for this account"]) {
    for (const policy of [taskFailurePolicy(text, 1), anotherProvider(text), claudeWithNoAccount(text), taskFailurePolicy(text, 1, false, false, rateLimit),
      taskFailurePolicy(text, 1, false, false, bare429)]) assert.deepEqual(policy, quota, text);
  }
  // The words Claude Code 2.1.278 has for its own limits name no "usage limit". They are read for a Claude
  // failure alone. From another provider the same words are read as they always were: here, as a failure that
  // nothing is known about.
  const claudeLimits = ["You've hit your session limit \u00b7 resets 3pm", "You've hit your weekly limit \u00b7 resets Oct 12, 9am", "You've hit your Opus limit \u00b7 resets Oct 12, 9am",
    "You're out of extra usage \u00b7 resets 5pm", "You've hit your Sonnet limit", "You've hit your limit \u00b7 resets 3pm \u00b7 progress saved",
    "You've hit your team's shared budget \u00b7 ask your admin to raise it at claude.ai/admin-settings/usage",
    "You've reached your Fable limit. Switch to another model to continue.", "You\u2019ve hit your session limit", "You're out of usage credits \u00b7 resets 3pm",
    "Your org is out of usage \u00b7 contact your admin", "Your seat type doesn't include usage credits", "Your seat type doesn't include extra usage",
    "Your usage allocation has been disabled by your admin", "Fable 5 requires usage credits", "This service is disabled for your org", "Credit balance is too low"];
  for (const text of claudeLimits) {
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, rateLimit), quota, text);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, { ...rateLimit, terminalReason: null }), quota, `${text} (read back from a session)`);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, bare429), quota, `${text} (a 429 with no name)`);
    assert.deepEqual(claudeWithNoAccount(text), quota, `${text} (Claude, no account)`);
    assert.deepEqual(anotherProvider(text), unknown, `${text} (another provider)`);
    assert.deepEqual(taskFailurePolicy(text, 1), unknown, `${text} (no provider said)`);
  }
  // A brief rate limit stays a short fault, in each of the wordings Claude Code has for one. For a subscription
  // login it says "(not your usage limit)": those words name no usage limit.
  const notUsageLimit = ["API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 this may be a temporary capacity issue.",
    "API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 Rate limited"];
  const briefLimits = [brief, ...notUsageLimit, "You've hit your organization's rate limit, try again in 20 seconds", "You've hit your rate limit.", "You've hit your rate-limit."];
  for (const text of briefLimits) {
    for (const attempt of [1, 2, 3]) {
      assert.deepEqual(taskFailurePolicy(text, attempt, false, false, rateLimit), temporaryAt(attempt), text);
      assert.deepEqual(taskFailurePolicy(text, attempt, false, false, bare429), temporaryAt(attempt), `${text} (a 429 with no name)`);
      assert.deepEqual(claudeWithNoAccount(text, attempt), temporaryAt(attempt), `${text} (Claude, no account)`);
      // From another provider those words are not excused: "usage limit" is read in them, as before.
      assert.deepEqual(anotherProvider(text, attempt), notUsageLimit.includes(text) ? quota : temporaryAt(attempt), `${text} (another provider)`);
    }
  }
  // Claude Code writes a limit of the account as the whole text, and knows it by its start. The same words inside
  // a longer text are a server's own: a gateway can say "You've hit your concurrency limit", and the CLI puts
  // that after "API Error: ...". That is a brief limit, with a follow-up, whatever account the failure has.
  for (const text of ["API Error: Request rejected (429) \u00b7 You've hit your concurrency limit", "API Error: Request rejected (429) \u00b7 You've reached your requests per minute limit",
    "API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 You've hit your session limit", "API Error: 429 You're out of extra usage",
    "API Error: Request rejected (429) \u00b7 Fable 5 requires usage credits", "Request rejected (429): Credit balance is too low"]) {
    for (const policy of [taskFailurePolicy(text, 1, false, false, rateLimit), taskFailurePolicy(text, 1, false, false, { ...rateLimit, terminalReason: null }),
      taskFailurePolicy(text, 1, false, false, bare429), claudeWithNoAccount(text)]) assert.deepEqual(policy, temporary, text);
  }
  // At the start they are Claude Code's own, with or without space before them.
  for (const text of ["You've hit your concurrency limit", "  You've hit your session limit \u00b7 resets 3pm", "Opus 4.5 requires usage credits. Switch to another model to continue."]) {
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, rateLimit), quota, text);
    assert.deepEqual(claudeWithNoAccount(text), quota, text);
  }
  // Four texts that another provider can write. They get what they got before Claude's words were read. The first
  // three have Claude's words in the middle, so Claude Code gets the same for them. The last has the words that
  // Claude Code excuses.
  const elsewhere: Array<[text: string, anotherProviders: ReturnType<typeof taskFailurePolicy>, claudes: ReturnType<typeof taskFailurePolicy>]> = [
    ["429 Too Many Requests: you've hit your concurrency limit", temporary, temporary],
    ["429 You've reached your requests per minute limit", temporary, temporary],
    ["stream error: You've hit your context window limit", unknown, unknown],
    ["temporarily overloaded (not your usage limit)", quota, temporary],
  ];
  for (const [text, anotherProviders, claudes] of elsewhere) {
    assert.deepEqual(anotherProvider(text), anotherProviders, `${text} (another provider)`);
    assert.deepEqual(taskFailurePolicy(text, 1), anotherProviders, `${text} (no provider said)`);
    assert.deepEqual(claudeWithNoAccount(text), claudes, `${text} (Claude)`);
    // The delivery says which provider failed: Claude Code with no account of the failure, and three others.
    for (const providerId of ["claude-code", "codex", "cursor", "open-model"]) {
      const expected = providerId === "claude-code" ? claudes : anotherProviders;
      const { receipts, sources } = await runFailingLeaseHolder(providerId, [{ error: text }], [["1"], []]);
      assert.deepEqual(sources, expected.automatic ? ["1", "continuation"] : ["1"], `${providerId}: ${text}`);
      if (!expected.automatic) assert.equal(receipts[1]!.last_error, expected.detail, `${providerId}: ${text}`);
    }
  }
  // Those words excuse nothing else in the text: a usage limit named beside them is still one.
  assert.deepEqual(taskFailurePolicy("Server is temporarily limiting requests (not your usage limit). Your usage limit resets at 3pm.", 1, false, false, rateLimit), quota);
  // The limit text is read for a rate limit, and for no other short fault.
  assert.deepEqual(taskFailurePolicy("500 while the usage limit page loaded", 1, false, false, { status: 500, terminalReason: "api_error", category: "server_error" }), temporary);
  assert.deepEqual(taskFailurePolicy("You've hit your session limit", 1, false, false, { status: null, terminalReason: "api_error", category: "server_error" }), temporary);

  // A lease holder at its usage limit is sent no follow-up turn. The follow-up waits for the owner, and so does the next message.
  for (const failure of [{ error: brief, claudeApiFailure: { ...rateLimit, usageLimit: true as const } }, { error: "Claude AI usage limit reached", claudeApiFailure: rateLimit },
    { error: "Claude AI usage limit reached", claudeApiFailure: bare429 }, { error: "You've hit your session limit \u00b7 resets 3pm", claudeApiFailure: { ...rateLimit, terminalReason: null } },
    { error: "You've hit your weekly limit \u00b7 resets Oct 12, 9am", claudeApiFailure: rateLimit }, { error: "You've hit your Opus limit \u00b7 resets Oct 12, 9am", claudeApiFailure: rateLimit },
    { error: "You're out of extra usage \u00b7 resets 5pm", claudeApiFailure: rateLimit }]) {
    const { receipts, sources, waits } = await runFailingLeaseHolder("claude-code", [failure, failure, failure], [["1"], ["2"]]);
    assert.deepEqual(sources, ["1"], failure.error);
    assert.deepEqual(waits, [], failure.error);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], failure.error);
    assert.equal(receipts[1]!.last_error, quota.detail, failure.error);
  }
  // A lease holder at a brief rate limit of a subscription login gets its follow-up turn, and is not told that it has no credit.
  const notUsage = { error: notUsageLimit[0]!, claudeApiFailure: rateLimit };
  const retried = await runFailingLeaseHolder("claude-code", [notUsage], [["1"], []]);
  assert.deepEqual(retried.sources, ["1", "continuation"]);
  assert.deepEqual(retried.waits, [SHORT_FAULT_WAITS[0]]);
  assert.deepEqual(retried.receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
});

test("a refused credential that Claude names `invalid_request` blocks the follow-up for the owner, and Retry delivery then continues the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-claude-key-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const sources: string[] = [];
  let keyIsRight = false;
  const disabled = { error: "Your organization has disabled API key authentication \u00b7 Unset ANTHROPIC_API_KEY and run /login to sign in with your claude.ai account",
    claudeApiFailure: { status: 403, terminalReason: "api_error", category: "invalid_request" } };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    return keyIsRight ? { turnId, outcome: "no_reply", text: null }
      : { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...disabled };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] }, currentAuthority, 0, async () => {});
  const claude = { ...agent, provider: "claude-code" };
  try {
    await ingest(store, "1");
    await delivery.pump(claude);
    const blocked = await store.receipts(agent.agentId);
    assert.deepEqual(blocked.map((item) => item.state), ["acknowledged_failed", "blocked"], "nothing is settled with 'sending it again cannot help'");
    assert.equal(blocked[0]!.last_error, disabled.error);
    assert.equal(blocked[1]!.last_error, `The model provider needs authentication or account access. ${RETRY_DELIVERY}`);
    assert.deepEqual(sources, ["1"]);

    // The owner puts the key right and uses Retry delivery: the follow-up turn runs, in the same conversation.
    keyIsRight = true;
    await delivery.retry(claude, blocked[1]!.source_message_id);
    await waitForAsync(async () => (await store.receipts(agent.agentId))[1]?.state === "acknowledged_no_reply");
    assert.deepEqual(sources, ["1", "continuation"]);
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const [ending, claudeApiFailure] of Object.entries({
  "the provider refused it": { status: 400, terminalReason: "prompt_too_long", category: "invalid_request", promptTooLong: true },
  "Claude Code did not send it": { status: null, terminalReason: "blocking_limit", category: "invalid_request", promptTooLong: true },
  "its error was read back from the session": { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true },
} as const)) test(`a request that does not fit the model's context (${ending}) blocks its follow-up for the owner; after a new conversation, Retry delivery ends that follow-up without a turn`, async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-claude-too-long-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const sources: string[] = [];
  const tooLong = { error: "Prompt is too long · the request is ~250000 tokens (limit 200000)", claudeApiFailure };
  const delivery = new SupervisedAgentDelivery(store, provider(async (handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(`${source.source === "system" ? "continuation" : source.id} in ${handle.providerContinuationId}`);
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    // Every turn in the old conversation fails the same way. A new conversation answers.
    return handle.providerContinuationId === "thread"
      ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...tooLong }
      : { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] }, currentAuthority, 0, async () => {});
  const claude = { ...agent, provider: "claude-code" };
  try {
    await ingest(store, "1");
    await delivery.pump(claude);
    await ingest(store, "2");
    await delivery.pump(claude);
    const blocked = await store.receipts(agent.agentId);
    assert.deepEqual(blocked.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], "the next message waits behind the follow-up");
    assert.equal(blocked[1]!.last_error, `${tooLong.error} ${DOES_NOT_FIT}`, "the owner reads Claude's own text, and what a new conversation costs");
    assert.deepEqual(sources, ["1 in thread"], "no follow-up turn is sent into the conversation that is too long");

    // The owner uses Start fresh: the agent has a new conversation. The follow-up belongs to the old one.
    const fresh = { ...claude, providerContinuationId: "thread-2", handle: { ...claude.handle, providerContinuationId: "thread-2" } };
    await delivery.retry(fresh, blocked[1]!.source_message_id);
    await waitForAsync(async () => (await store.receipts(agent.agentId))[2]?.state === "acknowledged_no_reply");
    const released = await store.receipts(agent.agentId);
    assert.deepEqual(released.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"]);
    assert.equal(released[1]!.last_error, "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.",
      "the task is not continued by itself in the new conversation");
    assert.deepEqual(sources, ["1 in thread", "2 in thread-2"], "the next message runs in the new conversation, and the follow-up runs nowhere");
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a failure with no structured account is decided on its text, exactly as before", async () => {
  const temporary = temporaryAt(1);
  const authentication = { automatic: false, detail: `The model provider needs authentication or account access. ${RETRY_DELIVERY}` };
  const quota = { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` };
  const unknown = { automatic: false, detail: `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}` };
  const today: Array<[text: string, policy: ReturnType<typeof taskFailurePolicy>]> = [
    ["HTTP 503 Service Unavailable", temporary],
    ["unexpected status 401 Unauthorized: the provider rejected this key.", authentication],
    ["The account has insufficient credit for this request.", quota],
    ["Something went wrong.", unknown],
  ];
  for (const [text, policy] of today) {
    assert.deepEqual(taskFailurePolicy(text, 1), policy, text);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, null), policy, text);
    // An account that says nothing that decides, such as Claude's `unknown` with no status, changes nothing.
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, { status: null, terminalReason: "api_error", category: "unknown" }), policy, text);
    // A Claude turn that failed in another way than an API error carries no account. Another provider's turn never has one.
    for (const providerId of ["claude-code", "codex", "open-model"]) {
      const { receipts, sources } = await runFailingLeaseHolder(providerId, [{ error: text }], [["1"], ["2"]]);
      assert.deepEqual(sources, policy.automatic ? ["1", "continuation", "2"] : ["1"], `${providerId}: ${text}`);
      assert.deepEqual(receipts.map((item) => item.state), policy.automatic
        ? ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"] : ["acknowledged_failed", "blocked", "pending"], `${providerId}: ${text}`);
      if (!policy.automatic) assert.equal(receipts[1]!.last_error, policy.detail, `${providerId}: ${text}`);
    }
  }

  // What a provider that is not Claude Code got for each of these texts before Claude's fields and words were
  // read, written out from a run of that function. It gets the same now, whatever Claude Code would make of them.
  const before: Array<[text: string, policy: ReturnType<typeof taskFailurePolicy>]> = [
    // Limits, credit and quota.
    ["429 Too Many Requests: you've hit your concurrency limit", temporary], ["429 You've reached your requests per minute limit", temporary],
    ["stream error: You've hit your context window limit", unknown], ["temporarily overloaded (not your usage limit)", quota],
    ["You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", quota], ["You've hit your session limit \u00b7 resets 3pm", unknown], ["You've hit your weekly limit", unknown],
    ["You're out of extra usage \u00b7 resets 5pm", unknown], ["You've hit your rate limit.", temporary], ["You've hit your rate-limit, slow down", temporary],
    ["Rate limit reached for gpt-5 in organization org-x on requests per min. Limit: 500 / min.", temporary],
    ["You exceeded your current quota, please check your plan and billing details.", unknown], ["insufficient_quota", quota], ["Insufficient credits. Add more using the billing page.", quota],
    ["402 Payment Required", quota], ["Credit balance is too low", unknown], ["Your account has exhausted its output budget", quota], ["spend limit reached for this month", quota],
    ["quota_exceeded", quota], ["This service is disabled for your org", unknown], ["Your org is out of usage \u00b7 contact your admin", unknown],
    // A status in the text.
    ["HTTP 400 Bad Request: invalid_request_error", unknown], ["400 messages.0.content: this request is invalid", unknown], ["401 Unauthorized", authentication],
    ["HTTP 403 Forbidden: access denied for this key", authentication], ["404 model not found", unknown], ["413 Request Entity Too Large", unknown], ["429 Too Many Requests", temporary],
    ["500 Internal Server Error", temporary], ["502 Bad Gateway", temporary], ["503 Service Unavailable", temporary], ["504 Gateway Timeout", temporary], ["529 Overloaded", temporary],
    // The context, a key, a connection.
    ["Prompt is too long", unknown], ["prompt is too long: 250000 tokens > 200000 maximum", unknown], ["context_length_exceeded: This model's maximum context length is 128000 tokens", unknown],
    ["Request too large (max 32MB).", unknown], ["Invalid API key", authentication], ["Sign in required to continue", authentication], ["authentication failed for provider", authentication],
    ["OAuth token expired", unknown], ["Connection refused", unknown], ["connection reset by peer", temporary], ["ECONNRESET", temporary], ["ETIMEDOUT", temporary],
    ["socket closed unexpectedly", temporary], ["network error", temporary], ["Service temporarily unavailable", temporary], ["The model is overloaded. Please try again later.", temporary],
    ["Cursor Agent exited with code 1", unknown], ["Codex turn failed: stream disconnected before completion", unknown], ["unknown error", unknown], ["", unknown],
  ];
  const stopped = { automatic: false, detail: STOPPED_AFTER_THREE };
  for (const [text, policy] of before) {
    assert.deepEqual(taskFailurePolicy(text, 1), policy, text);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, null, false), policy, text);
    // After three follow-ups a text that is retried, or that nothing is known about, stops. The others say the same again.
    assert.deepEqual(taskFailurePolicy(text, 4, false, false, null, false), policy === temporary || policy === unknown ? stopped : policy, `${text} (attempt 4)`);
  }
  // The delivery says which provider failed. A few of these, run for each provider that is not Claude Code.
  for (const [text, policy] of [before[0]!, before[3]!, before[5]!, before[15]!]) {
    for (const providerId of ["codex", "cursor", "open-model"]) {
      const { receipts, sources } = await runFailingLeaseHolder(providerId, [{ error: text }], [["1"], []]);
      assert.deepEqual(sources, policy.automatic ? ["1", "continuation"] : ["1"], `${providerId}: ${text}`);
      if (!policy.automatic) assert.equal(receipts[1]!.last_error, policy.detail, `${providerId}: ${text}`);
    }
  }
});

test("Claude's account decides for a Claude failure only: the same failure from another provider is decided on its text", async () => {
  // A connection that was refused. The text reads like no temporary fault; Claude's fields say that it is one.
  const refused = { error: "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
    claudeApiFailure: { status: null, terminalReason: "api_error", category: "server_error" } };
  const claude = await runFailingLeaseHolder("claude-code", [refused], [["1"], ["2"]]);
  assert.deepEqual(claude.sources, ["1", "continuation", "2"], "Claude: a follow-up turn, then the next message");
  assert.deepEqual(claude.waits, [SHORT_FAULT_WAITS[0]], "the follow-up waits thirty seconds");
  assert.deepEqual(claude.receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"]);
  assert.equal(claude.receipts[0]!.last_error, refused.error, "the failed message keeps the provider's own text");

  for (const providerId of ["codex", "open-model", "cursor"]) {
    const other = await runFailingLeaseHolder(providerId, [refused], [["1"], ["2"]]);
    assert.deepEqual(other.sources, ["1"], providerId);
    assert.deepEqual(other.receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], providerId);
    assert.equal(other.receipts[1]!.last_error, `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}`, providerId);
  }
});

test("a short fault that does not end gets three follow-up turns, after thirty seconds, two minutes and ten minutes, and then waits for the owner", async () => {
  const refused = { error: "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
    claudeApiFailure: { status: null, terminalReason: "api_error", category: "server_error" } };
  const { receipts, sources, waits } = await runFailingLeaseHolder("claude-code", Array.from({ length: 8 }, () => refused), [["1"], ["2"]]);
  assert.deepEqual(sources, ["1", "continuation", "continuation", "continuation"], "the message's own turn and three follow-ups: four turns, and no more");
  assert.deepEqual(waits, [30_000, 120_000, 600_000]);
  assert.deepEqual(receipts.map((item) => item.state),
    ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "blocked", "pending"],
    "the fourth failure queues a follow-up that waits for the owner, and the next message waits behind it");
  assert.equal(receipts[4]!.last_error, STOPPED_AFTER_THREE);
  for (const failed of receipts.slice(0, 4)) assert.equal(failed.last_error, refused.error, "each failed turn keeps the provider's own text");
});

test("the waits of a follow-up: thirty seconds, two minutes and ten minutes after a short fault of any provider, and ten, twenty and forty seconds otherwise", async () => {
  assert.deepEqual([...SHORT_FAULT_FOLLOW_UP_DELAYS_MS], [30_000, 120_000, 600_000]);
  assert.equal(MAX_AUTOMATIC_FOLLOW_UPS, 3);
  assert.deepEqual([1, 2, 3].map(defaultFollowUpDelayMs), [10_000, 20_000, 40_000]);
  // A short fault is the same thing whoever reports it: with Claude's account of it, and by its text for any provider.
  for (const attempt of [1, 2, 3]) {
    assert.equal(taskFailurePolicy("Overloaded", attempt, false, false, { status: 529, terminalReason: "api_error", category: "server_error" }).delayMs, SHORT_FAULT_WAITS[attempt - 1]);
    assert.equal(taskFailurePolicy("HTTP 503 Service Unavailable", attempt).delayMs, SHORT_FAULT_WAITS[attempt - 1]);
  }
  // A turn that ended without a reply gets one follow-up, and has no schedule of its own: it waits ten seconds.
  assert.deepEqual([taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1).automatic, taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1).delayMs], [true, undefined]);
  const noReply = await runNoReplyContinuity([NO_REPLY_FAILURE.emptyAnswer], [["1"], []]);
  assert.deepEqual(noReply.sources, ["1", "continuation"]);
  // No decision that stops has a wait.
  for (const stopped of [taskFailurePolicy("HTTP 503", 4), taskFailurePolicy("HTTP 401 unauthorized", 1), taskFailurePolicy("Something went wrong.", 1)]) {
    assert.deepEqual([stopped.automatic, stopped.delayMs], [false, undefined]);
  }

  // Through the delivery, for a provider that is not Claude Code: three follow-ups at those times, and then the owner.
  for (const providerId of ["codex", "cursor", "open-model"]) {
    const fault = { error: "stream error: 503 Service Unavailable" };
    const { receipts, sources, waits } = await runFailingLeaseHolder(providerId, Array.from({ length: 8 }, () => fault), [["1"], ["2"]]);
    assert.deepEqual(sources, ["1", "continuation", "continuation", "continuation"], providerId);
    assert.deepEqual(waits, [30_000, 120_000, 600_000], providerId);
    assert.deepEqual(receipts.map((item) => item.state),
      ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "blocked", "pending"], providerId);
    assert.equal(receipts[4]!.last_error, STOPPED_AFTER_THREE, providerId);
  }
});
