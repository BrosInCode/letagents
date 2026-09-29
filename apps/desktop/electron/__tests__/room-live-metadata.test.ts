import assert from "node:assert/strict";
import test from "node:test";

import { DesktopApiError } from "../main/auth.js";
import { loadSource } from "../main/rooms/snapshot/fetch-data.js";
import type { BoardSettingsResponse } from "../main/rooms/snapshot/payloads.js";
import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({
  prefix: "letagents-room-live-metadata-",
  paths: ["state", "localChatDb"],
});

const { buildRoomLiveMetadata, emptyRoomLiveMetadata, fetchRoomLiveMetadata } = await import(
  "../main/rooms/snapshot/metadata.js"
);

type RecordedFetch = { url: string; method: string };

/**
 * Replace globalThis.fetch with a recorder that answers the five poll-only
 * endpoints the metadata fetch talks to. `failPaths` returns a 500 for the
 * matching endpoint so per-source degradation can be exercised.
 */
function installFetchRecorder(options: {
  focusRooms?: unknown;
  participants?: unknown;
  presence?: unknown;
  activityHistory?: unknown;
  boardSettings?: unknown;
  failPaths?: string[];
}): { calls: RecordedFetch[]; restore: () => void } {
  const previous = globalThis.fetch;
  const calls: RecordedFetch[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ url, method });
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if ((options.failPaths ?? []).some((path) => url.includes(path))) {
      return json({ error: "boom", message: "server exploded" }, 500);
    }
    if (url.includes("/focus-rooms")) return json(options.focusRooms ?? { focus_rooms: [] });
    if (url.includes("/participants")) return json(options.participants ?? { participants: [], hidden_count: 0 });
    if (url.includes("/presence")) return json(options.presence ?? { presence: [] });
    if (url.includes("/activity-history")) return json(options.activityHistory ?? { entries: [] });
    if (url.includes("/board-settings")) return json(options.boardSettings ?? { pending_intent_count: 0 });
    return json({ error: `unexpected ${method} ${url}` }, 500);
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;
  return {
    calls,
    restore: () => {
      if (globalThis.fetch === stub) globalThis.fetch = previous;
    },
  };
}

