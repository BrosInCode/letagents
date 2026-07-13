import assert from "node:assert/strict";
import test from "node:test";

import type { LivenessAnnouncementCandidate, RoomAgentDeliverySession } from "../db.js";
import {
  buildOfflineAnnouncementText,
  buildRecoveryAnnouncementText,
  createLivenessSweeper,
  OFFLINE_ANNOUNCE_AFTER_MS,
  OFFLINE_ANNOUNCE_MAX_AGE_MS,
  selectLivenessTransitions,
  type LivenessSweeperDeps,
} from "../rooms/liveness-sweep.js";

const NOW = Date.parse("2026-07-13T21:00:00.000Z");

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
      overrides.last_disconnected_at === undefined ? isoMinutesAgo(3) : overrides.last_disconnected_at,
    reconnect_grace_expires_at:
      overrides.reconnect_grace_expires_at === undefined
        ? isoMinutesAgo(3)
        : overrides.reconnect_grace_expires_at,
    offline_announced_at:
      overrides.offline_announced_at === undefined ? null : overrides.offline_announced_at,
    recovery_announced_at:
      overrides.recovery_announced_at === undefined ? null : overrides.recovery_announced_at,
    created_at: overrides.created_at ?? isoMinutesAgo(120),
    updated_at: overrides.updated_at ?? isoMinutesAgo(3),
  };
}

function candidate(
  session: RoomAgentDeliverySession,
  endedAt: string | null = null
): LivenessAnnouncementCandidate {
  return { session, agent_session_ended_at: endedAt };
}

test("announces a worker offline past the threshold", () => {
  const transitions = selectLivenessTransitions({
    candidates: [candidate(buildSession())],
    now: NOW,
  });

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
  assert.equal(transitions[0]?.expected_marker, null);
  assert.ok(transitions[0]!.offline_for_ms >= OFFLINE_ANNOUNCE_AFTER_MS);
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

  assert.deepEqual(
    selectLivenessTransitions({ candidates: [candidate(stillFresh), candidate(inGrace)], now: NOW }),
    []
  );
});

