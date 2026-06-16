import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-desktop-managed-agents-"));
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");

const {
  bindCodexLiveSessionToWorker,
  getCurrentCodexLiveSession,
  getOrCreateDesktopHostId,
  getStoredAgentIdentity,
  getStoredAgentSession,
  listDesktopManagedCodexLiveSessions,
  listCodexDisplayNamesForRoom,
  listStoredCodexLiveSessions,
  managedAgentDeliveryMode,
  saveAgentSession,
  saveCodexLiveSession,
  saveStoredAgentIdentity,
  toPublicManagedAgentSession,
} = await import("../main/agents/state.js");
const {
  canDeliverDesktopEventToSession,
  isOwnRoomStreamEvent,
  isStopPhraseRoomStreamEvent,
  shouldDeliverRoomStreamEventToSession,
} = await import("../main/agents/codex-event-routing.js");
const { buildCodexStartPrompt } = await import("../main/agents/codex-start-prompt.js");
const { buildDesktopEventPrompt } = await import("../main/agents/codex-event-prompt.js");
const { codexInstallCommand } = await import("../main/agents/codex-install.js");
const {
  codexSessionStatusAfterInspectFailure,
  codexSessionStatusAfterTurnInterrupt,
  codexSessionStatusAfterStopAttempt,
  deriveCodexLiveSessionStatus,
  finalPublicAgentMessageText,
  isActiveCodexTurnStatus,
  parseStartupObservationMs,
  shouldShutdownManagedAgentOnStop,
  summarizeItems,
} = await import("../main/agents/codex-session-status.js");
const {
  summarizeCodexReasoningNotification,
  summarizeCodexRuntimeNotification,
} = await import("../main/agents/codex-runtime-reasoning.js");
const { suggestLetAgentsCodename } = await import("../main/agents/codenames.js");
const { CodexRpcClient } = await import("../main/agents/codex-rpc-client.js");
const {
  codexAppServerLaunchArgs,
  launchCodexAppServer,
  waitForLaunchedCodexAppServer,
} = await import("../main/agents/codex-app-server.js");
const { DEFAULT_CODEX_DELIVERY_MODE } = await import("../main/agents/defaults.js");
const { providerSetupConfirmationResult } = await import("../main/agents/provider-setup-confirmation.js");
const { agentProviderMcpInstallOptions } = await import("../main/agents/provider-setup-options.js");

import type { DesktopRoomStreamEvent, DesktopTaskSummary } from "../ipc-types.js";
import type { DesktopCodexLiveSessionState } from "../main/agents/state.js";

