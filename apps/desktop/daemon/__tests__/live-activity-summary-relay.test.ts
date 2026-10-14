import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS,
  LiveActivitySummaryRelay,
  liveActivitySummaryForEvent,
} from "../live-activity-summary-relay.js";
import { redactCredentialText, sanitizeDaemonActivityEvent } from "../credential-redaction.js";
import { NativeActivityPublicationCoordinator } from "../native-activity-publication-coordinator.js";

function clock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
  return {
    nowMs: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { (timer as unknown as { cleared: boolean }).cleared = true; },
    pending: () => timers.filter(timer => !timer.cleared).length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter(timer => !timer.cleared && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.cleared = true;
        next.callback();
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
      }
      now = end;
    },
  };
}

function relayWithLog(status: "working" | "idle" | null = "working") {
  const time = clock();
  const sent: Array<string | null> = [];
  const relay: LiveActivitySummaryRelay = new LiveActivitySummaryRelay({
    ...time,
    // As the publication coordinator does: a working publication carries take().
    publish: async (entryId, publishedStatus) => { sent.push(publishedStatus === "working" ? relay.take(entryId) : null); },
  });
  return { relay, time, sent, status: () => status };
}

const working = (kind: string, method: string, summary = "") => ({ kind, method, summary, status: "working" as const });

test("the line is the owner's live-strip line, with machine paths reduced to file names", () => {
  assert.equal(liveActivitySummaryForEvent(working("tool_lifecycle", "item/mcpToolCall/progress")), "Using a tool");
  assert.equal(liveActivitySummaryForEvent(working("text_delta", "item/agentMessage/delta")), "Writing a response");
  assert.equal(
    liveActivitySummaryForEvent(working("item_lifecycle", "item/reasoning/summaryTextDelta",
      "Checking /Users/emmy/Projects/secret-client/src/billing.ts for the bug")),
    "Checking `billing.ts` for the bug",
  );
  assert.equal(
    liveActivitySummaryForEvent(working("item_lifecycle", "item/reasoning/summaryTextDelta", "Fix C:\\Users\\emmy\\work\\app.ts\u202e\u0007 now")),
    "Fix `app.ts` now",
  );
  assert.equal(liveActivitySummaryForEvent({ ...working("tool_lifecycle", "x"), status: "idle" }), undefined, "an idle event keeps the last line");
  assert.equal(liveActivitySummaryForEvent(working("usage", "thread/tokenUsage/updated")), undefined, "usage is not room work");
  const long = liveActivitySummaryForEvent(working("item_lifecycle", "item/reasoning/summaryTextDelta", "word ".repeat(80)))!;
  assert.ok(long.length <= 120, "never longer than the server accepts");
});

const PSQL = "psql postgres://admin:hunter2@db.internal/prod -c select 1";

test("background work reaches the room as the kind of wait and its duration, never the command", () => {
  const event = (summary: string) => ({ kind: "provider_event", method: "letagents/backgroundWork", summary, status: "working" as const });
  const line = liveActivitySummaryForEvent(event(`Waiting up to 5 min for a background command: "${PSQL}".`));
  assert.equal(line, "Waiting for a background command (up to 5 min)");
  assert.equal(liveActivitySummaryForEvent(event('Waiting for sub-agents to finish (12 min): "Audit the Acme Corp invoices for Jane Doe".')),
    "Waiting for sub-agents to finish (12 min)");
  assert.equal(liveActivitySummaryForEvent(event("Waiting for Claude's answer about background work that ended 3 min ago.")),
    "Waiting for Claude's answer about background work that ended 3 min ago.");
  assert.equal(liveActivitySummaryForEvent(event(`run ${PSQL}`)), "Waiting for background work to finish");
  for (const candidate of [line]) assert.doesNotMatch(candidate ?? "", /hunter2|db\.internal|psql|admin/);
});

test("free text of any event kind without a fixed sentence stays with the owner", () => {
  assert.equal(liveActivitySummaryForEvent(working("plan_update", "turn/plan/updated",
    "1. Email Jane Doe at Acme Corp about invoice 4411\n2. Update the CRM")), "Working");
  assert.equal(liveActivitySummaryForEvent(working("notice", "custom/notice", PSQL)), "Working");
  assert.equal(liveActivitySummaryForEvent(working("provider_event", "letagents/providerRetry", `retry ${PSQL}`)), "Waiting for the model provider");
});

test("the reasoning summary reaches the room with credentials redacted and paths reduced", () => {
  const line = liveActivitySummaryForEvent(working("item_lifecycle", "item/reasoning/summaryTextDelta",
    `Checking whether ${PSQL} works against /Users/emmy/clients/acme/schema.sql`));
  // The path helper accepts spaces in folder names, so it also takes the words between two paths (a known limit).
  assert.equal(line, "Checking whether psql postgres://admin:[REDACTED]@db.internal`schema.sql`");
  assert.equal(liveActivitySummaryForEvent(working("item_lifecycle", "item/reasoning/summaryTextDelta",
    "Comparing the two migrations before the Bearer abcdefghijklmnop call")), "Comparing the two migrations before the Bearer [REDACTED] call");
  assert.doesNotMatch(line!, /hunter2/);
});

