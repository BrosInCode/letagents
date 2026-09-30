import assert from "node:assert/strict";
import test from "node:test";

import type { LivenessAnnouncementCandidate, RoomAgentDeliverySession } from "../db.js";
import {
  buildOfflineAnnouncementText,
  buildRecoveryAnnouncementText,
  CHANNEL_STALE_AFTER_MS,
  classifyDualAxisLiveness,
  createLivenessSweeper,
  NO_WORK_RECHECK_MS,
  OFFLINE_ANNOUNCE_AFTER_MS,
  OFFLINE_ANNOUNCE_MAX_AGE_MS,
  resolveOfflineAnnounceAfterMs,
  selectLivenessTransitions,
  type LivenessSweeperDeps,
} from "../rooms/liveness-sweep.js";

const NOW = Date.parse("2026-07-13T21:00:00.000Z");

test("dual-axis liveness keeps room-quiet native work non-terminal", () => {
  assert.equal(classifyDualAxisLiveness({ workplace_fresh: true, native_fresh: true }), "healthy");
  assert.equal(classifyDualAxisLiveness({ workplace_fresh: false, native_fresh: true }), "working_room_quiet");
  assert.equal(classifyDualAxisLiveness({ workplace_fresh: false, native_fresh: false }), "suspect");
});

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function buildSession(overrides: Partial<RoomAgentDeliverySession> = {}): RoomAgentDeliverySession {
  return {
    room_id: overrides.room_id ?? "focus_34",
    delivery_key: overrides.delivery_key ?? "agent_session:agent_session_331",
    actor_label: overrides.actor_label ?? "FieldSignal | EmmyMay's agent | Codex",
    agent_key: overrides.agent_key ?? "EmmyMay/field-signal",
    agent_instance_id: overrides.agent_instance_id ?? "instance-fieldsignal",
    agent_session_id: overrides.agent_session_id ?? "agent_session_331",
    session_kind: overrides.session_kind ?? "worker",
    runtime: overrides.runtime ?? "codex",
    display_name: overrides.display_name ?? "FieldSignal",
    owner_label: overrides.owner_label ?? "EmmyMay",
    ide_label: overrides.ide_label ?? "Codex",
    repo_branch: overrides.repo_branch ?? null,
    transport: overrides.transport ?? "long_poll",
    active_connection_count: overrides.active_connection_count ?? 0,
    last_connected_at: overrides.last_connected_at ?? isoMinutesAgo(30),
    last_disconnected_at:
      overrides.last_disconnected_at === undefined ? isoMinutesAgo(31) : overrides.last_disconnected_at,
    reconnect_grace_expires_at:
      overrides.reconnect_grace_expires_at === undefined
        ? isoMinutesAgo(31)
        : overrides.reconnect_grace_expires_at,
    offline_announced_at:
      overrides.offline_announced_at === undefined ? null : overrides.offline_announced_at,
    recovery_announced_at:
      overrides.recovery_announced_at === undefined ? null : overrides.recovery_announced_at,
    created_at: overrides.created_at ?? isoMinutesAgo(120),
    updated_at: overrides.updated_at ?? isoMinutesAgo(31),
  };
}

function reachableSession(overrides: Partial<RoomAgentDeliverySession> = {}): RoomAgentDeliverySession {
  return buildSession({
    active_connection_count: 1,
    updated_at: new Date(NOW - 10_000).toISOString(),
    last_disconnected_at: null,
    reconnect_grace_expires_at: null,
    ...overrides,
  });
}

function candidate(
  session: RoomAgentDeliverySession,
  endedAt: string | null = null,
  runtimeLastActiveAt: string | null = null,
  workTaskIds: string[] = ["task_12"]
): LivenessAnnouncementCandidate {
  return {
    session,
    agent_session_ended_at: endedAt,
    runtime_last_active_at: runtimeLastActiveAt,
    active_work_task_ids: workTaskIds,
  };
}

test("announces a worker holding work offline past the threshold", () => {
  const transitions = selectLivenessTransitions({
    candidates: [candidate(buildSession())],
    now: NOW,
  });

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
  assert.deepEqual(transitions[0]?.work_task_ids, ["task_12"]);
  assert.ok(transitions[0]!.offline_for_ms >= OFFLINE_ANNOUNCE_AFTER_MS);
});

