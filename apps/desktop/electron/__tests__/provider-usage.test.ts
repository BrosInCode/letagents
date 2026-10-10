import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexAccountUsage, inspectorUsageSchema, ProviderUsageTracker, readCodexUsageTail } from "../main/agents/provider-usage.js";
const at = "2026-10-10T20:00:00.000Z";
const sample = { last: { totalTokens: 62000 }, total: { totalTokens: 4200000 }, modelContextWindow: 200000 };

test("Codex prefers actual metered buckets and preserves zero and missing values", () => {
  const limits = codexAccountUsage({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { limitName: "Codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791669600 }, secondary: { usedPercent: 80, windowDurationMins: 10080 } },
    extra: { limitName: "Other models", primary: { usedPercent: 95, windowDurationMins: 60 } },
    invalid: { primary: { usedPercent: null }, secondary: { usedPercent: "14" } },
  } }, at);
  assert.equal(limits.state, "available");
  assert.deepEqual(limits.windows.map(w => [w.usedPercent, w.label]), [[0, "Codex · 5 hours"], [80, "Codex · Weekly"], [95, "Other models · 1 hour"]]);
  assert.equal(limits.windows[1]?.resetsAt, null);
  assert.equal(codexAccountUsage({ rateLimits: { primary: { usedPercent: NaN } } }, at).state, "unavailable");
  assert.equal(codexAccountUsage({}, at).windows.length, 0);
});

test("Codex context uses the latest call, ignores another thread, and resets on compaction/replacement", () => {
  const tracker = new ProviderUsageTracker("thread");
  tracker.codex("thread/tokenUsage/updated", { threadId: "other", tokenUsage: sample }, at);
  assert.equal(tracker.snapshot("thread").context, null);
  tracker.codex("thread/tokenUsage/updated", { threadId: "thread", tokenUsage: sample }, at);
  assert.deepEqual(tracker.snapshot("thread").context, { usedTokens: 62000, capacityTokens: 200000, observedAt: at });
  tracker.codex("item/started", { threadId: "thread", item: { type: "contextCompaction" } }, at);
  assert.equal(tracker.snapshot("thread").compaction, "compacting");
  tracker.codex("item/completed", { threadId: "thread", item: { type: "contextCompaction" } }, at);
  assert.equal(tracker.snapshot("thread").context, null);
  tracker.seedContext({ usedTokens: 190000, capacityTokens: 200000, observedAt: at });
  assert.equal(tracker.snapshot("thread").context, null, "cannot resurrect pre-compaction counts");
  tracker.codex("thread/tokenUsage/updated", { threadId: "thread", tokenUsage: { ...sample, last: { totalTokens: 20000 } } }, at);
  assert.equal(tracker.snapshot("thread").context?.usedTokens, 20000);
  assert.equal(tracker.snapshot("replacement").context, null);
  assert.equal(tracker.snapshot("replacement").compaction, null);
});

test("Claude reports native quota windows and current main-agent context, excluding subagents and cumulative totals", () => {
  const tracker = new ProviderUsageTracker("session");
  const assistant = { type: "assistant", session_id: "session", parent_tool_use_id: null,
    message: { model: "opus", usage: { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 5000 } } };
  tracker.claude({ ...assistant, parent_tool_use_id: "child" }, at);
  assert.equal(tracker.snapshot("session").context, null);
  tracker.claude(assistant, at);
  tracker.claude({ type: "result", session_id: "session", usage: { input_tokens: 900000 }, modelUsage: {
    opus: { inputTokens: 1000000, contextWindow: 200000 }, haiku: { contextWindow: 1000000 },
  } }, at);
  assert.deepEqual(tracker.snapshot("session").context, { usedTokens: 26000, capacityTokens: 200000, observedAt: at });
  tracker.claude({ type: "rate_limit_event", session_id: "session", rate_limit_info: { rateLimitType: "five_hour", utilization: .7, resetsAt: 1791669600 } }, at);
  tracker.claude({ type: "rate_limit_event", session_id: "session", rate_limit_info: { rateLimitType: "seven_day", utilization: .95 } }, at);
  assert.deepEqual(tracker.snapshot("session").account.windows.map(w => w.usedPercent), [70, 95]);
  tracker.claude({ type: "system", subtype: "compact_boundary", session_id: "session" }, at);
  assert.equal(tracker.snapshot("session").context, null);
  assert.equal(tracker.snapshot("session").compaction, "compacted");
});

