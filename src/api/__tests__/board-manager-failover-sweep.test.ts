import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActiveBoardManagerAssignmentCandidate,
  BoardManagerAssignment,
  BoardManagerCandidate,
  LivenessAnnouncementCandidate,
  RoomAgentDeliverySession,
} from "../db.js";
import {
  buildManagerFailoverAnnouncementText,
  buildManagerOfflineAnnouncementText,
  buildPendingIntentsHandoffText,
  createBoardManagerFailoverSweeper,
  evaluateBoardManagerDeath,
  MANAGER_FAILOVER_AFTER_MS,
  type BoardManagerFailoverResult,
  type BoardManagerFailoverSweeperDeps,
} from "../rooms/board-manager-failover-sweep.js";

const NOW = Date.parse("2026-07-13T22:00:00.000Z");

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function buildAssignment(overrides: Partial<BoardManagerAssignment> = {}): BoardManagerAssignment {
  return {
    id: overrides.id ?? "bm_dead",
    room_id: overrides.room_id ?? "focus_34",
    agent_session_id: overrides.agent_session_id ?? "agent_session_331",
    agent_key: overrides.agent_key ?? "EmmyMay/field-signal",
    actor_label: overrides.actor_label ?? "FieldSignal | EmmyMay's agent | Codex",
    runtime_source: overrides.runtime_source ?? "desktop_managed",
    assigned_by: overrides.assigned_by ?? "EmmyMay",
    status: overrides.status ?? "active",
    last_heartbeat_at: overrides.last_heartbeat_at ?? isoMinutesAgo(60),
    released_by: overrides.released_by ?? null,
    release_reason: overrides.release_reason ?? null,
    released_at: overrides.released_at ?? null,
    created_at: overrides.created_at ?? isoMinutesAgo(120),
    updated_at: overrides.updated_at ?? isoMinutesAgo(120),
  };
}

function buildDeliverySession(
  overrides: Partial<RoomAgentDeliverySession> = {}
): RoomAgentDeliverySession {
  return {
    room_id: overrides.room_id ?? "focus_34",
    delivery_key: overrides.delivery_key ?? "agent_session:agent_session_331",
    actor_label: overrides.actor_label ?? "FieldSignal | EmmyMay's agent | Codex",
    agent_key: overrides.agent_key ?? "EmmyMay/field-signal",
    agent_instance_id: overrides.agent_instance_id ?? null,
    agent_session_id: overrides.agent_session_id ?? "agent_session_331",
    session_kind: overrides.session_kind ?? "worker",
    runtime: overrides.runtime ?? "codex",
    display_name: overrides.display_name ?? "FieldSignal",
    owner_label: overrides.owner_label ?? "EmmyMay",
    ide_label: overrides.ide_label ?? "Codex",
    repo_branch: overrides.repo_branch ?? null,
    transport: overrides.transport ?? "long_poll",
    active_connection_count: overrides.active_connection_count ?? 0,
    last_connected_at: overrides.last_connected_at ?? isoMinutesAgo(60),
    last_disconnected_at:
      overrides.last_disconnected_at === undefined ? isoMinutesAgo(6) : overrides.last_disconnected_at,
    reconnect_grace_expires_at:
      overrides.reconnect_grace_expires_at === undefined
        ? isoMinutesAgo(6)
        : overrides.reconnect_grace_expires_at,
    offline_announced_at: overrides.offline_announced_at ?? null,
    recovery_announced_at: overrides.recovery_announced_at ?? null,
    created_at: overrides.created_at ?? isoMinutesAgo(120),
    updated_at: overrides.updated_at ?? isoMinutesAgo(6),
  };
}

function delivery(session: RoomAgentDeliverySession): LivenessAnnouncementCandidate {
  return { session, agent_session_ended_at: null };
}

function buildCandidate(overrides: Partial<BoardManagerCandidate> = {}): BoardManagerCandidate {
  return {
    agent_session_id: overrides.agent_session_id ?? "agent_session_400",
    agent_key: overrides.agent_key ?? "EmmyMay/river-grove",
    actor_label: overrides.actor_label ?? "RiverGrove | EmmyMay's agent | Claude Code",
    display_name: overrides.display_name ?? "RiverGrove",
    runtime: overrides.runtime ?? "claude-code",
    runtime_source: overrides.runtime_source ?? "desktop_managed",
    last_seen_at: overrides.last_seen_at ?? isoMinutesAgo(1),
    is_active_manager: overrides.is_active_manager ?? false,
  };
}