test.after(() => {
  delete process.env.LETAGENTS_STATE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

function resetState(state: Record<string, unknown> = {}): void {
  writeFileSync(process.env.LETAGENTS_STATE_PATH ?? "", `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function liveSession(
  overrides: Partial<DesktopCodexLiveSessionState> = {},
): DesktopCodexLiveSessionState {
  return {
    session_id: "local_session_1",
    room_id: "room_1",
    room_identifier: "room_1",
    room_display_name: "Room One",
    joined_via: "join_room",
    cwd: "/tmp/repo",
    stop_phrase: "/stop-codex-room",
    max_minutes: 0,
    delivery_mode: "desktop_events",
    deadline_utc: null,
    token: "LOCAL_CODEX_ROOM_test",
    thread_id: "thread_1",
    turn_id: "turn_1",
    server_url: "http://127.0.0.1:5999",
    server_pid: null,
    launched_server: false,
    codex_bin: "codex",
    agent_session_id: null,
    reasoning_session_id: "reasoning_1",
    status: "running",
    last_error: null,
    started_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-14T12:00:00.000Z",
    ...overrides,
  };
}

function taskSummary(
  overrides: Partial<DesktopTaskSummary> = {},
): DesktopTaskSummary {
  return {
    id: "task_1",
    title: "Route local worker task update",
    description: null,
    status: "accepted",
    assignee: null,
    assigneeAgentKey: null,
    createdBy: "Emmy",
    prUrl: null,
    workflowArtifacts: [],
    workflowRefs: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:00:00.000Z",
    ...overrides,
  };
}

test("desktop Codex runtime reasoning summaries accumulate readable app-server deltas", () => {
  const params = { threadId: "thread_reasoning", turnId: "turn_reasoning", itemId: "item_reasoning" };

  const part = summarizeCodexReasoningNotification({
    method: "item/reasoning/summaryPartAdded",
    params: { ...params, summaryIndex: 0 },
  });
  assert.equal(part?.summary, "Codex started a new reasoning summary section.");

  const first = summarizeCodexReasoningNotification({
    method: "item/reasoning/summaryTextDelta",
    params: { ...params, summaryIndex: 0, delta: "Checking the desktop " },
  });
  const second = summarizeCodexReasoningNotification({
    method: "item/reasoning/summaryTextDelta",
    params: { ...params, summaryIndex: 0, delta: "reasoning bridge." },
  });

  assert.equal(first?.summary, "Checking the desktop");
  assert.equal(second?.summary, "Checking the desktop reasoning bridge.");
  assert.equal(second?.status, "working");
  assert.match(second?.checking ?? "", /readable reasoning summary/);
});

test("desktop Codex runtime reasoning hides raw app-server reasoning text", () => {
  const summary = summarizeCodexRuntimeNotification({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread_raw_reasoning",
      turnId: "turn_raw_reasoning",
      itemId: "item_raw_reasoning",
      contentIndex: 0,
      delta: "private raw reasoning should not leak",
    },
  });

  assert.equal(summary.summary, "Codex raw reasoning text is streaming.");
  assert.doesNotMatch(summary.checking, /private raw reasoning/);
  assert.doesNotMatch(summary.next_action, /private raw reasoning/);
});

test("desktop managed worker identity and session state are persisted for room surfaces", () => {
  resetState();

  const hostId = getOrCreateDesktopHostId();
  const identity = saveStoredAgentIdentity({
    name: "cedar-vista",
    display_name: "CedarVista",
    owner_label: "EmmyMay",
    owner_attribution: "EmmyMay's agent",
    ide_label: "Codex",
    actor_label: "CedarVista | EmmyMay's agent | Codex",
    canonical_key: "EmmyMay/cedar-vista",
    runtime_key: "desktop-codex",
    source: "api",
    resolved_at: "2026-06-14T12:00:00.000Z",
  });
  const session = saveAgentSession({
    session_id: "worker_desktop",
    session_token: "token_desktop",
    room_id: "room_1",
    session_kind: "worker",
    runtime: "codex:LOCAL_CODEX_ROOM_test",
    host_id: hostId,
    host_kind: "macos",
    host_label: "LetAgents Desktop",
    liveness_capability: "desktop_supervised_codex_app_server",
    tool_bridge_id: `${hostId}:codex:desktop`,
    actor_label: identity.actor_label,
    agent_key: identity.canonical_key,
    agent_instance_id: "desktop-codex:LOCAL_CODEX_ROOM_test",
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    ide_label: "Codex",
    created_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-14T12:00:00.000Z",
    last_seen_at: "2026-06-14T12:00:00.000Z",
    ended_at: null,
  });

  assert.equal(getOrCreateDesktopHostId(), hostId);
  assert.deepEqual(getStoredAgentIdentity(), identity);
  assert.deepEqual(getStoredAgentSession("worker_desktop"), session);

  const publicSession = toPublicManagedAgentSession(liveSession({
    agent_session_id: "worker_desktop",
    display_name: "CedarVista",
  }));
  assert.equal(publicSession.agentSessionId, "worker_desktop");
  assert.equal(publicSession.actorLabel, "CedarVista | EmmyMay's agent | Codex");
  assert.equal(publicSession.agentKey, "EmmyMay/cedar-vista");
});

test("managed Codex state binds a live desktop session to the registered worker identity", () => {
  resetState({
    agent_sessions: {
      controller_1: {
        session_id: "controller_1",
        room_id: "room_1",
        session_kind: "controller",
        runtime: "codex",
        created_at: "2026-06-14T12:00:01.000Z",
      },
      worker_1: {
        session_id: "worker_1",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex",
        actor_label: "MapleRidge",
        agent_key: "codex",
        display_name: "MapleRidge",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:01.000Z",
        updated_at: "2026-06-14T12:00:02.000Z",
      },
    },
    current_agent_session_ids: {
      room_1: "worker_1",
    },
  });

  const saved = saveCodexLiveSession(liveSession());
  const bound = bindCodexLiveSessionToWorker(saved);
  const publicSession = toPublicManagedAgentSession(bound);

  assert.equal(bound.agent_session_id, "worker_1");
  assert.equal(publicSession.agentSessionId, "worker_1");
  assert.equal(publicSession.actorLabel, "MapleRidge");
  assert.equal(publicSession.displayName, "MapleRidge");
  assert.equal(publicSession.ownerLabel, "Local desktop");
  assert.equal(publicSession.ideLabel, "Codex");
  assert.equal(publicSession.deliveryMode, "desktop_events");
  assert.equal(publicSession.canStop, true);
});

test("managed Codex state prefers the exact desktop runtime marker when multiple workers exist", () => {
  resetState({
    agent_sessions: {
      worker_other: {
        session_id: "worker_other",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex",
        actor_label: "CedarVista",
        agent_key: "codex",
        display_name: "CedarVista",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:01.000Z",
        updated_at: "2026-06-14T12:00:02.000Z",
      },
      worker_exact: {
        session_id: "worker_exact",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_test",
        actor_label: "MapleRidge",
        agent_key: "codex",
        display_name: "MapleRidge",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:02.000Z",
        updated_at: "2026-06-14T12:00:03.000Z",
      },
    },
  });

  const bound = bindCodexLiveSessionToWorker(saveCodexLiveSession(liveSession()));

  assert.equal(bound.agent_session_id, "worker_exact");
  assert.equal(toPublicManagedAgentSession(bound).displayName, "MapleRidge");
});

test("managed Codex worker binding normalizes room identifiers", () => {
  resetState({
    agent_sessions: {
      worker_exact: {
        session_id: "worker_exact",
        room_id: "abcd-1234",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_test",
        actor_label: "MapleRidge",
        agent_key: "codex/maple",
        display_name: "MapleRidge",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:02.000Z",
        updated_at: "2026-06-14T12:00:03.000Z",
      },
    },
  });

  const bound = bindCodexLiveSessionToWorker(saveCodexLiveSession(liveSession({
    room_id: "ABCD-1234",
    room_identifier: "ABCD-1234",
  })));

  assert.equal(bound.agent_session_id, "worker_exact");
  assert.equal(toPublicManagedAgentSession(bound).displayName, "MapleRidge");
});

test("managed Codex state does not guess a worker when startup candidates are ambiguous", () => {
  const session = liveSession({ display_name: null });
  resetState({
    agent_sessions: {
      worker_one: {
        session_id: "worker_one",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex",
        actor_label: "CedarVista",
        agent_key: "codex",
        display_name: "CedarVista",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:01.000Z",
        updated_at: "2026-06-14T12:00:02.000Z",
      },
      worker_two: {
        session_id: "worker_two",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex",
        actor_label: "DawnWinter",
        agent_key: "codex",
        display_name: "DawnWinter",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:02.000Z",
        updated_at: "2026-06-14T12:00:03.000Z",
      },
    },
    current_agent_session_ids: {
      room_1: "worker_two",
    },
  });

  const bound = bindCodexLiveSessionToWorker(saveCodexLiveSession(session));
  const publicSession = toPublicManagedAgentSession(bound);

  assert.equal(bound.agent_session_id, null);
  assert.equal(publicSession.agentSessionId, null);
  assert.equal(
    publicSession.displayName,
    suggestLetAgentsCodename(["CedarVista", "DawnWinter"], session.token),
  );
  assert.equal(publicSession.actorLabel, publicSession.displayName);
  assert.doesNotMatch(publicSession.displayName, /^Codex\b/i);
});

test("managed Codex startup binding rejects stale single-worker fallback", () => {
  const session = liveSession({
    session_id: "local_new",
    started_at: "2026-06-14T12:00:00.000Z",
  });
  resetState({
    agent_sessions: {
      worker_stale: {
        session_id: "worker_stale",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex",
        actor_label: "CedarVista",
        agent_key: "codex",
        display_name: "CedarVista",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T11:59:00.000Z",
        updated_at: "2026-06-14T11:59:01.000Z",
      },
    },
  });

  const saved = saveCodexLiveSession(session);
  assert.equal(bindCodexLiveSessionToWorker(saved).agent_session_id, null);
  assert.equal(
    bindCodexLiveSessionToWorker(saved, { allowStaleSingleCandidate: true }).agent_session_id,
    "worker_stale",
  );
  assert.equal(
    bindCodexLiveSessionToWorker(saved, { allowStaleSingleCandidate: false }).agent_session_id,
    null,
  );
});

test("managed Codex public state does not expose inactive worker identities", () => {
  resetState({
    agent_sessions: {
      worker_ended: {
        session_id: "worker_ended",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_test",
        actor_label: "CedarVista",
        agent_key: "codex/cedar",
        display_name: "CedarVista",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:01.000Z",
        updated_at: "2026-06-14T12:10:00.000Z",
        ended_at: "2026-06-14T12:10:00.000Z",
      },
    },
  });

  const publicSession = toPublicManagedAgentSession(liveSession({
    agent_session_id: "worker_ended",
    display_name: "CedarVista",
  }));

  assert.equal(publicSession.agentSessionId, null);
  assert.equal(publicSession.displayName, "CedarVista");
  assert.equal(publicSession.actorLabel, "CedarVista");
  assert.equal(publicSession.agentKey, "codex");

  resetState();
  const missingWorkerSession = toPublicManagedAgentSession(liveSession({
    agent_session_id: "worker_missing",
    display_name: "DawnWinter",
  }));

  assert.equal(missingWorkerSession.agentSessionId, null);
  assert.equal(missingWorkerSession.displayName, "DawnWinter");
  assert.equal(missingWorkerSession.actorLabel, "DawnWinter");
});

test("managed Codex sessions expose polling as the backward-compatible default delivery mode", () => {
  resetState();
  const session = liveSession({
    session_id: "local_session_default",
    delivery_mode: undefined,
    status: "completed",
  });

  assert.equal(managedAgentDeliveryMode(session), "mcp_polling");
  assert.equal(toPublicManagedAgentSession(session).deliveryMode, "mcp_polling");
  assert.equal(toPublicManagedAgentSession(session).canStop, false);
});

test("new desktop-managed Codex starts default to desktop-delivered events", () => {
  assert.equal(DEFAULT_CODEX_DELIVERY_MODE, "desktop_events");
});

test("desktop event sessions remain stoppable after an idle completed turn", () => {
  resetState();
  const session = liveSession({
    session_id: "local_session_events",
    delivery_mode: "desktop_events",
    status: "completed",
  });

  const publicSession = toPublicManagedAgentSession(session);

  assert.equal(publicSession.deliveryMode, "desktop_events");
  assert.equal(publicSession.canStop, true);
});

test("managed Codex sessions expose a persisted codename before worker binding", () => {
  resetState();
  const publicSession = toPublicManagedAgentSession(liveSession({
    agent_session_id: null,
    display_name: "MapleRidge",
  }));

  assert.equal(publicSession.actorLabel, "MapleRidge");
  assert.equal(publicSession.displayName, "MapleRidge");
  assert.equal(publicSession.agentKey, "codex");
  assert.equal(publicSession.ownerLabel, "Local desktop");
  assert.equal(publicSession.ideLabel, "Codex");
});

test("managed Codex sessions replace generic provider labels with deterministic codenames", () => {
  resetState({
    agent_sessions: {
      worker_generic: {
        session_id: "worker_generic",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_generic",
        actor_label: "Codex 1",
        agent_key: "codex",
        display_name: "Codex",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:01.000Z",
        updated_at: "2026-06-14T12:00:02.000Z",
      },
    },
  });

  const session = liveSession({
    agent_session_id: "worker_generic",
    display_name: null,
    token: "LOCAL_CODEX_ROOM_generic",
  });
  const publicSession = toPublicManagedAgentSession(session);

  assert.equal(publicSession.agentSessionId, "worker_generic");
  assert.equal(publicSession.displayName, suggestLetAgentsCodename([], session.token));
  assert.equal(publicSession.actorLabel, publicSession.displayName);
  assert.doesNotMatch(publicSession.displayName, /^Codex\b/i);
});

test("managed Codex session listing is scoped by room and sorted by latest update", () => {
  resetState();
  saveCodexLiveSession(liveSession({
    session_id: "older",
    room_id: "room_1",
    room_identifier: "room_1",
    updated_at: "2026-06-14T12:00:00.000Z",
  }));
  saveCodexLiveSession(liveSession({
    session_id: "newer",
    room_id: "room_1",
    room_identifier: "room_1",
    updated_at: "2026-06-14T12:10:00.000Z",
  }));
  saveCodexLiveSession(liveSession({
    session_id: "other_room",
    room_id: "room_2",
    room_identifier: "room_2",
    updated_at: "2026-06-14T12:20:00.000Z",
  }));

  assert.deepEqual(
    listStoredCodexLiveSessions("ROOM_1").map((session) => session.session_id),
    ["newer", "older"],
  );
  assert.equal(getCurrentCodexLiveSession("ROOM_1")?.session_id, "newer");
});

test("desktop managed session listing ignores legacy MCP live sessions", () => {
  resetState();
  saveCodexLiveSession(liveSession({
    session_id: "legacy_mcp",
    delivery_mode: undefined,
    desktop_managed: undefined,
    display_name: "OldMcpWorker",
    updated_at: "2026-06-14T12:10:00.000Z",
  }));
  saveCodexLiveSession(liveSession({
    session_id: "desktop_mcp",
    delivery_mode: "mcp_polling",
    desktop_managed: true,
    display_name: "MapleRidge",
    updated_at: "2026-06-14T12:20:00.000Z",
  }));

  assert.deepEqual(
    listStoredCodexLiveSessions("room_1").map((session) => session.session_id),
    ["desktop_mcp", "legacy_mcp"],
  );
  assert.deepEqual(
    listDesktopManagedCodexLiveSessions("room_1").map((session) => session.session_id),
    ["desktop_mcp"],
  );
});

test("managed Codex rooms can hold multiple distinct supervised workers", () => {
  resetState();
  saveCodexLiveSession(liveSession({
    session_id: "local_maple",
    token: "LOCAL_CODEX_ROOM_maple",
    display_name: "MapleRidge",
    thread_id: "thread_maple",
    turn_id: "turn_maple",
    updated_at: "2026-06-14T12:00:00.000Z",
  }));
  saveCodexLiveSession(liveSession({
    session_id: "local_cedar",
    token: "LOCAL_CODEX_ROOM_cedar",
    display_name: "CedarVista",
    thread_id: "thread_cedar",
    turn_id: "turn_cedar",
    updated_at: "2026-06-14T12:05:00.000Z",
  }));
  saveCodexLiveSession(liveSession({
    session_id: "local_dawn",
    token: "LOCAL_CODEX_ROOM_dawn",
    display_name: "DawnWinter",
    thread_id: "thread_dawn",
    turn_id: "turn_dawn",
    updated_at: "2026-06-14T12:10:00.000Z",
  }));

  const sessions = listStoredCodexLiveSessions("room_1");

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["local_dawn", "local_cedar", "local_maple"],
  );
  assert.deepEqual(
    sessions.map((session) => toPublicManagedAgentSession(session).displayName),
    ["DawnWinter", "CedarVista", "MapleRidge"],
  );
  assert.deepEqual(
    new Set(listCodexDisplayNamesForRoom("room_1")),
    new Set(["MapleRidge", "CedarVista", "DawnWinter"]),
  );
  assert.equal(getCurrentCodexLiveSession("room_1")?.session_id, "local_dawn");
});

test("Codex codename suggestions avoid visible room names without provider numbering", () => {
  resetState({
    codex_live_sessions: {
      local_existing: liveSession({
        session_id: "local_existing",
        display_name: "MapleRidge",
      }),
    },
    agent_sessions: {
      worker_existing: {
        session_id: "worker_existing",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_existing",
        actor_label: "CedarVista",
        display_name: "CedarVista",
        created_at: "2026-06-14T12:00:01.000Z",
      },
    },
  });

  const suggested = suggestLetAgentsCodename(listCodexDisplayNamesForRoom("room_1"), "stable-seed");

  assert.notEqual(suggested, "MapleRidge");
  assert.notEqual(suggested, "CedarVista");
  assert.doesNotMatch(suggested, /^Codex\s+\d+$/i);
  assert.doesNotMatch(suggested, /^Codex\b/i);
});

test("Codex start prompts distinguish MCP polling from desktop-delivered events", () => {
  const pollingPrompt = buildCodexStartPrompt({
    roomIdentifier: "github.com/example/repo",
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    deliveryMode: "mcp_polling",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: null,
    maxMinutes: 0,
  });
  const eventPrompt = buildCodexStartPrompt({
    roomIdentifier: "github.com/example/repo",
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    deliveryMode: "desktop_events",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "CedarVista",
    deadlineUtc: null,
    maxMinutes: 0,
  });

  assert.match(pollingPrompt, /Keep polling with wait_for_messages/);
  assert.match(pollingPrompt, /set_agent_name/);
  assert.match(pollingPrompt, /post_reasoning/);
  assert.match(pollingPrompt, /readable progress for the desktop UI/);
  assert.match(pollingPrompt, /Suggested codename: MapleRidge/);
  assert.match(pollingPrompt, /runtime="codex:LOCAL_CODEX_ROOM_test"/);
  assert.match(pollingPrompt, /MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor/);
  assert.match(pollingPrompt, /Treat this as your room identity/);
  assert.match(pollingPrompt, /Call set_agent_name with that chosen codename before posting status or registering/);
  assert.match(pollingPrompt, /Never call yourself Codex, Codex 1, Codex 2, or any numbered provider label/);
  assert.match(pollingPrompt, /Do not continue into the room loop until register_agent_session succeeds/);
  assert.match(pollingPrompt, /Call read_messages once, then call get_board once/);
  assert.match(pollingPrompt, /claim it with claim_task using the registered agent_session_id before entering the wait loop/);
  assert.match(pollingPrompt, /get_onboarding_status/);
  assert.match(eventPrompt, /Do not call wait_for_messages/);
  assert.match(eventPrompt, /already registered this room worker as CedarVista/);
  assert.match(eventPrompt, /Do not call LetAgents MCP room tools during bootstrap/);
  assert.match(eventPrompt, /NO_ROOM_REPLY/);
  assert.doesNotMatch(eventPrompt, /set_agent_name/);
  assert.doesNotMatch(eventPrompt, /register_agent_session/);
  assert.doesNotMatch(eventPrompt, /get_onboarding_status/);
  assert.match(eventPrompt, /desktop app will send room events/);
});

test("Codex start prompts JSON-escape unusual room names", () => {
  const prompt = buildCodexStartPrompt({
    roomIdentifier: 'github.com/example/repo "staging"',
    joinedVia: "join_room",
    cwd: "/tmp/repo",
    deliveryMode: "mcp_polling",
    stopPhrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    suggestedDisplayName: "MapleRidge",
    deadlineUtc: null,
    maxMinutes: 0,
  });

  assert.match(
    prompt,
    /join_room with \{"name":"github\.com\/example\/repo \\"staging\\"","session_mode":"current"\}/,
  );
});

test("desktop-delivered event prompts include stop handling without resuming MCP polling", () => {
  const prompt = buildDesktopEventPrompt(liveSession({
    stop_phrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
  }), {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_1",
      sender: "Emmy",
      text: "/stop-codex-room",
      attachments: [],
      agentPromptKind: null,
      source: "browser",
      timestamp: "2026-06-14T12:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      replyTo: null,
    },
  });

  assert.match(prompt, /exactly equals "\/stop-codex-room"/);
  assert.match(prompt, /LOCAL_CODEX_ROOM_test_DONE/);
  assert.match(prompt, /do not call wait_for_messages/);
  assert.match(prompt, /Do not call LetAgents MCP room tools/);
  assert.match(prompt, /desktop should publish as you/);
  assert.match(prompt, /Do not include hidden chain-of-thought/);
});

test("desktop event routing treats only the exact room stop phrase as a worker stop", () => {
  const session = liveSession({ stop_phrase: "/stop-codex-room" });
  const event: Extract<DesktopRoomStreamEvent, { type: "message" }> = {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_stop",
      sender: "Emmy",
      text: "/stop-codex-room",
      attachments: [],
      agentPromptKind: null,
      source: "room",
      timestamp: "2026-06-14T12:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      replyTo: null,
    },
  };

  assert.equal(isStopPhraseRoomStreamEvent(session, event), true);
  assert.equal(
    isStopPhraseRoomStreamEvent(session, {
      ...event,
      message: { ...event.message, text: " /stop-codex-room " },
    }),
    false,
  );
  assert.equal(
    isStopPhraseRoomStreamEvent(session, {
      type: "task_update",
      roomIdentifier: "room_1",
      task: taskSummary(),
    }),
    false,
  );
});

test("desktop-delivered event prompts preserve stable agent identity context", () => {
  const prompt = buildDesktopEventPrompt(liveSession({
    agent_session_id: "worker_local",
    display_name: "CedarVista",
    token: "LOCAL_CODEX_ROOM_local",
  }), {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_1",
      sender: "MapleRidge",
      text: "working on this",
      attachments: [],
      agentPromptKind: null,
      source: "agent",
      timestamp: "2026-06-14T12:00:00.000Z",
      actorLabel: "MapleRidge",
      agentIdentity: {
        name: "MapleRidge",
        displayName: "MapleRidge",
        ownerLabel: "Local desktop",
        ownerAttribution: "Local desktop's agent",
        ideLabel: "Codex",
        actorLabel: "MapleRidge",
        agentKey: "codex/maple-ridge",
        agentSessionId: "worker_exact",
      },
      replyTo: null,
    },
  });

  assert.match(prompt, /Registered agent_session_id: worker_local/);
  assert.match(prompt, /Display name: CedarVista/);
  assert.match(prompt, /Runtime marker: codex:LOCAL_CODEX_ROOM_local/);
  assert.match(prompt, /Agent key: codex\/maple-ridge/);
  assert.match(prompt, /Agent session: worker_exact/);
});

test("desktop-delivered event prompts keep reply follow-up in the room thread", () => {
  const prompt = buildDesktopEventPrompt(liveSession(), {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_reply",
      sender: "Emmy",
      text: "Can you check this branch?",
      attachments: [],
      agentPromptKind: null,
      source: "browser",
      timestamp: "2026-06-14T12:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      replyTo: {
        id: "msg_parent",
        sender: "MapleRidge",
        text: "I opened a PR.",
        source: "agent",
        timestamp: "2026-06-14T11:55:00.000Z",
      },
    },
  });

  assert.match(prompt, /Reply to: msg_parent from MapleRidge/);
  assert.match(prompt, /desktop will keep it in the same thread/);
});

test("desktop-delivered task prompts include assignment and workflow context", () => {
  const task: DesktopTaskSummary = {
    id: "task_7",
    title: "Wire desktop Codex events",
    description: "Make local Codex workers react to desktop-delivered room events.",
    status: "assigned",
    assignee: "MapleRidge",
    assigneeAgentKey: "codex/maple-ridge",
    createdBy: "Emmy",
    prUrl: "https://github.com/example/repo/pull/7",
    workflowArtifacts: [{
      provider: "github",
      kind: "pull_request",
      id: "pr_7",
      number: 7,
      title: "Desktop Codex events",
      url: "https://github.com/example/repo/pull/7",
      ref: "codex/desktop-events",
      state: "open",
    }],
    workflowRefs: [{
      provider: "github",
      kind: "pull_request",
      label: "PR #7",
      url: "https://github.com/example/repo/pull/7",
    }],
    activeLeases: [{
      id: "lease_7",
      kind: "work",
      holderLabel: "MapleRidge",
      agentKey: "codex/maple-ridge",
      agentSessionId: "worker_exact",
      status: "active",
      updatedAt: "2026-06-14T12:10:00.000Z",
    }],
    activeLocks: [{
      id: "lock_7",
      scope: "task",
      reason: "review",
      message: "Review in progress",
      createdBy: "CedarVista",
    }],
    stalePromptState: {
      isStale: true,
      reason: "worker idle",
      staleForMs: 120000,
      muted: false,
      mutedBy: null,
      mutedAt: null,
    },
    createdAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:12:00.000Z",
  };
  const prompt = buildDesktopEventPrompt(liveSession(), {
    type: "task_update",
    roomIdentifier: "room_1",
    task,
  });

  assert.match(prompt, /Event type: task_update/);
  assert.match(prompt, /Assignee agent key: codex\/maple-ridge/);
  assert.match(prompt, /holder=MapleRidge agentKey=codex\/maple-ridge agentSession=worker_exact/);
  assert.match(prompt, /Workflow refs:\n- github\/pull_request: PR #7 https:\/\/github\.com\/example\/repo\/pull\/7/);
  assert.match(prompt, /Workflow artifacts:\n- github\/pull_request #7 Desktop Codex events state=open/);
  assert.match(prompt, /Active locks:\n- task reason=review message=Review in progress createdBy=CedarVista/);
  assert.match(prompt, /Stale prompt: worker idle for 120000ms/);
  assert.match(prompt, /assigned or leased to you/);
  assert.match(prompt, /assigned or leased to another worker, finish quietly/);
  assert.match(prompt, /NO_ROOM_REPLY/);
  assert.match(prompt, /do not call wait_for_messages/);
});

test("desktop event routing suppresses a renamed worker's own messages by stable identity", () => {
  resetState({
    agent_sessions: {
      worker_exact: {
        session_id: "worker_exact",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_test",
        actor_label: "MapleRidge",
        agent_key: "codex/maple-ridge",
        display_name: "MapleRidge",
        owner_label: "Local desktop",
        ide_label: "Codex",
        created_at: "2026-06-14T12:00:01.000Z",
        updated_at: "2026-06-14T12:00:02.000Z",
      },
    },
  });

  const session = saveCodexLiveSession(liveSession({ agent_session_id: "worker_exact" }));
  const ownEvent: Extract<DesktopRoomStreamEvent, { type: "message" }> = {
    type: "message",
    roomIdentifier: "room_1",
    message: {
      id: "msg_own",
      sender: "Different Visible Sender",
      text: "status update",
      attachments: [],
      agentPromptKind: null,
      source: "agent",
      timestamp: "2026-06-14T12:00:00.000Z",
      actorLabel: "Different Visible Sender",
      agentIdentity: {
        name: "MapleRidge",
        displayName: "MapleRidge",
        ownerLabel: "Local desktop",
        ownerAttribution: "Local desktop's agent",
        ideLabel: "Codex",
        actorLabel: "Different Visible Sender",
        agentKey: "codex/maple-ridge",
        agentSessionId: "worker_exact",
      },
      replyTo: null,
    },
  };
  const otherEvent: Extract<DesktopRoomStreamEvent, { type: "message" }> = {
    ...ownEvent,
    message: {
      ...ownEvent.message,
      id: "msg_other",
      sender: "CedarVista",
      agentIdentity: {
        name: "CedarVista",
        displayName: "CedarVista",
        ownerLabel: "Local desktop",
        ownerAttribution: "Local desktop's agent",
        ideLabel: "Codex",
        actorLabel: "CedarVista",
        agentKey: "codex/cedar-vista",
        agentSessionId: "worker_other",
      },
    },
  };
  const genericOtherEvent: Extract<DesktopRoomStreamEvent, { type: "message" }> = {
    ...ownEvent,
    message: {
      ...ownEvent.message,
      id: "msg_generic_other",
      sender: "CedarVista",
      actorLabel: "CedarVista",
      agentIdentity: {
        name: "CedarVista",
        displayName: "CedarVista",
        ownerLabel: "Local desktop",
        ownerAttribution: "Local desktop's agent",
        ideLabel: "Codex",
        actorLabel: "CedarVista",
        agentKey: "codex",
        agentSessionId: "worker_other",
      },
    },
  };

  assert.equal(isOwnRoomStreamEvent(session, ownEvent), true);
  assert.equal(isOwnRoomStreamEvent(session, otherEvent), false);
  assert.equal(isOwnRoomStreamEvent(session, genericOtherEvent), false);
});

test("desktop event routing does not deliver queued events after a worker is stopped", () => {
  resetState({
    agent_sessions: {
      worker_exact: {
        session_id: "worker_exact",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_test",
        actor_label: "MapleRidge",
        agent_key: "codex/maple-ridge",
        display_name: "MapleRidge",
        created_at: "2026-06-14T12:00:01.000Z",
      },
    },
  });

  assert.equal(canDeliverDesktopEventToSession(liveSession({
    agent_session_id: "worker_exact",
    status: "running",
  })), true);
  assert.equal(canDeliverDesktopEventToSession(liveSession({
    agent_session_id: "worker_exact",
    status: "completed",
  })), true);
  assert.equal(canDeliverDesktopEventToSession(liveSession({
    agent_session_id: "worker_exact",
    status: "unknown",
  })), true);
  assert.equal(canDeliverDesktopEventToSession(liveSession({
    status: "running",
    token: "LOCAL_CODEX_ROOM_unregistered",
    started_at: "2026-06-14T12:30:00.000Z",
  })), false);
  assert.equal(canDeliverDesktopEventToSession(liveSession({
    agent_session_id: "worker_exact",
    status: "interrupted",
  })), false);
  assert.equal(canDeliverDesktopEventToSession(liveSession({
    agent_session_id: "worker_exact",
    status: "failed",
  })), false);
  assert.equal(canDeliverDesktopEventToSession(liveSession({
    agent_session_id: "worker_exact",
    delivery_mode: "mcp_polling",
    status: "running",
  })), false);
});

test("desktop task updates route only to the matching local worker when assigned or leased", () => {
  resetState({
    agent_sessions: {
      worker_maple: {
        session_id: "worker_maple",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_maple",
        actor_label: "MapleRidge",
        agent_key: "codex/maple",
        display_name: "MapleRidge",
        created_at: "2026-06-14T12:00:01.000Z",
      },
      worker_cedar: {
        session_id: "worker_cedar",
        room_id: "room_1",
        session_kind: "worker",
        runtime: "codex:LOCAL_CODEX_ROOM_cedar",
        actor_label: "CedarVista",
        agent_key: "codex/cedar",
        display_name: "CedarVista",
        created_at: "2026-06-14T12:00:02.000Z",
      },
    },
  });
  const maple = bindCodexLiveSessionToWorker(saveCodexLiveSession(liveSession({
    session_id: "local_maple",
    token: "LOCAL_CODEX_ROOM_maple",
  })));
  const cedar = bindCodexLiveSessionToWorker(saveCodexLiveSession(liveSession({
    session_id: "local_cedar",
    token: "LOCAL_CODEX_ROOM_cedar",
  })));

  const assignedEvent: Extract<DesktopRoomStreamEvent, { type: "task_update" }> = {
    type: "task_update",
    roomIdentifier: "room_1",
    task: taskSummary({
      assignee: "MapleRidge",
      assigneeAgentKey: "codex/maple",
    }),
  };
  const labelAssignedEvent: Extract<DesktopRoomStreamEvent, { type: "task_update" }> = {
    type: "task_update",
    roomIdentifier: "room_1",
    task: taskSummary({
      assignee: "CedarVista",
      assigneeAgentKey: null,
    }),
  };
  const leasedEvent: Extract<DesktopRoomStreamEvent, { type: "task_update" }> = {
    type: "task_update",
    roomIdentifier: "room_1",
    task: taskSummary({
      assignee: null,
      assigneeAgentKey: null,
      activeLeases: [{
        id: "lease_1",
        kind: "work",
        holderLabel: "CedarVista",
        agentKey: "codex/cedar",
        agentSessionId: "worker_cedar",
        status: "active",
        updatedAt: "2026-06-14T12:10:00.000Z",
      }],
    }),
  };
  const unassignedEvent: Extract<DesktopRoomStreamEvent, { type: "task_update" }> = {
    type: "task_update",
    roomIdentifier: "room_1",
    task: taskSummary(),
  };

  assert.equal(shouldDeliverRoomStreamEventToSession(maple, assignedEvent), true);
  assert.equal(shouldDeliverRoomStreamEventToSession(cedar, assignedEvent), false);
  assert.equal(shouldDeliverRoomStreamEventToSession(maple, labelAssignedEvent), false);
  assert.equal(shouldDeliverRoomStreamEventToSession(cedar, labelAssignedEvent), true);
  assert.equal(shouldDeliverRoomStreamEventToSession(maple, leasedEvent), false);
  assert.equal(shouldDeliverRoomStreamEventToSession(cedar, leasedEvent), true);
  assert.equal(shouldDeliverRoomStreamEventToSession(maple, unassignedEvent), true);
  assert.equal(shouldDeliverRoomStreamEventToSession(cedar, unassignedEvent), true);
});

test("turn interrupts keep desktop-event workers reusable unless shutdown is requested", () => {
  assert.equal(codexSessionStatusAfterTurnInterrupt("desktop_events", true, false), "running");
  assert.equal(codexSessionStatusAfterTurnInterrupt("desktop_events", false, false), "unknown");
  assert.equal(codexSessionStatusAfterTurnInterrupt("desktop_events", true, true), "interrupted");
  assert.equal(codexSessionStatusAfterTurnInterrupt("mcp_polling", true, false), "interrupted");
});

test("failed stop interrupts do not report desktop-event workers as cleanly reusable", () => {
  assert.equal(codexSessionStatusAfterStopAttempt("desktop_events", true, false, true), "running");
  assert.equal(codexSessionStatusAfterStopAttempt("desktop_events", true, false, false), "unknown");
  assert.equal(codexSessionStatusAfterStopAttempt("desktop_events", true, true, false), "interrupted");
  assert.equal(codexSessionStatusAfterStopAttempt("mcp_polling", true, false, false), "unknown");
  assert.equal(codexSessionStatusAfterStopAttempt("mcp_polling", false, false, false), "interrupted");
});

test("startup inspection failures keep Codex bootstrap in the starting state", () => {
  assert.equal(codexSessionStatusAfterInspectFailure("starting"), "starting");
  assert.equal(codexSessionStatusAfterInspectFailure("running"), "unknown");
  assert.equal(codexSessionStatusAfterInspectFailure("completed"), "completed");

  const previous = process.env.LETAGENTS_CODEX_STARTUP_OBSERVATION_MS;
  delete process.env.LETAGENTS_CODEX_STARTUP_OBSERVATION_MS;
  try {
    assert.equal(parseStartupObservationMs(), 90_000);
  } finally {
    if (previous === undefined) {
      delete process.env.LETAGENTS_CODEX_STARTUP_OBSERVATION_MS;
    } else {
      process.env.LETAGENTS_CODEX_STARTUP_OBSERVATION_MS = previous;
    }
  }
});

test("managed Codex stop modes distinguish stopping a turn from shutting down the worker", () => {
  assert.equal(shouldShutdownManagedAgentOnStop({ stopMode: "turn" }), false);
  assert.equal(shouldShutdownManagedAgentOnStop({ stopMode: "worker" }), true);
  assert.equal(shouldShutdownManagedAgentOnStop({ shutdownServer: true }), true);
  assert.equal(shouldShutdownManagedAgentOnStop({}), false);
});

test("active Codex turn statuses keep desktop event delivery from overlapping turns", () => {
  for (const status of ["inProgress", "active", "running", "queued", "pending", "cancelling"]) {
    assert.equal(isActiveCodexTurnStatus(status), true);
    assert.equal(deriveCodexLiveSessionStatus("completed", true, null, status), "running");
  }

  for (const status of ["completed", "interrupted", "failed", null]) {
    assert.equal(isActiveCodexTurnStatus(status), false);
  }
});

test("Codex inspection summaries expose only public transcript items", () => {
  const summaries = summarizeItems([
    { type: "userMessage", content: [{ text: "Please handle this room event." }] },
    { type: "reasoning", text: "private reasoning should not appear" },
    { type: "agentMessage", phase: "thinking", text: "private thinking should not appear" },
    { type: "toolCall", text: "tool details should not appear" },
    {
      type: "agentMessage",
      phase: "final",
      text: `Done. ${"x".repeat(600)}`,
    },
  ]);

  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[0], {
    type: "userMessage",
    text: "Please handle this room event.",
  });
  assert.equal(summaries[1]?.type, "agentMessage");
  assert.equal(summaries[1]?.phase, "final");
  assert.match(String(summaries[1]?.text), /^Done\. /);
  assert.match(String(summaries[1]?.text), /\.\.\.$/);
  assert.ok(String(summaries[1]?.text).length <= 420);
  assert.doesNotMatch(JSON.stringify(summaries), /private|tool details/);
});

test("Codex final reply extraction ignores private phases", () => {
  assert.equal(finalPublicAgentMessageText([
    { type: "agentMessage", phase: "thinking", text: "private thinking should not appear" },
    { type: "toolCall", text: "tool details should not appear" },
    { type: "agentMessage", phase: "commentary", text: "I am checking this." },
    { type: "agentMessage", phase: "final", text: "Done, I fixed it." },
  ]), "Done, I fixed it.");
  assert.equal(finalPublicAgentMessageText([
    { type: "agentMessage", phase: "thinking", text: "private thinking should not appear" },
  ]), null);
});

test("CodexRpcClient initializes app-server using the documented wire shape", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentMessages: Array<Record<string, unknown>> = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id?: number; method?: string };
      sentMessages.push(message);
      if (!message.id) {
        return;
      }
      const result = message.method === "thread/start"
        ? { thread: { id: "thread_1" } }
        : {};
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) });
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");
    await client.connect();
    await client.request("thread/start", {});
    client.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(sentMessages[0]?.method, "initialize");
  assert.equal(sentMessages[0]?.jsonrpc, undefined);
  assert.deepEqual((sentMessages[0]?.params as { clientInfo?: unknown } | undefined)?.clientInfo, {
    name: "letagents-desktop-codex-supervisor",
    title: "LetAgents Desktop Codex Supervisor",
    version: "0.1.0",
  });
  assert.equal(sentMessages[1]?.method, "initialized");
  assert.equal(sentMessages[1]?.jsonrpc, undefined);
  assert.equal(sentMessages[2]?.method, "thread/start");
  assert.equal(sentMessages[2]?.jsonrpc, undefined);
});

test("CodexRpcClient rejects requests when the app-server socket is not open", async () => {
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static readonly OPEN = 1;
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");

    await assert.rejects(
      () => client.request("thread/start", {}),
      /Codex app-server WebSocket is not open/,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("CodexRpcClient rejects connect when the app-server socket closes before opening", async () => {
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 3;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onclose?.());
    }

    send(): void {
      throw new Error("unexpected send");
    }

    close(): void {
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");

    await assert.rejects(
      () => client.connect(),
      /WebSocket closed connecting to ws:\/\/127\.0\.0\.1:4500/,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("CodexRpcClient rejects connect when the initialized notification fails", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentMessages: Array<Record<string, unknown>> = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id?: number; method?: string };
      sentMessages.push(message);
      if (!message.id) {
        throw new Error("initialized notification failed");
      }
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) });
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");

    await assert.rejects(
      () => client.connect(),
      /initialized notification failed/,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(sentMessages[0]?.method, "initialize");
  assert.equal(sentMessages[1]?.method, "initialized");
});

test("Codex app-server launcher captures spawn errors for the supervisor", async () => {
  const launch = launchCodexAppServer(
    "ws://127.0.0.1:1",
    "letagents-codex-missing-bin-for-test",
  );
  const exit = await launch.exited;

  assert.equal(exit.type, "error");
  if (exit.type !== "error") {
    assert.fail("Expected a spawn error from the missing Codex binary.");
  }
  assert.match(exit.error.message, /letagents-codex-missing-bin-for-test|ENOENT|spawn/i);
});

test("Codex app-server launcher trusts the selected managed worktree", () => {
  assert.deepEqual(codexAppServerLaunchArgs("ws://127.0.0.1:4500"), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
  assert.deepEqual(codexAppServerLaunchArgs("ws://127.0.0.1:4500", {
    trustedProjectPath: "/tmp/room-worktree",
  }), [
    "app-server",
    "-c",
    'projects."/tmp/room-worktree".trust_level="trusted"',
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
});

test("Codex app-server readiness wait fails on early launched-process errors", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error("not ready yet");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => waitForLaunchedCodexAppServer("ws://127.0.0.1:4500", {
        pid: 12345,
        exited: Promise.resolve({ type: "error", error: new Error("spawn ENOENT") }),
      }, 1_000),
      /Codex app-server exited before it became ready: spawn ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 1);
});

test("Codex install commands use official non-interactive installers", () => {
  const unix = codexInstallCommand("darwin");
  assert.equal(unix.command, "sh");
  assert.match(unix.args.join(" "), /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(unix.args.join(" "), /CODEX_NON_INTERACTIVE=1/);

  const windows = codexInstallCommand("win32");
  assert.equal(windows.command, "powershell.exe");
  assert.match(windows.args.join(" "), /https:\/\/chatgpt\.com\/codex\/install\.ps1/);
  assert.match(windows.args.join(" "), /CODEX_NON_INTERACTIVE=1/);
});

test("agent provider setup confirmation copy covers install actions", () => {
  const codexInstall = providerSetupConfirmationResult({
    id: "codex",
    name: "Codex",
  }, "install_runtime");
  assert.equal(codexInstall.success, false);
  assert.equal(codexInstall.action, "install_runtime");
  assert.match(codexInstall.message, /requires confirmation/i);
  assert.match(codexInstall.detail || "", /official Codex CLI runtime/i);

  const bridgeInstall = providerSetupConfirmationResult({
    id: "antigravity",
    name: "Antigravity",
  }, "install_mcp_bridge");
  assert.equal(bridgeInstall.success, false);
  assert.equal(bridgeInstall.action, "install_mcp_bridge");
  assert.match(bridgeInstall.message, /requires confirmation/i);
  assert.match(bridgeInstall.detail || "", /MCP configuration/i);
});

test("agent provider MCP setup preserves the selected repository cwd", () => {
  assert.deepEqual(
    agentProviderMcpInstallOptions({ repoRootPath: " /tmp/room-worktree " }),
    { cwd: "/tmp/room-worktree" },
  );
  assert.deepEqual(agentProviderMcpInstallOptions({ repoRootPath: " " }), {});
  assert.deepEqual(agentProviderMcpInstallOptions({ repoRootPath: null }), {});
});