test("never posts presence changes for a worker that holds no work", () => {
  const idle = candidate(buildSession(), null, null, []);
  assert.deepEqual(selectLivenessTransitions({ candidates: [idle], now: NOW }), []);

  // A candidate row without the lease column also counts as holding nothing.
  const { active_work_task_ids: _omitted, ...legacyRow } = idle;
  assert.deepEqual(selectLivenessTransitions({ candidates: [legacyRow], now: NOW }), []);
});

test("keeps daemon-supervised worker outages out of room chat", () => {
  const daemonCandidate = {
    ...candidate(buildSession()),
    supervisor_managed: true,
  };

  assert.deepEqual(
    selectLivenessTransitions({ candidates: [daemonCandidate], now: NOW }),
    []
  );
});

test("stays quiet inside the announce threshold and reconnect grace", () => {
  const stillFresh = buildSession({
    last_disconnected_at: isoMinutesAgo(1),
    reconnect_grace_expires_at: isoMinutesAgo(1),
    updated_at: isoMinutesAgo(1),
  });
  const inGrace = buildSession({
    last_disconnected_at: new Date(NOW - 5_000).toISOString(),
    reconnect_grace_expires_at: new Date(NOW + 5_000).toISOString(),
    updated_at: new Date(NOW - 5_000).toISOString(),
  });
  const staleButInsideVisibleGrace = buildSession({
    last_disconnected_at: isoMinutesAgo(20),
    reconnect_grace_expires_at: isoMinutesAgo(20),
    updated_at: isoMinutesAgo(20),
  });

  assert.deepEqual(
    selectLivenessTransitions({
      candidates: [
        candidate(stillFresh),
        candidate(inGrace),
        candidate(staleButInsideVisibleGrace),
      ],
      now: NOW,
    }),
    []
  );
  assert.equal(CHANNEL_STALE_AFTER_MS, 2 * 60_000);
  assert.equal(OFFLINE_ANNOUNCE_AFTER_MS, 30 * 60_000);
});

test("visible notice grace is configurable without changing channel staleness", () => {
  const threeMinuteOutage = candidate(buildSession({
    last_disconnected_at: isoMinutesAgo(3),
    reconnect_grace_expires_at: isoMinutesAgo(3),
    updated_at: isoMinutesAgo(3),
  }));

  assert.deepEqual(
    selectLivenessTransitions({ candidates: [threeMinuteOutage], now: NOW }),
    []
  );
  assert.equal(
    selectLivenessTransitions({
      candidates: [threeMinuteOutage],
      now: NOW,
      offlineAnnounceAfterMs: 3 * 60_000,
    })[0]?.kind,
    "offline"
  );

  assert.equal(resolveOfflineAnnounceAfterMs(undefined), OFFLINE_ANNOUNCE_AFTER_MS);
  assert.equal(resolveOfflineAnnounceAfterMs("420000"), 7 * 60_000);
  assert.equal(resolveOfflineAnnounceAfterMs("not-a-number"), OFFLINE_ANNOUNCE_AFTER_MS);
  assert.equal(resolveOfflineAnnounceAfterMs("60000"), OFFLINE_ANNOUNCE_AFTER_MS);
});

test("skips reachable, controller, suppressed, cleanly ended, and ancient sessions", () => {
  const controller = buildSession({ session_kind: "controller" });
  const suppressed = buildSession({ actor_label: "HiddenAgent | EmmyMay's agent | Codex" });
  const cleanExit = buildSession();
  const ancient = buildSession({
    last_disconnected_at: new Date(NOW - OFFLINE_ANNOUNCE_MAX_AGE_MS - 60_000).toISOString(),
    updated_at: new Date(NOW - OFFLINE_ANNOUNCE_MAX_AGE_MS - 60_000).toISOString(),
  });

  const transitions = selectLivenessTransitions({
    candidates: [
      candidate(reachableSession()),
      candidate(controller),
      candidate(suppressed),
      candidate(cleanExit, isoMinutesAgo(2)),
      candidate(ancient),
    ],
    suppressedActors: new Set(["HiddenAgent | EmmyMay's agent | Codex"]),
    now: NOW,
  });

  assert.deepEqual(transitions, []);
});