test("skips reachable, controller, suppressed, cleanly ended, and ancient sessions", () => {
  const reachable = buildSession({
    active_connection_count: 1,
    updated_at: new Date(NOW - 10_000).toISOString(),
    last_disconnected_at: null,
    reconnect_grace_expires_at: null,
  });
  const controller = buildSession({ session_kind: "controller" });
  const suppressed = buildSession({ actor_label: "HiddenAgent | EmmyMay's agent | Codex" });
  const cleanExit = buildSession();
  const ancient = buildSession({
    last_disconnected_at: new Date(NOW - OFFLINE_ANNOUNCE_MAX_AGE_MS - 60_000).toISOString(),
    updated_at: new Date(NOW - OFFLINE_ANNOUNCE_MAX_AGE_MS - 60_000).toISOString(),
  });

  const transitions = selectLivenessTransitions({
    candidates: [
      candidate(reachable),
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

test("announces once per disconnect epoch and re-announces after a later death", () => {
  const alreadyAnnounced = buildSession({
    offline_announced_at: isoMinutesAgo(2),
  });
  assert.deepEqual(
    selectLivenessTransitions({ candidates: [candidate(alreadyAnnounced)], now: NOW }),
    []
  );

  const diedAgain = buildSession({
    offline_announced_at: isoMinutesAgo(20),
    last_disconnected_at: isoMinutesAgo(3),
  });
  const transitions = selectLivenessTransitions({ candidates: [candidate(diedAgain)], now: NOW });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
  assert.equal(transitions[0]?.expected_marker, isoMinutesAgo(20));
});

test("detects a dead socket that never closed via stale heartbeat", () => {
  const zombieConnection = buildSession({
    active_connection_count: 1,
    last_disconnected_at: null,
    reconnect_grace_expires_at: null,
    updated_at: isoMinutesAgo(5),
  });

  const transitions = selectLivenessTransitions({
    candidates: [candidate(zombieConnection)],
    now: NOW,
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.kind, "offline");
});

test("emits a recovery transition only after an announced outage", () => {
  const recovered = buildSession({
    active_connection_count: 1,
    updated_at: new Date(NOW - 10_000).toISOString(),
    last_disconnected_at: isoMinutesAgo(10),
    reconnect_grace_expires_at: null,
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

  const neverAnnounced = buildSession({
    active_connection_count: 1,
    updated_at: new Date(NOW - 10_000).toISOString(),
    last_disconnected_at: null,
    reconnect_grace_expires_at: null,
  });
  assert.deepEqual(
    selectLivenessTransitions({ candidates: [candidate(neverAnnounced)], now: NOW }),
    []
  );
});

test("announcement text names the agent and flags the Board Manager role", () => {
  const session = buildSession();
  const plain = buildOfflineAnnouncementText({
    session,
    offline_for_ms: 3 * 60_000,
    is_board_manager: false,
  });
  assert.ok(plain.startsWith("[status] FieldSignal appears to be offline"));
  assert.ok(plain.includes("3m"));
  assert.ok(!plain.includes("Board Manager"));

  const manager = buildOfflineAnnouncementText({
    session,
    offline_for_ms: 3 * 60_000,
    is_board_manager: true,
  });
  assert.ok(manager.includes("Board Manager"));

  assert.equal(
    buildRecoveryAnnouncementText({ session }),
    "[status] FieldSignal is back online and reachable again."
  );
});

interface FakeDepsOptions {
  candidates: LivenessAnnouncementCandidate[];
  managerSessionId?: string | null;
  claimOffline?: boolean;
  suppressedFailsForRoom?: string;
}

function buildFakeDeps(options: FakeDepsOptions) {
  const emitted: Array<{ roomId: string; text: string; clientMessageId: string | null | undefined }> = [];
  const deps: LivenessSweeperDeps = {
    listCandidates: async () => options.candidates,
    getSuppressedActorLabels: async (roomId) => {
      if (options.suppressedFailsForRoom === roomId) {
        throw new Error("suppression lookup failed");
      }
      return new Set<string>();
    },
    getActiveBoardManagerSessionId: async () => options.managerSessionId ?? null,
    markAgentOfflineAnnounced: async () => options.claimOffline ?? true,
    markAgentRecoveryAnnounced: async () => true,
    emitProjectMessage: async (roomId, _sender, text, messageOptions) => {
      emitted.push({ roomId, text, clientMessageId: messageOptions?.client_message_id });
      return null;
    },
    now: () => NOW,
  };
  return { deps, emitted };
}

test("sweepOnce announces offline workers with a dedupe client message id", async () => {
  const session = buildSession();
  const { deps, emitted } = buildFakeDeps({ candidates: [candidate(session)] });
  const sweeper = createLivenessSweeper(deps);

  const summary = await sweeper.sweepOnce();
  assert.equal(summary.announced_offline, 1);
  assert.equal(summary.announced_recovered, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.roomId, "focus_34");
  assert.ok(emitted[0]!.text.includes("FieldSignal appears to be offline"));
  assert.equal(
    emitted[0]?.clientMessageId,
    `agent_liveness:offline:${session.delivery_key}:${session.last_disconnected_at}`
  );
});

test("sweepOnce stays silent when another instance already claimed the announcement", async () => {
  const { deps, emitted } = buildFakeDeps({
    candidates: [candidate(buildSession())],
    claimOffline: false,
  });
  const summary = await createLivenessSweeper(deps).sweepOnce();

  assert.equal(summary.announced_offline, 0);
  assert.deepEqual(emitted, []);
});

test("sweepOnce marks the dead Board Manager in the announcement", async () => {
  const session = buildSession();
  const { deps, emitted } = buildFakeDeps({
    candidates: [candidate(session)],
    managerSessionId: session.agent_session_id,
  });
  await createLivenessSweeper(deps).sweepOnce();

  assert.equal(emitted.length, 1);
  assert.ok(emitted[0]!.text.includes("Board Manager"));
});

test("sweepOnce isolates per-room failures and keeps sweeping other rooms", async () => {
  const failingRoom = buildSession({ room_id: "focus_broken", delivery_key: "agent_session:x" });
  const healthyRoom = buildSession();
  const { deps, emitted } = buildFakeDeps({
    candidates: [candidate(failingRoom), candidate(healthyRoom)],
    suppressedFailsForRoom: "focus_broken",
  });
  const summary = await createLivenessSweeper(deps).sweepOnce();

  assert.equal(summary.rooms_with_errors, 1);
  assert.equal(summary.announced_offline, 1);
  assert.equal(emitted[0]?.roomId, "focus_34");
});

test("sweepOnce announces recoveries for previously announced outages", async () => {
  const recovered = buildSession({
    active_connection_count: 1,
    updated_at: new Date(NOW - 10_000).toISOString(),
    last_disconnected_at: isoMinutesAgo(10),
    reconnect_grace_expires_at: null,
    offline_announced_at: isoMinutesAgo(8),
  });
  const { deps, emitted } = buildFakeDeps({ candidates: [candidate(recovered)] });
  const summary = await createLivenessSweeper(deps).sweepOnce();

  assert.equal(summary.announced_recovered, 1);
  assert.ok(emitted[0]!.text.includes("back online"));
});