test("evaluateBoardManagerDeath verdicts", () => {
  const created = isoMinutesAgo(120);

  assert.deepEqual(
    evaluateBoardManagerDeath({
      assignment_created_at: created,
      agent_session_ended_at: isoMinutesAgo(10),
      delivery: null,
      now: NOW,
    }),
    { dead: true, epoch: isoMinutesAgo(10) },
    "an ended session is a vacancy even without delivery data"
  );

  assert.equal(
    evaluateBoardManagerDeath({
      assignment_created_at: created,
      agent_session_ended_at: null,
      delivery: null,
      now: NOW,
    }).dead,
    false,
    "no delivery evidence means no failover"
  );

  assert.equal(
    evaluateBoardManagerDeath({
      assignment_created_at: created,
      agent_session_ended_at: null,
      delivery: delivery(
        buildDeliverySession({
          active_connection_count: 1,
          updated_at: new Date(NOW - 10_000).toISOString(),
          last_disconnected_at: null,
          reconnect_grace_expires_at: null,
        })
      ),
      now: NOW,
    }).dead,
    false,
    "a reachable manager is alive"
  );

  assert.equal(
    evaluateBoardManagerDeath({
      assignment_created_at: created,
      agent_session_ended_at: null,
      delivery: delivery(
        buildDeliverySession({
          last_disconnected_at: isoMinutesAgo(2),
          reconnect_grace_expires_at: isoMinutesAgo(2),
          updated_at: isoMinutesAgo(2),
        })
      ),
      now: NOW,
    }).dead,
    false,
    "unreachable but inside the failover threshold stays alive"
  );

  const cleanDeath = evaluateBoardManagerDeath({
    assignment_created_at: created,
    agent_session_ended_at: null,
    delivery: delivery(buildDeliverySession()),
    now: NOW,
  });
  assert.equal(cleanDeath.dead, true);
  assert.equal(cleanDeath.epoch, isoMinutesAgo(6));

  const deadSocket = evaluateBoardManagerDeath({
    assignment_created_at: created,
    agent_session_ended_at: null,
    delivery: delivery(
      buildDeliverySession({
        active_connection_count: 1,
        last_disconnected_at: null,
        reconnect_grace_expires_at: null,
        updated_at: isoMinutesAgo(7),
      })
    ),
    now: NOW,
  });
  assert.equal(deadSocket.dead, true);
  assert.equal(deadSocket.epoch, isoMinutesAgo(7));
  assert.ok(MANAGER_FAILOVER_AFTER_MS > 0);
});

test("announcement texts name the manager, successor, and pending work", () => {
  const assignment = buildAssignment();
  const withoutCandidate = buildManagerOfflineAnnouncementText({
    assignment,
    suggested_candidate: null,
  });
  assert.ok(withoutCandidate.includes("Board Manager FieldSignal appears to be offline"));
  assert.ok(!withoutCandidate.includes("most recently active"));

  const withCandidate = buildManagerOfflineAnnouncementText({
    assignment,
    suggested_candidate: buildCandidate(),
  });
  assert.ok(withCandidate.includes("RiverGrove is the most recently active worker"));

  const failover = buildManagerFailoverAnnouncementText({
    assignment,
    successor: buildCandidate(),
  });
  assert.ok(failover.includes("RiverGrove has been promoted to Board Manager automatically"));

  const single = buildPendingIntentsHandoffText({
    successor: buildAssignment({ actor_label: "RiverGrove | EmmyMay's agent | Claude Code" }),
    pending_count: 1,
  });
  assert.ok(single.includes("1 pending board intent awaits"));
  const plural = buildPendingIntentsHandoffText({
    successor: buildAssignment({ actor_label: "RiverGrove | EmmyMay's agent | Claude Code" }),
    pending_count: 3,
  });
  assert.ok(plural.includes("3 pending board intents await"));
});

interface FakeDepsOptions {
  assignments: ActiveBoardManagerAssignmentCandidate[];
  mode?: "off" | "announce" | "auto";
  deliveries?: Map<string, LivenessAnnouncementCandidate | null>;
  candidates?: BoardManagerCandidate[];
  connectionStates?: Map<string, "live" | "grace" | "none">;
  failoverResult?: BoardManagerFailoverResult | null;
  pendingIntents?: number;
  failForRoom?: string;
}

