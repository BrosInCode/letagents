import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canReconnectRoomAgent,
  canRecoverSavedRoomAgent,
  roomAgentActivityProjection,
  roomAgentDeliveryGroup,
  roomAgentDeliverySummary,
} from "../src/domain/room-agent-delivery";
import { roomMessageRevealDestination } from "../src/domain/room-message-reveal";
import type {
  DesktopRoomAgentConnectionState,
  DesktopRoomAgentInboxState,
  DesktopRoomAgentTurnState,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";

const rendererRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${rendererRoot}/`), "utf8");
}

describe("durable room delivery UI contracts", () => {
  it("opens synthetic startup blockers in exact retained work and keeps real-message reveal", async () => {
    const shell = await source("src/components/desktop/content/DesktopRoomShell.vue");
    const handler = shell.slice(shell.indexOf("async function revealRoomMessage("), shell.indexOf("async function revealRecordedWorkMessage("))
      .replace("(messageId: string): Promise<void>", "(messageId)");
    const opened: Array<{ supervisorEntryId: string }> = [];
    const selected: string[] = [];
    const revealed: string[] = [];
    const unavailable: string[] = [];
    const initialTab = { value: "overview" };
    const revealedMessageId = { value: null as string | null };
    const reveal = new Function("supervisorEntries", "props", "emit", "openAgentDetailRequest",
      "agentInspectorInitialTab", "selectAgentInspectorWorkSource", "revealMessage", "revealedMessageId", "nextTick",
      `${handler}; return revealRoomMessage;`)(
      { value: [{ id: "agent-a", roomId: "room-a", displayName: "CedarRidge" },
        { id: "agent-b", roomId: "room-b", displayName: "CedarRidge" }] },
      { room: { identifier: "room-a" } }, (_event: string, id: string) => unavailable.push(id),
      (request: { supervisorEntryId: string }) => opened.push(request), initialTab,
      (id: string) => selected.push(id), async (id: string) => { revealed.push(id); return true; },
      revealedMessageId, async () => undefined,
    ) as (id: string) => Promise<void>;
    await reveal("desktop-initial-message:agent-a");
    assert.equal(opened[0]?.supervisorEntryId, "agent-a");
    assert.equal(initialTab.value, "work");
    assert.deepEqual(selected, ["desktop-initial-message:agent-a"]);
    assert.deepEqual(revealed, []);
    await reveal("desktop-initial-message:agent-b");
    assert.equal(opened.length, 1, "another room's agent cannot be opened");
    assert.deepEqual(unavailable, ["desktop-initial-message:agent-b"]);
    await reveal("message-real");
    assert.deepEqual(revealed, ["message-real"]);
    assert.equal(revealedMessageId.value, "message-real");
    const host = await source("src/components/desktop/content/agent-inspector/AgentInspectorHost.vue");
    const surface = await source("src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue");
    assert.match(host, /initialTab: props.initialTab/);
    assert.match(surface, /selectedTab.value = props.initialTab \?\? "overview"/);
  });

  it("classifies connection, inbox, and turn facts without inferring work from connection", () => {
    const state = (
      connection: DesktopRoomAgentConnectionState,
      inbox: DesktopRoomAgentInboxState,
      turn: DesktopRoomAgentTurnState,
    ): Pick<DesktopSupervisorManifestEntry, "roomAgentState"> => ({
      roomAgentState: {
        connection: { state: connection, observedAt: null, detail: null },
        ingress: {
          state: connection === "connected" ? "observing" : "stopped",
          observedAt: null,
          detail: null,
        },
        inbox: { state: inbox, pendingCount: 0, blockedByMessageId: null, detail: null },
        turn: { state: turn, inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
        task: { state: "none", taskId: null, title: null },
      },
    });
    assert.equal(roomAgentDeliveryGroup(state("connected", "empty", "idle")), "online");
    assert.equal(roomAgentDeliveryGroup(state("connected", "queued", "responding")), "responding");
    assert.equal(roomAgentDeliveryGroup(state("connected", "blocked", "idle")), "attention");
    assert.equal(roomAgentDeliveryGroup(state("connected", "blocked", "responding")), "attention");
    assert.equal(roomAgentDeliveryGroup(state("connected", "waiting_for_desktop_credentials", "idle")), "attention");
    assert.equal(roomAgentDeliveryGroup(state("connected", "restoring_conversation", "idle")), "restoring");
    assert.equal(roomAgentDeliveryGroup(state("reconnecting", "queued", "responding")), "disconnected");
    assert.equal(roomAgentDeliveryGroup(state("disconnected", "queued", "responding")), "disconnected");
    assert.equal(roomAgentDeliverySummary(state("connected", "waiting_for_desktop_credentials", "idle").roomAgentState!), "Waiting for desktop credential handoff");
    assert.equal(roomAgentDeliverySummary(state("reconnecting", "queued", "idle").roomAgentState!), "Reconnecting");
    assert.equal(roomAgentDeliverySummary(state("connected", "blocked", "responding").roomAgentState!), "Delivery needs attention");
    assert.equal(roomAgentDeliverySummary(state("connected", "empty", "idle").roomAgentState!), "Online");
  });

  it("keeps reconnect exact-runtime-only and routes all controls through the Inspector", async () => {
    const exact = {
      provider: "codex",
      deliveryMode: "daemon_inbox", desiredState: "running",
      observedState: "working", condition: "none",
      roomAgentState: { inbox: { state: "waiting_for_desktop_credentials" } },
      workAttemptId: "attempt_1", agentSessionId: "session_1", agentSessionBindingState: "active",
      executionGenerationId: "generation_1", providerContinuationId: "continuation_1",
      providerPid: 72_414, lastError: null, nativeLiveness: { state: "healthy" },
    };
    const gone = {
      ...exact, desiredState: "paused", observedState: "paused", workAttemptId: null, agentSessionId: null,
      agentSessionBindingState: "none", executionGenerationId: null, providerContinuationId: null,
    };
    const starting = {
      ...gone, desiredState: "running", observedState: "starting", condition: "none",
    };
    const stoppedRuntimeWithRetainedCoordinates = {
      ...exact,
      observedState: "failed",
      condition: "coordination_blocked",
      nativeLiveness: { state: "terminal" },
      roomAgentState: {
        connection: { state: "disconnected" },
        inbox: { state: "waiting_for_desktop_credentials" },
      },
    };
    const liveRuntimeWaitingForBinding = {
      ...exact,
      observedState: "recovering",
      condition: "coordination_blocked",
      providerPid: 72414,
      agentSessionId: null,
      agentSessionBindingState: "none",
      lastError: "The provider is running, but room access could not be restored after 3 attempts.",
      nativeLiveness: { state: "healthy" },
      roomAgentState: {
        connection: { state: "reconnecting" },
        inbox: { state: "waiting_for_desktop_credentials" },
      },
    };
    assert.equal(canReconnectRoomAgent(exact as never), true);
    assert.equal(canRecoverSavedRoomAgent(exact as never), false);
    assert.equal(canReconnectRoomAgent(gone as never), false);
    assert.equal(canRecoverSavedRoomAgent(gone as never), true);
    assert.equal(canRecoverSavedRoomAgent(starting as never), false,
      "a normal pre-runtime launch must not be presented as a recovery");
    assert.equal(canReconnectRoomAgent(stoppedRuntimeWithRetainedCoordinates as never), false,
      "retained provider coordinates do not make a stopped runtime reconnectable");
    assert.equal(canRecoverSavedRoomAgent(stoppedRuntimeWithRetainedCoordinates as never), true,
      "a durably stopped runtime is recoverable even while its historical coordinates remain");
    assert.equal(canReconnectRoomAgent(liveRuntimeWaitingForBinding as never), true,
      "a live exact provider can retry its room binding even before the replacement session is active");
    assert.equal(canReconnectRoomAgent({
      ...exact,
      provider: "cursor",
      providerPid: null,
    } as never), true, "a pid-less Cursor lane reconnects by exact durable continuation");

    const [activity, shell, inspectorDomain] = await Promise.all([
      source("src/components/desktop/content/RoomActivityTabView.vue"),
      source("src/components/desktop/content/DesktopRoomShell.vue"),
      source("src/domain/agent-inspector.ts"),
    ]);
    assert.doesNotMatch(activity, /desktop-room-agent-(?:reconnect|recover)|reconnect-room-agent|recover-room-agent/);
    assert.match(shell, /<AgentInspectorHost/);
    assert.match(inspectorDomain, /kind: "reconnect"/);
    assert.match(inspectorDomain, /kind: "recover"/);
  });

  it("deduplicates only matching supervised roster rows and leaves other participants inspectable", async () => {
    const stopped = {
      roomId: "focus_37",
      roomAgentState: { connection: { state: "disconnected" } },
      desiredState: "stopped",
      observedState: "stopped",
      agentSessionId: "agent_session_stale",
    };
    const running = {
      ...stopped,
      desiredState: "running",
      observedState: "working",
      agentSessionId: "agent_session_live",
    };
    const projection = roomAgentActivityProjection([stopped, running] as never, "focus_37");
    assert.deepEqual(projection.liveAgents, [running]);
    assert.deepEqual([...projection.projectedSessionIds], ["agent_session_stale", "agent_session_live"]);

    const activity = await source("src/components/desktop/content/RoomActivityTabView.vue");
    assert.match(activity, /const inspectorTruthfulAgents = computed\(\(\) =>/);
    assert.match(activity, /supervisedActivityIdentity\(\s*props\.agentProjections\.map/);
    assert.match(activity, /!hasLiveActivity/);
    assert.match(activity, /legacyReachableAgents/);
    assert.match(activity, /legacyWorkingAgents/);
    for (const group of ["online", "responding", "recovering", "reconnecting", "needs_attention", "starting", "paused", "disconnected", "status_unavailable"]) {
      assert.match(activity, new RegExp(`key: "${group}"`));
    }
    assert.match(activity, /agentInspectorActivityGroupState\(agent\)/);
    assert.match(activity, /group\.key === "status_unavailable" \? "Status unavailable" : agent\.overallLabel/);
    assert.match(activity, /agent\.resourceFreshness === 'stale'/);
    assert.match(activity, /selectInspectorAgent\(agent\)/);
    assert.match(activity, /selectParticipantAgent\(agent\)/);
  });

  it("presents Online activity with the same connected visual treatment", async () => {
    const [rosterStyles, sharedSurfaceStyles] = await Promise.all([
      source("src/styles/room-activity/groups-roster.css"),
      source("src/styles/surfaces/shared-surfaces.css"),
    ]);
    assert.match(rosterStyles, /\.desktop-activity-avatar\[data-state="online"\]/);
    assert.match(sharedSurfaceStyles, /\.state-pill\[data-state="online"\]/);
    assert.match(sharedSurfaceStyles, /\.state-pill\[data-state="responding"\]/);
  });

  it("presents retained structural work only as room History and reveals its source message", async () => {
    const [activity, shell] = await Promise.all([
      source("src/components/desktop/content/RoomActivityTabView.vue"),
      source("src/components/desktop/content/DesktopRoomShell.vue"),
    ]);
    assert.match(activity, /Retained structural outcomes — not live status\./);
    assert.match(activity, /data-testid="desktop-recorded-room-work"/);
    assert.match(activity, /recordedWorkEvidenceIncomplete\(work\)/);
    assert.match(activity, /Public structural history was cleared by its owner\./);
    assert.match(activity, /emit\('reveal-message', work\.sourceMessageId\)/);
    for (const [field, label] of [
      ["unresolved", "unresolved"],
      ["succeeded", "succeeded"],
      ["failed", "failed"],
      ["denied_before_start", "denied before start"],
      ["cancelled_before_start", "cancelled before start"],
      ["interrupted_after_start", "interrupted after start"],
      ["lost_after_start", "lost after start"],
    ]) {
      assert.match(activity, new RegExp(`counts\\.${field}`));
      assert.match(activity, new RegExp(label));
    }
    const liveActivityProjection = activity.match(/const hasLiveActivity = computed\(\(\) => Boolean\(([\s\S]*?)\n\)\);/)?.[1] || "";
    assert.doesNotMatch(liveActivityProjection, /roomAgentWork/);
    assert.match(shell, /async function revealRecordedWorkMessage[\s\S]*?activeTab\.value = "chat";[\s\S]*?revealRoomMessage\(messageId\)/);
  });

  it("routes loaded main and thread links directly, then requests bounded history for an unloaded target", () => {
    assert.deepEqual(
      roomMessageRevealDestination("main", [{ id: "main" }], []),
      { kind: "main" },
    );
    assert.deepEqual(
      roomMessageRevealDestination("reply", [], [{ id: "reply", threadRootId: "root" }]),
      { kind: "thread", threadRootId: "root" },
    );
    assert.deepEqual(roomMessageRevealDestination("unloaded", [], []), { kind: "history" });
  });

  it("hands a known cross-thread target to the mounted panel without a refresh RPC, and toasts absent failures", async () => {
    const [chat, shell, panel, messages] = await Promise.all([
      source("src/components/desktop/content/RoomChatView.vue"),
      source("src/components/desktop/content/DesktopRoomShell.vue"),
      source("src/components/desktop/content/room-chat/RoomThreadPanel.vue"),
      source("src/components/desktop/content/room-shell/useDesktopRoomMessages.ts"),
    ]);
    assert.match(chat, /threadRevealTargetId\.value = messageId/);
    assert.match(chat, /openThread\(destination\.threadRootId, false\)/);
    assert.doesNotMatch(chat, /pendingThreadRevealId/);
    assert.match(panel, /revealMessageId/);
    assert.match(panel, /jumpToThreadMessageReference\(messageId\)/);
    assert.match(messages, /async function revealMessage/);
    assert.match(messages, /maxExplicitMessageRevealPages/);
    assert.match(shell, /emit\("message-reveal-unavailable", messageId\)/);
  });

  it("carries grouped receipts, disabled retry capability, and reveal events across chat surfaces", async () => {
    const [app, shell, chat, viewport, thread, message] = await Promise.all([
      source("src/App.vue"),
      source("src/components/desktop/content/DesktopRoomShell.vue"),
      source("src/components/desktop/content/RoomChatView.vue"),
      source("src/components/desktop/content/room-chat/RoomMessageViewport.vue"),
      source("src/components/desktop/content/room-chat/RoomThreadPanel.vue"),
      source("src/components/desktop/content/DesktopChatMessage.vue"),
    ]);
    assert.match(shell, /\(grouped\[receipt\.sourceMessageId\] \?\?= \[\]\)\.push/);
    assert.match(shell, /supervisedAgentWorkIndicators/);
    for (const content of [shell, chat, viewport, thread]) {
      assert.match(content, /delivery-receipts/);
    }
    assert.match(shell, /desktopIpc\.supervisor\?\.retryRoomDelivery/);
    assert.match(shell, /Delivery retry accepted\. The agent is resuming delivery/);
    assert.match(message, /:disabled="!deliveryRecoveryAvailable \|\| retryingReceipt/);
    assert.match(message, /class="room-message-delivery-dots"/);
    assert.match(message, /aria-live="polite"/);
    assert.match(message, /"result_recovery"/);
    assert.doesNotMatch(message, /receiptIcon/);
    assert.match(message, /Retry will be available when delivery recovery is connected/);
    assert.match(message, /scroll-to-message', receipt\.blockedByMessageId/);
    assert.match(viewport, /emit\("reveal-message", messageId\)/);
    assert.match(chat, /emit\("reveal-message", messageId\)/);
    assert.match(shell, /emit\("message-reveal-unavailable", messageId\)/);
    assert.match(app, /handleRoomMessageRevealUnavailable/);
  });
});
