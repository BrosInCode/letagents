import assert from "node:assert/strict";
import test from "node:test";

import { AgentStreamRegistry } from "../agent-stream-registry.js";
import {
  LIVE_ROOM_SHARE_INTERVAL_MS,
  LiveRoomSharePublisher,
  buildRoomLiveSnapshot,
  roomSafeLine,
  roomSafeText,
  withoutMachinePaths,
  type LiveRoomShareTarget,
  type LiveSharingState,
} from "../live-room-share-publisher.js";
import type { DaemonActivityEvent } from "../types.js";
import { ROOM_LIVE_LIMITS, type RoomLiveSnapshot } from "../../../../shared/agent-live-trace.mjs";

const AGENT = "agent_ada";
const TARGET: LiveRoomShareTarget = { apiUrl: "https://letagents.test", roomId: "room_1", bearer: "worker-bearer" };

function clock() {
  let now = Date.parse("2026-10-18T10:00:00.000Z");
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
  return {
    nowMs: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, callback, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { (timer as unknown as { cleared: boolean }).cleared = true; },
    pending: () => timers.filter((timer) => !timer.cleared).length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await settle();
        const next = timers.filter((timer) => !timer.cleared && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.cleared = true;
        next.callback();
        await settle();
      }
      now = end;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function event(method: string, kind: string, payload: unknown): DaemonActivityEvent {
  return {
    observed_at: "2026-10-18T10:00:01.000Z", sequence: 1, provider: "codex", kind, method, summary: "",
    status: "working", payload, payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  } as DaemonActivityEvent;
}
const note = (partId: string, delta: string) => event("item/reasoning/summaryTextDelta", "item_lifecycle", { partId, delta });
const update = (partId: string, delta: string) => event("item/agentMessage/delta", "text_delta", { partId, delta });
const tool = (callID: string, toolName: string, status: string, extra: Record<string, unknown> = {}) =>
  event("item/toolCall/updated", "tool_lifecycle", { callID, tool: toolName, status, ...extra });

function harness(options: { sharing?: boolean | LiveSharingState; target?: LiveRoomShareTarget | null; failRead?: boolean } = {}) {
  const time = clock();
  const feed = new AgentStreamRegistry();
  const calls: Array<{ kind: "create" | "update" | "withdraw"; body?: { summary: string; live: RoomLiveSnapshot }; sessionId?: string }> = [];
  let sessionCount = 0;
  let target: LiveRoomShareTarget | null = options.target === undefined ? TARGET : options.target;
  const withdrawn: string[] = [];
  let reads = 0;
  const control = {
    createGate: null as null | Promise<void>,
    updateMissing: false,
    failCreate: false,
    unsupported: false,
  };
  const publisher = new LiveRoomSharePublisher({
    ...time,
    sharing: async () => {
      reads += 1;
      if (options.failRead && reads === 1) throw new Error("database busy");
      const saved = options.sharing ?? false;
      return typeof saved === "string" ? saved : saved ? "on" : "off";
    },
    withdrawn: async (entryId) => { withdrawn.push(entryId); },
    target: async () => target,
    feed: {
      highWater: (entryId) => feed.highWater(entryId),
      retainedAfter: (entryId, afterSequence) => feed.retainedAfter(entryId, afterSequence),
    },
    http: {
      create: async (_target, body) => {
        calls.push({ kind: "create", body });
        if (control.createGate) await control.createGate;
        if (control.failCreate) throw new Error("offline");
        if (control.unsupported) throw Object.assign(new Error("older server"), { unsupported: true });
        sessionCount += 1;
        return `rs_${sessionCount}`;
      },
      update: async (_target, sessionId, body) => {
        calls.push({ kind: "update", body, sessionId });
        return !control.updateMissing;
      },
      withdraw: async () => { calls.push({ kind: "withdraw" }); },
    },
  });
  const push = (...events: DaemonActivityEvent[]) => {
    for (const item of events) publisher.observe(AGENT, feed.push(AGENT, item));
  };
  return { time, feed, calls, publisher, push, control, withdrawn, reads: () => reads, setTarget: (value: LiveRoomShareTarget | null) => { target = value; } };
}

const sent = (calls: ReturnType<typeof harness>["calls"]) => calls.filter((call) => call.kind !== "withdraw");

test("while the owner does not share, the daemon sends the room nothing about the agent's work", async () => {
  const { time, calls, publisher, push } = harness({ sharing: false });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(note("r1", "Looking at the failing test."), tool("t1", "shellToolCall", "running", { input: { command: "npm test" } }));
  await time.advance(60_000);
  publisher.turnEnded(AGENT, "inbox_1");
  publisher.turnStarted(AGENT, "inbox_2", "msg_8");
  push(update("m1", "Done."));
  await time.advance(60_000);
  assert.deepEqual(calls, [], "no request of any kind leaves the machine for an agent that never shared");
  assert.equal(time.pending(), 0, "no timer keeps running for an agent that does not share");
  publisher.setSharing(AGENT, "off");
  await time.advance(60_000);
  assert.deepEqual(calls, [], "turning off an agent that never shared removes nothing");
});

test("a shared turn starts a live session with the request reference and batches later changes", async () => {
  const { time, calls, publisher, push } = harness({ sharing: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  await time.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, "create");
  assert.equal(calls[0]!.body!.live.request_message_id, "msg_7");
  assert.equal(calls[0]!.body!.live.state, "working");
  assert.deepEqual(calls[0]!.body!.live.entries, []);

  for (let index = 0; index < 20; index += 1) {
    push(tool(`t${index}`, "readToolCall", "completed", { input: { path: `/Users/owner/secret/file${index}.ts` }, output: "contents" }));
    await time.advance(100);
  }
  // Twenty events over two seconds wait for the interval and go out as one update.
  assert.equal(calls.length, 1);
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.kind, "update");
  assert.equal(calls[1]!.sessionId, "rs_1");
  assert.deepEqual(calls[1]!.body!.live.entries, [{ kind: "action", id: "e1", headline: "20 file reads", status: "completed", tool: "read", count: 20 }]);

  publisher.turnEnded(AGENT, "inbox_1");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  const last = calls.at(-1)!;
  assert.equal(last.body!.live.state, "ended");
  assert.equal(last.body!.summary, "Finished this request");
  assert.ok(last.body!.live.ended_at);

  publisher.turnStarted(AGENT, "inbox_2", "msg_9");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  const next = calls.at(-1)!;
  assert.equal(next.kind, "create", "a new turn starts a new session, which replaces the last one");
  assert.deepEqual(next.body!.live.entries, [], "the new turn starts empty");
});

test("only work notes, agent updates and fixed tool headlines are shared, all redacted", async () => {
  const { time, calls, publisher, push } = harness({ sharing: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(
    note("r1", "I will connect with postgres://admin:hunter2@db.internal:5432/app and check /Users/owner/clients/acme/billing.ts."),
    tool("t1", "shellToolCall", "completed", {
      input: { command: "curl https://deploy:s3cret@ci.example.com/run" },
      output: "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    }),
    tool("t2", "editToolCall", "error", { input: { changes: [{ path: "/Users/owner/clients/acme/billing.ts" }] }, error: "Permission denied: /Users/owner/clients/acme/billing.ts" }),
    tool("t3", "mcp__acme_crm__lookup_customer", "completed", { input: { email: "ceo@acme.com" }, output: { name: "Ceo" } }),
    tool("t4", "WebFetch", "running", { input: { url: "https://intranet.acme/secret" } }),
    tool("t5", "send_message", "completed", { input: { text: "private draft" } }),
    update("m1", "Fixed it. Token was `Bearer abcdefghijklmnop1234`."),
  );
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  const live = calls.at(-1)!.body!.live;
  const shared = JSON.stringify(live);
  for (const secret of ["hunter2", "s3cret", "ghp_", "ceo@acme.com", "intranet", "private draft", "Permission denied", "/Users/owner", "acme_crm", "lookup_customer", "abcdefghijklmnop1234", "curl", "npm"]) {
    assert.equal(shared.includes(secret), false, `${secret} must not be shared`);
  }
  assert.deepEqual(live.entries.map((entry) => entry.kind === "action" ? `${entry.tool}:${entry.status}:${entry.headline}` : `${entry.kind}`), [
    "note",
    "shell:completed:Ran a shell command",
    "edit:failed:File change failed",
    "other:completed:Used a tool",
    "web:running:Reading a web page",
    "room:completed:Sent a room message",
    "update",
  ]);
  const text = live.entries[0]!.kind === "note" ? live.entries[0]!.text : "";
  assert.match(text, /postgres:\/\/admin:\[REDACTED\]@db\.internal/);
  // A machine path becomes its file name (the same reduction as the room's one-line summary).
  assert.match(text, /billing\.ts/);
  assert.equal(calls.at(-1)!.body!.summary, "Reading a web page", "the running action is the current step");
});

test("turning sharing off stops what waits, removes what the room sees, and on again starts from the current turn", async () => {
  const { time, calls, publisher, push, withdrawn } = harness({ sharing: true });
  const harnessWithdrawn = () => withdrawn;
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(note("r1", "First note."));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  const published = calls.length;
  push(note("r2", "Second note, waiting for the interval."));
  publisher.setSharing(AGENT, "withdrawing");
  await time.advance(10 * LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.deepEqual(calls.slice(published).map((call) => call.kind), ["withdraw"], "the waiting change is never sent; the room's copy is removed");
  assert.deepEqual(harnessWithdrawn(), [AGENT], "the saved state stops asking for removal once the room confirms it");
  push(note("r3", "Third note while off."));
  await time.advance(10 * LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.equal(calls.length, published + 1);

  publisher.setSharing(AGENT, "on");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  const restarted = calls.at(-1)!;
  assert.equal(restarted.kind, "create", "a new session, since the old one was removed");
  // The whole current turn is shared again, the part from while it was off included.
  assert.deepEqual(restarted.body!.live.entries.map((entry) => entry.kind === "note" ? entry.text : ""),
    ["First note.", "Second note, waiting for the interval.", "Third note while off."]);
  assert.equal(restarted.body!.live.request_message_id, "msg_7", "the current turn is shared again");
});

test("a publication that finishes after the owner turned sharing off cannot cancel the removal", async () => {
  const { time, calls, publisher, control } = harness({ sharing: true });
  let release!: () => void;
  control.createGate = new Promise((resolve) => { release = resolve; });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  await time.advance(0);
  assert.deepEqual(calls.map((call) => call.kind), ["create"], "the create request is in flight");
  publisher.setSharing(AGENT, "withdrawing");
  release();
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.deepEqual(calls.map((call) => call.kind), ["create", "withdraw"], "the late session is removed as well");
});

test("an agent without a room binding retries with backoff, and a removed session is started again", async () => {
  const { time, calls, publisher, push, setTarget, control } = harness({ sharing: true, target: null });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  await time.advance(2 * LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.equal(calls.length, 0);
  setTarget(TARGET);
  await time.advance(60_000);
  assert.deepEqual(calls.map((call) => call.kind), ["create"]);
  control.updateMissing = true;
  push(note("r1", "A note."));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.deepEqual(calls.map((call) => call.kind), ["create", "update", "create"]);
});

test("an older room server is tried once per turn, never with every change", async () => {
  const { time, calls, publisher, push, control } = harness({ sharing: true });
  control.unsupported = true;
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  await time.advance(0);
  for (let index = 0; index < 5; index += 1) {
    push(note(`r${index}`, "A note."));
    await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  }
  await time.advance(120_000);
  assert.deepEqual(calls.map((call) => call.kind), ["create"]);
  publisher.turnEnded(AGENT, "inbox_1");
  publisher.turnStarted(AGENT, "inbox_2", "msg_8");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.deepEqual(calls.map((call) => call.kind), ["create", "create"], "the next turn tries again, in case the server was updated");
});

test("a text block whose beginning the feed dropped is never shared, so a cut secret cannot pass redaction", async () => {
  const { time, calls, publisher, push } = harness({ sharing: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(note("r1", "I will run psql "), note("r1", "postgres://admin:"), note("r1", "hunter2@db.internal/app"), note("r1", " to check."));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.match(JSON.stringify(calls.at(-1)!.body!.live), /admin:\[REDACTED\]@db/, "while whole, the note is shared redacted");
  // The feed keeps 400 events: these push the note's first deltas out of it.
  for (let index = 0; index < 398; index += 1) push(tool(`t${index}`, "shellToolCall", "completed"));
  push(note("r2", "A later note, still whole."));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  const live = calls.at(-1)!.body!.live;
  const shared = JSON.stringify(live);
  assert.equal(shared.includes("hunter2"), false, "the tail of a cut block never reaches the room");
  assert.equal(live.omitted_earlier, true);
  assert.deepEqual(live.entries.filter((entry) => entry.kind === "note").map((entry) => entry.kind === "note" ? entry.text : ""), ["A later note, still whole."]);
});

test("turning sharing on after a turn ended while it was off shares nothing of that turn", async () => {
  const { time, calls, publisher, push } = harness({ sharing: false });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(note("r1", "Private thoughts while not shared."));
  publisher.turnEnded(AGENT, "inbox_1");
  await time.advance(60_000);
  publisher.setSharing(AGENT, "on");
  await time.advance(60_000);
  assert.deepEqual(calls, []);
  publisher.turnStarted(AGENT, "inbox_2", "msg_8");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.deepEqual(calls.map((call) => call.kind), ["create"]);
  assert.equal(calls[0]!.body!.live.request_message_id, "msg_8", "sharing starts with the next request");
});

test("turning sharing off while an update is in flight starts no new session", async () => {
  const { time, calls, publisher, push, control } = harness({ sharing: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  await time.advance(0);
  control.updateMissing = true;
  push(note("r1", "A note."));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS - 1);
  publisher.setSharing(AGENT, "withdrawing");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS * 4);
  // The update was already queued when the owner turned sharing off; it may go out, but nothing after it.
  assert.equal(calls.filter((call) => call.kind === "create").length, 1);
  assert.equal(calls.at(-1)!.kind, "withdraw");
});

test("a removal the room never confirmed is retried by the next daemon process", async () => {
  const { time, calls, publisher, withdrawn } = harness({ sharing: "withdrawing" });
  publisher.resume(new Map([[AGENT, "withdrawing"], ["agent_bo", "off"], ["agent_cy", "on"]]));
  await time.advance(0);
  assert.deepEqual(calls.map((call) => call.kind), ["withdraw"], "only the agent with a pending removal is touched");
  assert.deepEqual(withdrawn, [AGENT]);
});

test("a removal the owner asked for keeps being retried while the room may still show the agent's work", async () => {
  const { time, calls, publisher, push, setTarget, withdrawn } = harness({ sharing: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(note("r1", "A shared note."));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  // The owner's computer goes offline, then the owner turns sharing off.
  setTarget(null);
  publisher.setSharing(AGENT, "withdrawing");
  await time.advance(30 * 60 * 1000);
  assert.equal(calls.filter((call) => call.kind === "withdraw").length, 0, "nothing can be sent while offline");
  assert.equal(time.pending(), 1, "after many failures the removal still waits for the next attempt");
  setTarget(TARGET);
  await time.advance(60_000);
  assert.deepEqual(calls.slice(-1).map((call) => call.kind), ["withdraw"]);
  assert.deepEqual(withdrawn, [AGENT]);
  assert.equal(time.pending(), 0);
});

test("a removal that cannot reach the room for a day ends with the server's retention", async () => {
  const { time, calls, publisher, withdrawn } = harness({ sharing: "withdrawing", target: null });
  publisher.resume(new Map([[AGENT, "withdrawing"]]));
  await time.advance(23 * 60 * 60 * 1000);
  assert.equal(time.pending(), 1, "still retrying within the retention");
  await time.advance(2 * 60 * 60 * 1000);
  assert.equal(time.pending(), 0, "the server's retention has removed what was shared");
  assert.deepEqual(calls, []);
  assert.deepEqual(withdrawn, [AGENT]);
});

test("a failed read of the owner's choice is not remembered as off", async () => {
  const { time, calls, publisher, reads } = harness({ sharing: true, failRead: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  await time.advance(0);
  assert.deepEqual(calls, []);
  publisher.turnEnded(AGENT, "inbox_1");
  publisher.turnStarted(AGENT, "inbox_2", "msg_8");
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.equal(reads(), 2, "the choice is read again");
  assert.deepEqual(calls.map((call) => call.kind), ["create"]);
});

test("tools named like object properties read as unknown tools and do not stop sharing", async () => {
  const { time, calls, publisher, push } = harness({ sharing: true });
  publisher.turnStarted(AGENT, "inbox_1", "msg_7");
  push(tool("t1", "constructor", "completed"), tool("t2", "__proto__", "completed"), tool("t3", "toString", "running"));
  await time.advance(LIVE_ROOM_SHARE_INTERVAL_MS);
  assert.deepEqual(calls.at(-1)!.body!.live.entries.map((entry) => entry.kind === "action" ? entry.headline : ""), ["Used a tool", "Used a tool", "Using a tool"]);
});

test("passwords with @ or / and paths with any letters are hidden", () => {
  assert.equal(roomSafeLine("Connecting to postgres://admin:p@ss/w@rd@db.internal/app", 120), "Connecting to postgres://admin:[REDACTED]@db.internal/app");
  assert.equal(withoutMachinePaths("Read /Users/émilie/projets/x.ts, ~/Ångström/notes.md and C:\\Users\\Zoë\\a.txt."),
    "Read `x.ts`, `notes.md` and `a.txt`.");
  assert.equal(withoutMachinePaths("See https://github.com/acme/app/blob/main/x.ts and and/or 1/2"), "See https://github.com/acme/app/blob/main/x.ts and and/or 1/2");
  // Folder names with spaces, and paths right after ":", "**" or a tag, keep nothing but the file name.
  assert.equal(withoutMachinePaths("open /Users/emmy/Clients/Acme Corp/contract.pdf now"), "open `contract.pdf` now");
  assert.equal(withoutMachinePaths("Read:/Users/émilie/a/b.ts, **/Users/émilie/c/d.md** and <code>/Users/émilie/e/f.ts</code>"),
    "Read:`b.ts`, **`d.md`** and <code>`f.ts`</code>");
  assert.equal(withoutMachinePaths("~/Library/Application Support/LetAgents/state.db."), "`state.db`.");
  assert.equal(JSON.stringify(roomSafeText("Opened /home/zoë/clients/acme/plan.md\nthen ran it.", 1_200)).includes("zoë"), false);
});

test("a snapshot keeps the newest entries within the stored limits", () => {
  const events: DaemonActivityEvent[] = [];
  for (let index = 0; index < 90; index += 1) {
    events.push({ ...note(`r${index}`, `${"Long reasoning. ".repeat(100)}${index}`) });
    events.push({ ...tool(`t${index}`, "shellToolCall", "completed") });
  }
  const { live } = buildRoomLiveSnapshot({
    events: events.map((item, index) => ({ sequence: index + 1, observed_at: item.observed_at, kind: item.kind, method: item.method, summary: null, payload: item.payload })),
    dropped: false, startedAt: "2026-10-18T10:00:00.000Z", endedAt: null, requestMessageId: "msg_1",
  });
  assert.ok(live.entries.length <= ROOM_LIVE_LIMITS.entries);
  assert.equal(live.omitted_earlier, true);
  assert.ok(Buffer.byteLength(JSON.stringify(live)) <= ROOM_LIVE_LIMITS.snapshotBytes);
  assert.equal(live.entries.at(-1)!.kind, "action", "the newest entry is kept");
  for (const entry of live.entries) if (entry.kind === "note") assert.ok(entry.text.length <= ROOM_LIVE_LIMITS.textChars);
});

test("room text keeps line breaks but loses controls, credentials and machine paths", () => {
  assert.equal(
    roomSafeText("Step one.\r\nRead C:\\Users\\owner\\keys\\prod.pem and\u0007 redis://:pw@cache:6379\u200b", 1_200),
    "Step one.\nRead `prod.pem` and  redis://:[REDACTED]@cache:6379",
  );
  assert.equal(roomSafeText("   ", 1_200), null);
});
