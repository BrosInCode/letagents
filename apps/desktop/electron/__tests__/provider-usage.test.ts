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

test("Claude reads every window from unifiedWindows when the top level has no utilization", () => {
  const tracker = new ProviderUsageTracker("session");
  tracker.claude({ type: "rate_limit_event", session_id: "session", rate_limit_info: { status: "allowed", resetsAt: 1792272000, rateLimitType: "five_hour",
    overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: 1792272000 }, seven_day: { utilization: 0.43, resetsAt: 1792407600 } } } }, at);
  const account = tracker.snapshot("session").account;
  assert.equal(account.state, "available");
  assert.deepEqual(account.windows.map(w => [w.id, w.label, w.usedPercent, w.resetsAt]), [
    ["five_hour", "5 hours", 1, new Date(1792272000 * 1000).toISOString()],
    ["seven_day", "Weekly", 43, new Date(1792407600 * 1000).toISOString()],
  ]);
  tracker.claude({ type: "rate_limit_event", session_id: "session", rate_limit_info: { status: "allowed", rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization: 0.05 } } } }, at);
  assert.deepEqual(tracker.snapshot("session").account.windows.map(w => [w.id, w.usedPercent]), [["seven_day", 43], ["five_hour", 5]]);
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

test("Cursor uses reported plan percentages, native dollar caps and millisecond resets without inventing windows", async () => {
  const { cursorAccountUsage } = await import("../main/agents/cursor-usage.js");
  const period = { billingCycleEnd: "1793364839000", planUsage: { includedSpend: 2000, totalSpend: 9533, limit: 2000, totalPercentUsed: 20.175661375661374 }, spendLimitUsage: { individualUsed: 2500, limitType: "user" } };
  const account = cursorAccountUsage(period, { hardLimit: 100 }, at);
  assert.deepEqual(account.windows.map(w => w.usedPercent), [20.175661375661374, 25]);
  assert.equal(account.windows[0]?.resetsAt, new Date(1793364839000).toISOString());
  for (const hard of [{ noUsageBasedAllowed: true }, { hardLimit: 2147483647 }, { hardLimit: 0 }]) {
    assert.equal(cursorAccountUsage(period, hard, at).windows.length, 1);
  }
  assert.equal(cursorAccountUsage({}, null, at).state, "unavailable");
  assert.equal(cursorAccountUsage({ spendLimitUsage: { individualLimit: 5000 } }, {}, at).windows.length, 0);
  assert.equal(cursorAccountUsage({ spendLimitUsage: { individualLimit: 5000 } }, null, at).windows[0]?.usedPercent, 0);
  assert.equal(cursorAccountUsage({ planUsage: { totalPercentUsed: 0 } }, null, at).windows[0]?.usedPercent, 0);
  assert.equal(cursorAccountUsage({ planUsage: { includedSpend: 120, limit: 100 } }, null, at).windows[0]?.usedPercent, 100);
  assert.equal(cursorAccountUsage({ planUsage: { totalPercentUsed: "20", limit: -1 } }, null, at).state, "unavailable");
});

test("Cursor account transport is bounded and sends authorization only to its fixed native read endpoints", async () => {
  const { readCursorAccountUsage } = await import("../main/agents/cursor-usage.js");
  const urls: string[] = [];
  const request = (async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.redirect, "error"); assert.equal(options?.body, "{}");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test");
    return new Response(String(url).endsWith("GetHardLimit") ? '{"noUsageBasedAllowed":true}' : '{"planUsage":{"totalPercentUsed":20}}');
  }) as typeof fetch;
  assert.equal((await readCursorAccountUsage("Bearer test", at, request)).windows[0]?.usedPercent, 20);
  assert.deepEqual(urls.sort(), ["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit"]);
  await assert.rejects(readCursorAccountUsage("Bearer test", at, (async () => new Response('x'.repeat(1024 * 1024 + 1))) as typeof fetch));
  await assert.rejects(readCursorAccountUsage("Bearer test\nheader", at, request));
});

test("Cursor reads only exact session context from its native SQLite/protobuf state, including zero after compaction", async () => {
  const { readCursorContext, readCursorUsageOwner } = await import("../main/agents/cursor-usage.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  const { mkdir, symlink } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "cursor-usage-"));
  const workspace = "/tmp/cursor-usage-workspace", id = "36786173-8026-471a-b132-102fa5079aea", rootId = "a".repeat(64);
  const dir = join(root, "cursor", "chats", createHash("md5").update(workspace).digest("hex"), id);
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "store.db"));
  const varint = (n: number): number[] => { const bytes: number[] = []; do { const rest = Math.floor(n / 128); bytes.push(n % 128 | (rest ? 128 : 0)); n = rest; } while (n); return bytes; };
  const state = (used: number, cap: number) => {
    const details = [...(used ? [8, ...varint(used)] : []), 16, ...varint(cap)];
    return Buffer.from([42, ...varint(details.length), ...details, 50, 2, 1, 2]);
  };
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB);");
    const metadata = (agentId: string) => Buffer.from(JSON.stringify({ agentId, latestRootBlobId: rootId })).toString("hex");
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(metadata(id));
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(rootId, state(39386, 256000));
    const reading = readCursorContext(root, workspace, id);
    assert.equal(reading?.context?.usedTokens, 39386); assert.equal(reading?.context?.capacityTokens, 256000);
    assert.equal(reading?.summaryId, "0102");
    db.prepare("UPDATE blobs SET data=?").run(state(0, 256000));
    assert.equal(readCursorContext(root, workspace, id)?.context?.usedTokens, 0);
    db.prepare("UPDATE blobs SET data=?").run(Buffer.from([42, 255]));
    assert.equal(readCursorContext(root, workspace, id), null, "truncated protobuf fails closed");
    db.prepare("UPDATE blobs SET data=?").run(state(9000, 256000));
    db.prepare("UPDATE meta SET value=?").run(metadata("another-session"));
    assert.equal(readCursorContext(root, workspace, id), null);
    assert.equal(readCursorContext(root, workspace, "../escape"), null);
    assert.equal(readCursorContext(root, "/different-workspace", id), null);
    await writeFile(join(root, "letagents-cursor-identity.json"), '{"userId":12345}');
    assert.equal(readCursorUsageOwner(root), 12345);
    await symlink(root, join(root, "redirected"));
    assert.equal(readCursorContext(join(root, "redirected"), workspace, id), null);
    assert.equal(readCursorUsageOwner(join(root, "redirected")), null);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