test("buildRoomLiveMetadata maps every poll-only section and preserves per-source states", async () => {
  const metadata = buildRoomLiveMetadata("room_pure", {
    focusRooms: await loadSource(
      Promise.resolve({
        focus_rooms: [
          {
            room_id: "focus_1",
            name: "Focus one",
            display_name: "Focus one",
            code: null,
            source_task_id: null,
            focus_status: "active" as const,
            created_at: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      { focus_rooms: [] },
    ),
    participants: await loadSource(
      Promise.resolve({
        participants: [
          {
            participant_key: "human:emmy",
            kind: "human" as const,
            display_name: "EmmyMay",
            actor_label: null,
            activity_state: "active" as const,
            last_seen_at: "2026-07-01T00:00:00.000Z",
          },
        ],
        hidden_count: 3,
      }),
      { participants: [], hidden_count: 0 },
    ),
    presence: await loadSource(
      Promise.resolve({
        presence: [
          {
            room_id: "room_pure",
            actor_label: "agent:river",
            agent_key: "river",
            agent_instance_id: null,
            agent_session_id: null,
            session_kind: "worker" as const,
            runtime: "claude",
            display_name: "RiverRiver",
            owner_label: null,
            ide_label: null,
            status: "working" as const,
            status_text: null,
            last_heartbeat_at: "2026-07-01T00:00:00.000Z",
            freshness: "active" as const,
            activity_state: "active" as const,
          },
        ],
      }),
      { presence: [] },
    ),
    activityHistory: await loadSource(
      Promise.resolve({
        entries: [
          {
            id: "activity_1",
            participant: {
              display_name: "EmmyMay",
              kind: "human" as const,
              activity_state: "active" as const,
            },
            last_room_activity_at: "2026-07-01T00:00:00.000Z",
            current_tasks: [],
            completed_tasks: [],
          },
        ],
      }),
      { entries: [] },
    ),
    boardSettings: await loadSource<BoardSettingsResponse>(
      Promise.resolve({
        settings: { manager_mode: "intent_required" },
        active_manager: null,
        pending_intent_count: 5,
      }),
      { pending_intent_count: 0 },
    ),
  });

  assert.equal(metadata.roomIdentifier, "room_pure");
  assert.deepEqual(metadata.focusRooms.map((room) => room.roomId), ["focus_1"]);
  assert.equal(metadata.participants.length, 1);
  assert.equal(metadata.participantHiddenCount, 3);
  assert.equal(metadata.presence.length, 1);
  assert.equal(metadata.recentActivity.length, 1);
  assert.equal(metadata.boardSettings.managerMode, "intent_required");
  assert.equal(metadata.boardSettings.pendingIntentCount, 5);
  assert.deepEqual(
    Object.values(metadata.sourceStates).map((state) => state.status),
    ["ready", "ready", "ready", "ready", "ready"],
  );
});

test("focus snapshots load history and every resource from the canonical joined room", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  const requested = "focus_37";
  const canonical = "github.com/owner/project/focus/focus_37";
  const canonicalPath = encodeURIComponent(canonical);
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    if (init?.method === "POST" && path === `/rooms/${requested}/join`) {
      return json({ room_id: canonical, display_name: "Focus 37", kind: "focus", authenticated: true });
    }
    if (!path.startsWith(`/rooms/${canonicalPath}/`)) return json({ error: `unexpected ${path}` });
    if (path.endsWith("/messages")) return json({ messages: [{ id: "msg_1", sender: "Emmy", text: "Earlier context", timestamp: "2026-08-12T00:00:00.000Z" }] });
    if (path.endsWith("/focus-rooms")) return json({ focus_rooms: [] });
    if (path.endsWith("/tasks")) return json({ tasks: [] });
    if (path.endsWith("/participants")) return json({ participants: [], hidden_count: 0 });
    if (path.endsWith("/presence")) return json({ presence: [] });
    if (path.endsWith("/reasoning-sessions")) return json({ sessions: [] });
    if (path.endsWith("/activity-history")) return json({ entries: [] });
    if (path.endsWith("/artifacts")) return json({ artifacts: [] });
    if (path.endsWith("/board-settings")) return json({ pending_intent_count: 0 });
    if (path.endsWith("/events")) return json({ events: [], has_more: false });
    return json({ error: `unexpected ${path}` });
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = stub;
  try {
    const { fetchRoomSnapshot } = await import("../main/rooms/snapshot.js");
    const snapshot = await fetchRoomSnapshot(requested);
    assert.equal(snapshot.roomIdentifier, canonical);
    assert.deepEqual(snapshot.messages.map((message) => message.id), ["msg_1"]);
    assert.ok(calls.some((url) => url.includes(`/${canonicalPath}/messages?`)));
    assert.equal(calls.filter((url) => url.includes(`/rooms/${requested}/`) && !url.endsWith("/join")).length, 0);
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = previous;
  }
});

test("buildRoomLiveMetadata degrades a failed source to its fallback while recording the error", async () => {
  const metadata = buildRoomLiveMetadata("room_degraded", {
    focusRooms: await loadSource(Promise.resolve({ focus_rooms: [] }), { focus_rooms: [] }),
    participants: await loadSource(Promise.resolve({ participants: [], hidden_count: 0 }), {
      participants: [],
      hidden_count: 0,
    }),
    presence: await loadSource(
      Promise.reject(new DesktopApiError(500, { error: "boom", message: "presence exploded" })),
      { presence: [] },
    ),
    activityHistory: await loadSource(Promise.resolve({ entries: [] }), { entries: [] }),
    boardSettings: await loadSource(Promise.resolve({ pending_intent_count: 0 }), { pending_intent_count: 0 }),
  });

  assert.equal(metadata.sourceStates.presence.status, "error");
  assert.equal(metadata.sourceStates.presence.error, "presence exploded");
  // Failed source degrades to its empty fallback rather than blanking the whole fetch.
  assert.deepEqual(metadata.presence, []);
  assert.equal(metadata.sourceStates.participants.status, "ready");
});

test("fetchRoomLiveMetadata hits only the five poll-only endpoints and degrades per-source", async () => {
  const recorder = installFetchRecorder({
    focusRooms: {
      focus_rooms: [
        {
          room_id: "focus_e2e",
          name: "Focus e2e",
          display_name: "Focus e2e",
          code: null,
          source_task_id: null,
          focus_status: "active",
          created_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    },
    participants: {
      participants: [
        {
          participant_key: "human:emmy",
          kind: "human",
          display_name: "EmmyMay",
          actor_label: null,
          activity_state: "active",
          last_seen_at: "2026-07-01T00:00:00.000Z",
        },
      ],
      hidden_count: 2,
    },
    presence: { presence: [] },
    activityHistory: { entries: [] },
    failPaths: ["/board-settings"],
  });

  try {
    const metadata = await fetchRoomLiveMetadata("room_e2e");

    // Only the poll-only endpoints are requested — no messages/tasks/events/etc.
    const paths = recorder.calls.map((call) => new URL(call.url).pathname);
    assert.ok(paths.some((path) => path.endsWith("/focus-rooms")));
    assert.ok(paths.some((path) => path.endsWith("/participants")));
    assert.ok(paths.some((path) => path.endsWith("/presence")));
    assert.ok(paths.some((path) => path.endsWith("/activity-history")));
    assert.ok(paths.some((path) => path.endsWith("/board-settings")));
    for (const forbidden of ["/messages", "/tasks", "/events", "/artifacts", "/reasoning-sessions"]) {
      assert.ok(
        !paths.some((path) => path.includes(forbidden)),
        `metadata fetch must not request ${forbidden}`,
      );
    }

    assert.deepEqual(metadata.focusRooms.map((room) => room.roomId), ["focus_e2e"]);
    assert.equal(metadata.participantHiddenCount, 2);
    // Board settings endpoint 500'd → degrades to default with an error state.
    assert.equal(metadata.sourceStates.boardSettings.status, "error");
    assert.equal(metadata.boardSettings.managerMode, "manager_optional");
    assert.equal(metadata.boardSettings.pendingIntentCount, 0);
  } finally {
    recorder.restore();
  }
});

test("emptyRoomLiveMetadata returns all-ready empty poll-only sections", () => {
  const metadata = emptyRoomLiveMetadata("room_local");
  assert.equal(metadata.roomIdentifier, "room_local");
  assert.deepEqual(metadata.focusRooms, []);
  assert.deepEqual(metadata.participants, []);
  assert.deepEqual(metadata.presence, []);
  assert.deepEqual(metadata.recentActivity, []);
  assert.equal(metadata.boardSettings.managerMode, "manager_optional");
  assert.deepEqual(
    Object.values(metadata.sourceStates).map((state) => state.status),
    ["ready", "ready", "ready", "ready", "ready"],
  );
});