test("bounded Codex rollout bootstrap reads the latest context and stops at a compaction boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-tail-"));
  try {
    const path = join(dir, "session.jsonl");
    const row = JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { total_tokens: 62000 }, total_token_usage: { total_tokens: 999999 }, model_context_window: 200000,
    } } });
    await writeFile(path, `${'x'.repeat(600000)}\n${row}\n{partial`);
    assert.deepEqual(await readCodexUsageTail(path), { usedTokens: 62000, capacityTokens: 200000, observedAt: at });
    await writeFile(path, `${row}\n${JSON.stringify({ type: "compacted" })}\n`);
    assert.equal(await readCodexUsageTail(path), null);
    assert.equal(await readCodexUsageTail("relative.jsonl"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("IPC usage validation rejects invalid measurements and requires runtime identity", () => {
  const tracker = new ProviderUsageTracker("thread");
  const valid = { ...tracker.snapshot("thread"), executionGenerationId: "execution", daemonGeneration: 4 };
  assert.equal(inspectorUsageSchema.safeParse(valid).success, true);
  assert.equal(inspectorUsageSchema.safeParse({ ...valid, daemonGeneration: undefined }).success, false);
  assert.equal(inspectorUsageSchema.safeParse({ ...valid, context: { usedTokens: -2, capacityTokens: 0, observedAt: at } }).success, false);
});

test("new stream quota observations win over an older in-flight account read", () => {
  const tracker = new ProviderUsageTracker("thread");
  const before = tracker.accountRevision;
  tracker.codex("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 40 } } }, at);
  tracker.account({ rateLimits: { primary: { usedPercent: 20 } } }, at, before);
  tracker.accountFailed(before);
  assert.equal(tracker.snapshot("thread").account.windows[0]?.usedPercent, 40);
  assert.equal(tracker.snapshot("thread").account.state, "available");
  tracker.codex("account/rateLimits/updated", { rateLimits: { limitId: "other", primary: { usedPercent: 80 } } }, at);
  assert.deepEqual(tracker.snapshot("thread").account.windows.map(w => w.id), ["codex:primary", "other:primary"]);
});

for (const status of ["rejected", "allowed"]) test(`Claude status-only ${status} makes the previous percentage stale`, () => {
  const tracker = new ProviderUsageTracker("session");
  tracker.claude({ type: "rate_limit_event", session_id: "session", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: .8 } }, at);
  tracker.claude({ type: "rate_limit_event", session_id: "session", rate_limit_info: { status, rateLimitType: "five_hour", resetsAt: 1791669600 } }, at);
  assert.equal(tracker.snapshot("session").account.state, "stale");
  assert.equal(tracker.snapshot("session").account.windows[0]?.usedPercent, 80);
  assert.equal(tracker.snapshot("session").account.windows[0]?.resetsAt, new Date(1791669600 * 1000).toISOString());
});

test("Claude synthetic notices and API errors do not replace measured context with zero", () => {
  const tracker = new ProviderUsageTracker("session");
  tracker.claude({ type: "assistant", session_id: "session", message: { model: "opus", usage: { input_tokens: 12000 } } }, at);
  for (const extra of [{ message: { model: "<synthetic>", usage: { input_tokens: 0 } } },
    { error: "rate_limit", message: { model: "opus", usage: { input_tokens: 0 } } }]) {
    tracker.claude({ type: "assistant", session_id: "session", ...extra }, at);
    assert.equal(tracker.snapshot("session").context?.usedTokens, 12000);
  }
});