function buildFakeDeps(options: FakeDepsOptions) {
  const offlineAnnouncements: Array<{ roomId: string; text: string; clientMessageId: string }> = [];
  const failoverCalls: Array<{ roomId: string; clientMessageId: string; successorSessionId: string }> = [];
  const intentAnnouncements: string[] = [];
  const recordedEvents: BoardManagerFailoverResult[] = [];

  const defaultResult: BoardManagerFailoverResult = {
    released: buildAssignment({ status: "released" }),
    promoted: buildAssignment({
      id: "bm_new",
      agent_session_id: "agent_session_400",
      actor_label: "RiverGrove | EmmyMay's agent | Claude Code",
    }),
  };

  const deps: BoardManagerFailoverSweeperDeps = {
    listActiveManagerAssignments: async () => options.assignments,
    getManagerFailoverMode: async (roomId) => {
      if (options.failForRoom === roomId) {
        throw new Error("settings lookup failed");
      }
      return options.mode ?? "auto";
    },
    getDeliveryCandidate: async ({ delivery_key }) =>
      options.deliveries?.get(delivery_key) ?? null,
    listManagerCandidates: async () => options.candidates ?? [],
    getCandidateConnectionState: async (_roomId, agentSessionId) =>
      options.connectionStates?.get(agentSessionId) ?? "none",
    announceManagerOffline: async (input) => {
      offlineAnnouncements.push({
        roomId: input.room_id,
        text: input.text,
        clientMessageId: input.client_message_id,
      });
    },
    announceFailover: async (input) => {
      failoverCalls.push({
        roomId: input.room_id,
        clientMessageId: input.client_message_id,
        successorSessionId: input.successor_agent_session_id,
      });
      return options.failoverResult === undefined ? defaultResult : options.failoverResult;
    },
    countPendingIntents: async () => options.pendingIntents ?? 0,
    announcePendingIntents: async (input) => {
      intentAnnouncements.push(input.text);
    },
    recordFailoverEvents: async ({ result }) => {
      recordedEvents.push(result);
    },
    now: () => NOW,
  };

  return { deps, offlineAnnouncements, failoverCalls, intentAnnouncements, recordedEvents };
}

function deadManagerEntry(): ActiveBoardManagerAssignmentCandidate {
  return { assignment: buildAssignment(), agent_session_ended_at: null };
}

function deadDeliveries(): Map<string, LivenessAnnouncementCandidate | null> {
  return new Map([["agent_session:agent_session_331", delivery(buildDeliverySession())]]);
}

test("off mode never reacts to a dead manager", async () => {
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "off",
    deliveries: deadDeliveries(),
  });
  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.announced_offline, 0);
  assert.equal(summary.failovers, 0);
  assert.deepEqual(fake.offlineAnnouncements, []);
});

test("announce mode posts once per outage and respects the cooldown", async () => {
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "announce",
    deliveries: deadDeliveries(),
    candidates: [buildCandidate()],
    connectionStates: new Map([["agent_session_400", "live"]]),
  });
  const sweeper = createBoardManagerFailoverSweeper(fake.deps);

  const first = await sweeper.sweepOnce();
  const second = await sweeper.sweepOnce();
  assert.equal(first.announced_offline, 1);
  assert.equal(second.announced_offline, 0);
  assert.equal(fake.offlineAnnouncements.length, 1);
  assert.ok(fake.offlineAnnouncements[0]!.text.includes("RiverGrove is the most recently active"));
  assert.equal(
    fake.offlineAnnouncements[0]?.clientMessageId,
    `board_manager_offline:bm_dead:${isoMinutesAgo(6)}`
  );
  assert.deepEqual(fake.failoverCalls, []);
});

test("daemon-supervised managers still trigger governance failover", async () => {
  const daemonManagerDelivery: LivenessAnnouncementCandidate = {
    ...delivery(buildDeliverySession()),
    supervisor_managed: true,
  };
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "auto",
    deliveries: new Map([["agent_session:agent_session_331", daemonManagerDelivery]]),
    candidates: [buildCandidate()],
    connectionStates: new Map([["agent_session_400", "live"]]),
  });

  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.failovers, 1);
  assert.equal(fake.failoverCalls.length, 1);
});

test("auto mode promotes the best reachable successor and hands over pending intents", async () => {
  const unreachable = buildCandidate({ agent_session_id: "agent_session_350", actor_label: "StoneVale | X | Codex" });
  const reachable = buildCandidate();
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "auto",
    deliveries: deadDeliveries(),
    candidates: [unreachable, reachable],
    connectionStates: new Map([["agent_session_400", "live"]]),
    pendingIntents: 2,
  });
  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.failovers, 1);
  assert.equal(fake.failoverCalls.length, 1);
  assert.equal(fake.failoverCalls[0]?.successorSessionId, "agent_session_400");
  assert.equal(fake.failoverCalls[0]?.clientMessageId, "board_manager_failover:bm_dead");
  assert.equal(fake.recordedEvents.length, 1);
  assert.equal(fake.intentAnnouncements.length, 1);
  assert.ok(fake.intentAnnouncements[0]!.includes("2 pending board intents await"));
});

