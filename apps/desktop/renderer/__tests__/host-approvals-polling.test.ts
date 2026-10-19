import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { DesktopHostApproval } from "../../shared/host-approvals";
import {
  HOST_APPROVAL_ACTIVE_POLL_MS,
  HOST_APPROVAL_IDLE_POLL_MS,
  hostApprovalPollDue,
  hostApprovalRoom,
  refreshHostApprovals,
  resetHostApprovals,
  watchHostApprovalPushes,
} from "../src/components/desktop/content/room-chat/host-approvals";

const ROOM = "room-a";
let now = 1_000_000;
let reads = 0;
let approvals: DesktopHostApproval[] = [];
let pushListener: ((snapshot: { entries: unknown[] }) => void) | null = null;

function approval(status: DesktopHostApproval["status"]): DesktopHostApproval {
  return {
    id: "presentation-1", requestKey: "request-1", status, detail: null, retryDecision: null, dismissKey: null,
    presentation: { agentId: "agent_1", displayName: "Agent", provider: "codex", title: "Run a command", details: "{}", denyScope: "request" },
  } as DesktopHostApproval;
}

beforeEach(() => {
  resetHostApprovals();
  reads = 0;
  approvals = [];
  pushListener = null;
  now = 1_000_000;
  mock.method(Date, "now", () => now);
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async () => { reads += 1; return { available: true, approvals: structuredClone(approvals), error: null }; },
    onState: (callback: (snapshot: { entries: unknown[] }) => void) => { pushListener = callback; return () => { pushListener = null; }; },
  } } } });
});

/** The composer's 3 s tick, run for a number of seconds. */
async function runTicks(seconds: number): Promise<void> {
  for (let elapsed = 0; elapsed <= seconds; elapsed += 3) {
    if (hostApprovalPollDue(ROOM)) await refreshHostApprovals(ROOM);
    now += HOST_APPROVAL_ACTIVE_POLL_MS;
  }
}

test("a quiet room lists approvals every 15 s, not every 3 s", async () => {
  await runTicks(60);
  console.log(`item6 listings in 60 s, quiet room: ${reads} (was 21 at a fixed 3 s)`);
  assert.equal(reads, 1 + Math.floor(60 / (HOST_APPROVAL_IDLE_POLL_MS / 1000)));
});

test("an open approval keeps the 3 s poll", async () => {
  approvals = [approval("pending")];
  await runTicks(60);
  console.log(`item6 listings in 60 s, pending approval: ${reads}`);
  assert.equal(reads, 21);
});

test("a failed listing keeps the fast poll so recovery stays quick", async () => {
  (globalThis as unknown as { window: { letagentsDesktop: { supervisor: { listHostApprovals: unknown } } } })
    .window.letagentsDesktop.supervisor.listHostApprovals = async () => { reads += 1; throw new Error("down"); };
  await runTicks(30);
  assert.equal(reads, 11);
});

test("a supervisor state push lists approvals at once, throttled, and ignores empty pushes", async () => {
  await refreshHostApprovals(ROOM);
  const stop = watchHostApprovalPushes(ROOM);
  assert.ok(pushListener);
  now += 1_000;
  pushListener!({ entries: [{}] });
  await Promise.resolve();
  assert.equal(reads, 1, "inside the active period a push does not repeat the listing");
  now += 2_500;
  pushListener!({ entries: [] });
  await Promise.resolve();
  assert.equal(reads, 1, "a heartbeat with no agents of this room is ignored");
  pushListener!({ entries: [{}] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2, "a push with this room's agents lists approvals before the slow tick");
  stop();
  assert.equal(pushListener, null);
});

test("an unchanged listing keeps the same array and approval objects", async () => {
  approvals = [approval("pending")];
  await refreshHostApprovals(ROOM);
  const firstList = hostApprovalRoom(ROOM).approvals;
  const firstItem = firstList[0];
  const firstSeen = hostApprovalRoom(ROOM).firstSeenAt;
  now += 20_000;
  await refreshHostApprovals(ROOM);
  assert.equal(hostApprovalRoom(ROOM).approvals, firstList);
  assert.equal(hostApprovalRoom(ROOM).approvals[0], firstItem);
  assert.equal(hostApprovalRoom(ROOM).firstSeenAt, firstSeen);
  approvals = [{ ...approval("pending"), status: "decision_sent" } as DesktopHostApproval];
  await refreshHostApprovals(ROOM);
  assert.equal(hostApprovalRoom(ROOM).approvals[0]!.status, "decision_sent", "a changed listing still updates");
});