test("URL passwords of any scheme are redacted, for the owner's own view too", () => {
  assert.equal(redactCredentialText(PSQL).value, "psql postgres://admin:[REDACTED]@db.internal/prod -c select 1");
  assert.equal(redactCredentialText("redis://:pw@cache:6379").value, "redis://:[REDACTED]@cache:6379");
  assert.equal(redactCredentialText("mysql://root:x@localhost/db").value, "mysql://root:[REDACTED]@localhost/db");
  assert.equal(redactCredentialText("https://example.com/a:b@c").value, "https://example.com/a:b@c", "a path is not userinfo");
  const owner = sanitizeDaemonActivityEvent({ observed_at: "2026-10-15T00:00:00.000Z", sequence: 1, provider: "claude-code",
    kind: "provider_event", method: "letagents/backgroundWork", summary: `Waiting up to 5 min for a background command: "${PSQL}".`,
    status: "working", payload: { command: PSQL }, payload_truncated: false, payload_redacted: false, durable_payload_ref: null });
  assert.doesNotMatch(JSON.stringify(owner), /hunter2/);
  assert.equal(owner.payload_redacted, true);
});

test("a changed line is published at most once per interval, and only the newest waiting line is sent", async () => {
  const { relay, time, sent, status } = relayWithLog();
  relay.observe("agent", "Thinking", status);
  await time.advance(0);
  assert.deepEqual(sent, ["Thinking"], "the first line goes out at once");
  relay.observe("agent", "Using a tool", status);
  await time.advance(1_000);
  relay.observe("agent", "Writing a response", status);
  await time.advance(1_000);
  assert.deepEqual(sent, ["Thinking"], "nothing inside the interval");
  assert.equal(time.pending(), 1, "one waiting publication, not one per change");
  await time.advance(LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS);
  assert.deepEqual(sent, ["Thinking", "Writing a response"]);
  relay.observe("agent", "Writing a response", status);
  await time.advance(10_000);
  assert.equal(sent.length, 2, "an unchanged line is not published again");
});

test("every working heartbeat carries the newest line the interval allows, and one inside it does not double-publish", async () => {
  const { relay, time, sent, status } = relayWithLog();
  relay.observe("agent", "Thinking", status);
  await time.advance(0);
  relay.observe("agent", "Using a tool", status);
  assert.equal(relay.take("agent"), "Thinking", "a heartbeat inside the interval keeps the line the room has");
  await time.advance(LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS);
  assert.deepEqual(sent, ["Thinking", "Using a tool"]);
  relay.observe("agent", "Writing a response", status);
  await time.advance(LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS - 1);
  await time.advance(1);
  assert.equal(sent.at(-1), "Writing a response");
  assert.equal(relay.take("agent"), "Writing a response", "a heartbeat always repeats the newest line");
  // A change that could not go out at once (the runtime was between bindings)
  // reaches the room with the next heartbeat, and only once.
  await time.advance(LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS);
  const before = sent.length;
  relay.observe("agent", "Thinking", () => null);
  await time.advance(LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS);
  assert.equal(sent.length, before);
  assert.equal(relay.take("agent"), "Thinking");
  await time.advance(10 * LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS);
  assert.equal(sent.length, before);
});

test("the end of the turn clears the line, and an idle publication forgets it", async () => {
  const { relay, time, sent, status } = relayWithLog();
  relay.observe("agent", "Using a tool", status);
  await time.advance(0);
  relay.observe("agent", null, status);
  await time.advance(LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS);
  assert.deepEqual(sent, ["Using a tool", null]);
  relay.observe("agent", "Thinking", status);
  relay.reset("agent");
  assert.equal(relay.take("agent"), null);
  assert.equal(time.pending(), 0, "nothing waits after the agent is idle");
});

test("no publication while the runtime is not the bound working one", async () => {
  const { relay, time, sent } = relayWithLog();
  relay.observe("agent", "Thinking", () => null);
  await time.advance(10_000);
  assert.deepEqual(sent, []);
});

test("native activity carries activity_summary: the line while working, null when idle", async () => {
  const time = clock();
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  let sequence = 0;
  const binding = { api_url: "https://letagents.example", room_id: "room_1", agent_session_id: "session_1",
    work_attempt_id: "attempt", execution_generation_id: "gen" };
  const coordinator = new NativeActivityPublicationCoordinator({
    bindings: {
      get: async () => binding,
      credentialFor: async () => "bearer",
      publish: async (_entryId: string, observedMs: number, operation: (publication: { binding: typeof binding; sequence: number; observed_at: string }) => Promise<{ accepted: boolean }>) => {
        const observed_at = new Date(observedMs).toISOString();
        return { ...(await operation({ binding, sequence: ++sequence, observed_at })), sequence, observed_at };
      },
    } as never,
    updateEntry: async (_entryId, update) => update({} as never),
    startDelivery: async () => {},
  }, time);
  try {
    coordinator.observeActivitySummary("agent", "Reading /Users/emmy/Projects/x/src/app.ts", () => "working");
    await time.advance(0);
    await coordinator.publish("agent", "native_harness.heartbeat", "working");
    await coordinator.publish("agent", "native_harness.heartbeat", "idle");
    await coordinator.publish("agent", "native_harness.heartbeat", "working");
    assert.deepEqual(bodies.map(body => [body.method, body.status, body.activity_summary]), [
      ["native_harness.activity_summary", "working", "Reading `app.ts`"],
      ["native_harness.heartbeat", "working", "Reading `app.ts`"],
      ["native_harness.heartbeat", "idle", null],
      ["native_harness.heartbeat", "working", null],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