test("a freshly assigned manager gets the full threshold despite stale delivery evidence", () => {
  // The delivery session died 10 minutes ago, but the assignment is only
  // 1 minute old — outage evidence predating the assignment must not count.
  const staleDelivery = delivery(
    buildDeliverySession({
      last_disconnected_at: isoMinutesAgo(10),
      reconnect_grace_expires_at: isoMinutesAgo(10),
      updated_at: isoMinutesAgo(10),
    })
  );

  assert.equal(
    evaluateBoardManagerDeath({
      assignment_created_at: isoMinutesAgo(1),
      agent_session_ended_at: null,
      delivery: staleDelivery,
      now: NOW,
    }).dead,
    false,
    "a 1-minute-old assignment must not be deposed on pre-assignment evidence"
  );

  assert.equal(
    evaluateBoardManagerDeath({
      assignment_created_at: isoMinutesAgo(6),
      agent_session_ended_at: null,
      delivery: staleDelivery,
      now: NOW,
    }).dead,
    true,
    "once the assignment itself is older than the threshold the death counts"
  );
});

test("auto mode prefers a live-connection successor over a grace-window one", async () => {
  const graceButNewer = buildCandidate({
    agent_session_id: "agent_session_350",
    actor_label: "StoneVale | EmmyMay's agent | Codex",
    last_seen_at: isoMinutesAgo(0),
  });
  const liveButOlder = buildCandidate({ last_seen_at: isoMinutesAgo(2) });
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "auto",
    deliveries: deadDeliveries(),
    candidates: [graceButNewer, liveButOlder],
    connectionStates: new Map([
      ["agent_session_350", "grace"],
      ["agent_session_400", "live"],
    ]),
  });
  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.failovers, 1);
  assert.equal(fake.failoverCalls[0]?.successorSessionId, "agent_session_400");

  // With only grace-window candidates available, the fallback still promotes.
  const graceOnly = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "auto",
    deliveries: deadDeliveries(),
    candidates: [graceButNewer],
    connectionStates: new Map([["agent_session_350", "grace"]]),
  });
  const graceSummary = await createBoardManagerFailoverSweeper(graceOnly.deps).sweepOnce();
  assert.equal(graceSummary.failovers, 1);
  assert.equal(graceOnly.failoverCalls[0]?.successorSessionId, "agent_session_350");
});

test("auto mode skips the dead manager's own session and degrades to announce with no successor", async () => {
  const onlySelf = buildCandidate({ agent_session_id: "agent_session_331" });
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "auto",
    deliveries: deadDeliveries(),
    candidates: [onlySelf],
    connectionStates: new Map([["agent_session_331", "live"]]),
  });
  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.failovers, 0);
  assert.equal(summary.announced_offline, 1);
  assert.deepEqual(fake.failoverCalls, []);
});

test("a lost failover fence records nothing and posts no intent handoff", async () => {
  const fake = buildFakeDeps({
    assignments: [deadManagerEntry()],
    mode: "auto",
    deliveries: deadDeliveries(),
    candidates: [buildCandidate()],
    connectionStates: new Map([["agent_session_400", "live"]]),
    failoverResult: null,
    pendingIntents: 5,
  });
  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.failovers, 0);
  assert.deepEqual(fake.recordedEvents, []);
  assert.deepEqual(fake.intentAnnouncements, []);
});

test("a live manager and a missing delivery row are both left alone", async () => {
  const alive = new Map([
    [
      "agent_session:agent_session_331",
      delivery(
        buildDeliverySession({
          active_connection_count: 1,
          updated_at: new Date(NOW - 10_000).toISOString(),
          last_disconnected_at: null,
          reconnect_grace_expires_at: null,
        })
      ),
    ],
  ]);
  const fakeAlive = buildFakeDeps({ assignments: [deadManagerEntry()], deliveries: alive });
  const fakeNoData = buildFakeDeps({ assignments: [deadManagerEntry()], deliveries: new Map() });

  assert.equal((await createBoardManagerFailoverSweeper(fakeAlive.deps).sweepOnce()).failovers, 0);
  assert.equal((await createBoardManagerFailoverSweeper(fakeNoData.deps).sweepOnce()).failovers, 0);
});

test("per-assignment failures are isolated", async () => {
  const failing = { assignment: buildAssignment({ room_id: "focus_broken", id: "bm_x" }), agent_session_ended_at: null };
  const fake = buildFakeDeps({
    assignments: [failing, deadManagerEntry()],
    mode: "auto",
    deliveries: deadDeliveries(),
    candidates: [buildCandidate()],
    connectionStates: new Map([["agent_session_400", "live"]]),
    failForRoom: "focus_broken",
  });
  const summary = await createBoardManagerFailoverSweeper(fake.deps).sweepOnce();

  assert.equal(summary.rooms_with_errors, 1);
  assert.equal(summary.failovers, 1);
});