test("announces once per outage epoch and re-announces after a later clean disconnect", () => {
  const alreadyAnnounced = buildSession({
    offline_announced_at: isoMinutesAgo(1),
  });
  assert.deepEqual(
    selectLivenessTransitions({ candidates: [candidate(alreadyAnnounced)], now: NOW }),
    []
  );

  const diedAgain = buildSession({
    offline_announced_at: isoMinutesAgo(45),
    last_disconnected_at: isoMinutesAgo(31),
  });
  const transitions = selectLivenessTransitions({ candidates: [candidate(diedAgain)], now: NOW });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
});

test("detects a dead socket that never closed via stale heartbeat", () => {
  const zombieConnection = buildSession({
    active_connection_count: 1,
    last_disconnected_at: null,
    reconnect_grace_expires_at: null,
    updated_at: isoMinutesAgo(30),
  });

  const transitions = selectLivenessTransitions({
    candidates: [candidate(zombieConnection)],
    now: NOW,
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
});

test("re-announces a dead-socket death after a full offline/recovery cycle", () => {
  // Journey: announced offline at -50m, recovered and announced at -45m,
  // reconnected (last_disconnected_at cleared), then the process froze —
  // heartbeats stopped at -30m with the socket still counted as connected.
  const secondDeath = buildSession({
    active_connection_count: 1,
    last_disconnected_at: null,
    reconnect_grace_expires_at: null,
    updated_at: isoMinutesAgo(30),
    offline_announced_at: isoMinutesAgo(50),
    recovery_announced_at: isoMinutesAgo(45),
  });

  const transitions = selectLivenessTransitions({
    candidates: [candidate(secondDeath)],
    now: NOW,
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
});

test("emits a recovery transition only after an announced outage", () => {
  const recovered = reachableSession({
    last_disconnected_at: isoMinutesAgo(10),
    offline_announced_at: isoMinutesAgo(8),
  });
  const transitions = selectLivenessTransitions({ candidates: [candidate(recovered)], now: NOW });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "recovered");

  const alreadyRecovered = buildSession({
    ...recovered,
    recovery_announced_at: isoMinutesAgo(4),
  });
  assert.deepEqual(
    selectLivenessTransitions({ candidates: [candidate(alreadyRecovered)], now: NOW }),
    []
  );

  assert.deepEqual(
    selectLivenessTransitions({ candidates: [candidate(reachableSession())], now: NOW }),
    []
  );
});

test("announcement text names the held work and stays lease-aware", () => {
  const session = buildSession();
  const text = buildOfflineAnnouncementText({
    session,
    work_task_ids: ["task_12"],
    offline_for_ms: 34 * 60_000,
  });
  assert.equal(
    text,
    "[status] FieldSignal has been offline for 34m while holding task_12. It may still be working; reassign only after it or its supervisor confirms it has stopped, or a human directs the transfer."
  );
  assert.ok(!text.includes("appears to be offline"));

  const many = buildOfflineAnnouncementText({
    session,
    work_task_ids: ["task_1", "task_2", "task_3", "task_4", "task_5"],
    offline_for_ms: 34 * 60_000,
  });
  assert.ok(many.includes("while holding task_1, task_2, task_3 and 2 more."));

  assert.equal(
    buildRecoveryAnnouncementText({ session }),
    "[status] FieldSignal is connected to the room again."
  );
});

test("a silent channel with an active runtime is never announced", () => {
  // The channel dropped 31 minutes ago, but the runtime made a tool call
  // 1 minute ago — the agent is busy working, not dead.
  const busyWorker = candidate(buildSession(), null, isoMinutesAgo(1));
  assert.deepEqual(selectLivenessTransitions({ candidates: [busyWorker], now: NOW }), []);

  // Runtime activity in the band between the 2-minute internal stale signal
  // and the 30-minute visible grace also suppresses the room notice. This is
  // the ordinary long tool/test gap the separate visible timer protects.
  const burstWorker = candidate(buildSession(), null, isoMinutesAgo(20));
  assert.deepEqual(selectLivenessTransitions({ candidates: [burstWorker], now: NOW }), []);

  // Once the runtime evidence also goes stale, the death announces with the
  // stronger stale-runtime classification.
  const trulyDead = candidate(buildSession(), null, isoMinutesAgo(35));
  const [transition] = selectLivenessTransitions({ candidates: [trulyDead], now: NOW });
  assert.equal(transition?.kind, "offline");
  assert.equal(transition?.runtime_evidence, "stale");
  assert.equal(transition?.runtime_inactive_for_ms, 35 * 60_000);

  // Raw MCP workers with no telemetry classify as unknown.
  const noTelemetry = candidate(buildSession());
  const [unknownTransition] = selectLivenessTransitions({ candidates: [noTelemetry], now: NOW });
  assert.equal(unknownTransition?.runtime_evidence, "none");
});

interface FakeDepsOptions {
  candidates: LivenessAnnouncementCandidate[];
  /** Per-delivery-key fresh rows returned by getCandidate; defaults to the listed candidate. */
  freshCandidates?: Map<string, LivenessAnnouncementCandidate | null>;
  offlineAnnounceAfterMs?: number;
  suppressedFailsForRoom?: string;
  announceFails?: boolean;
}

interface AnnouncedRecord {
  roomId: string;
  deliveryKey: string;
  text: string;
  clientMessageId: string;
  announcedAt: string;
}

function buildFakeDeps(options: FakeDepsOptions) {
  const announcedOffline: AnnouncedRecord[] = [];
  const announcedRecovered: AnnouncedRecord[] = [];
  let announceFails = options.announceFails ?? false;

  const record = (input: Parameters<LivenessSweeperDeps["announceOffline"]>[0]): AnnouncedRecord => ({
    roomId: input.room_id,
    deliveryKey: input.delivery_key,
    text: input.text,
    clientMessageId: input.client_message_id,
    announcedAt: input.announced_at,
  });

  const deps: LivenessSweeperDeps = {
    listCandidates: async () => options.candidates,
    getCandidate: async ({ delivery_key }) => {
      if (options.freshCandidates?.has(delivery_key)) {
        return options.freshCandidates.get(delivery_key) ?? null;
      }
      return (
        options.candidates.find((entry) => entry.session.delivery_key === delivery_key) ?? null
      );
    },
    getSuppressedActorLabels: async (roomId) => {
      if (options.suppressedFailsForRoom === roomId) {
        throw new Error("suppression lookup failed");
      }
      return new Set<string>();
    },
    announceOffline: async (input) => {
      if (announceFails) {
        throw new Error("announcement transaction failed");
      }
      announcedOffline.push(record(input));
    },
    announceRecovery: async (input) => {
      if (announceFails) {
        throw new Error("announcement transaction failed");
      }
      announcedRecovered.push(record(input));
    },
    offlineAnnounceAfterMs: options.offlineAnnounceAfterMs,
    now: () => NOW,
  };
  return {
    deps,
    announcedOffline,
    announcedRecovered,
    setAnnounceFails(value: boolean) {
      announceFails = value;
    },
  };
}

test("sweepOnce uses the configured visible grace for selection and revalidation", async () => {
  const threeMinuteSession = buildSession({
    last_disconnected_at: isoMinutesAgo(3),
    reconnect_grace_expires_at: isoMinutesAgo(3),
    updated_at: isoMinutesAgo(3),
  });
  const { deps, announcedOffline } = buildFakeDeps({
    candidates: [candidate(threeMinuteSession)],
    offlineAnnounceAfterMs: 3 * 60_000,
  });

  const summary = await createLivenessSweeper(deps).sweepOnce();

  assert.equal(summary.announced_offline, 1);
  assert.equal(announcedOffline.length, 1);
});

test("sweepOnce announces offline workers with an epoch-stable client message id", async () => {
  const session = buildSession();
  const { deps, announcedOffline } = buildFakeDeps({ candidates: [candidate(session)] });
  const sweeper = createLivenessSweeper(deps);

  const summary = await sweeper.sweepOnce();
  assert.equal(summary.announced_offline, 1);
  assert.equal(summary.announced_recovered, 0);
  assert.equal(announcedOffline.length, 1);
  assert.equal(announcedOffline[0]?.roomId, "focus_34");
  assert.ok(announcedOffline[0]!.text.includes("FieldSignal has been offline for 31m while holding task_12"));
  assert.equal(
    announcedOffline[0]?.clientMessageId,
    `agent_liveness:offline:${session.delivery_key}:${session.last_disconnected_at}`
  );
  assert.equal(announcedOffline[0]?.announcedAt, new Date(NOW).toISOString());
});

test("sweepOnce retries a failed announcement transaction on the next sweep", async () => {
  const session = buildSession();
  const fake = buildFakeDeps({ candidates: [candidate(session)], announceFails: true });
  const sweeper = createLivenessSweeper(fake.deps);

  const failedSummary = await sweeper.sweepOnce();
  assert.equal(failedSummary.announced_offline, 0);
  assert.equal(failedSummary.failed_transitions, 1);
  assert.deepEqual(fake.announcedOffline, []);

  fake.setAnnounceFails(false);
  const retrySummary = await sweeper.sweepOnce();
  assert.equal(retrySummary.announced_offline, 1);
  assert.equal(retrySummary.failed_transitions, 0);
  assert.equal(fake.announcedOffline.length, 1);
});

test("sweepOnce skips a worker that reconnected between selection and announcement", async () => {
  const dead = buildSession();
  const nowAlive = candidate(reachableSession());
  const { deps, announcedOffline } = buildFakeDeps({
    candidates: [candidate(dead)],
    freshCandidates: new Map([[dead.delivery_key, nowAlive]]),
  });

  const summary = await createLivenessSweeper(deps).sweepOnce();
  assert.equal(summary.announced_offline, 0);
  assert.deepEqual(announcedOffline, []);
});

test("sweepOnce skips a worker that dropped between recovery selection and announcement", async () => {
  const recovered = reachableSession({
    last_disconnected_at: isoMinutesAgo(10),
    offline_announced_at: isoMinutesAgo(8),
  });
  const deadAgain = candidate(
    buildSession({ offline_announced_at: isoMinutesAgo(8), last_disconnected_at: isoMinutesAgo(1), updated_at: isoMinutesAgo(1), reconnect_grace_expires_at: isoMinutesAgo(1) })
  );
  const { deps, announcedRecovered } = buildFakeDeps({
    candidates: [candidate(recovered)],
    freshCandidates: new Map([[recovered.delivery_key, deadAgain]]),
  });

  const summary = await createLivenessSweeper(deps).sweepOnce();
  assert.equal(summary.announced_recovered, 0);
  assert.deepEqual(announcedRecovered, []);
});

test("sweepOnce stays quiet on an absent worker with no work and rechecks sparsely", async () => {
  const idle = (minutesAgo: number) => ({
    ...candidate(buildSession({
      last_disconnected_at: isoMinutesAgo(minutesAgo),
      reconnect_grace_expires_at: isoMinutesAgo(minutesAgo),
      updated_at: isoMinutesAgo(minutesAgo),
    }), null, null, []),
    claimed_check_at: isoMinutesAgo(0),
  });
  const rescheduled: Array<string | null> = [];
  const { deps, announcedOffline } = buildFakeDeps({ candidates: [idle(31), idle(57)] });
  deps.rescheduleCandidate = async (input) => {
    rescheduled.push(input.next_check_at);
  };

  const summary = await createLivenessSweeper(deps).sweepOnce();
  assert.equal(summary.announced_offline, 0);
  assert.deepEqual(announcedOffline, []);
  // It may still claim work over HTTP, which does not re-arm the delivery
  // trigger, so it is rechecked every 5 minutes until the window closes.
  assert.deepEqual(rescheduled, [new Date(NOW + NO_WORK_RECHECK_MS).toISOString(), null]);
});

test("sweepOnce isolates per-room failures and keeps sweeping other rooms", async () => {
  const failingRoom = buildSession({ room_id: "focus_broken", delivery_key: "agent_session:x" });
  const healthyRoom = buildSession();
  const { deps, announcedOffline } = buildFakeDeps({
    candidates: [candidate(failingRoom), candidate(healthyRoom)],
    suppressedFailsForRoom: "focus_broken",
  });
  const summary = await createLivenessSweeper(deps).sweepOnce();

  assert.equal(summary.rooms_with_errors, 1);
  assert.equal(summary.announced_offline, 1);
  assert.equal(announcedOffline[0]?.roomId, "focus_34");
});

test("sweepOnce announces recoveries with a marker-stable client message id", async () => {
  const recovered = reachableSession({
    last_disconnected_at: isoMinutesAgo(10),
    offline_announced_at: isoMinutesAgo(8),
  });
  const { deps, announcedRecovered } = buildFakeDeps({ candidates: [candidate(recovered)] });
  const summary = await createLivenessSweeper(deps).sweepOnce();

  assert.equal(summary.announced_recovered, 1);
  assert.ok(announcedRecovered[0]!.text.includes("is connected to the room again"));
  assert.equal(
    announcedRecovered[0]?.clientMessageId,
    `agent_liveness:recovered:${recovered.delivery_key}:${recovered.offline_announced_at}`
  );
});
