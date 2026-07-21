import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { roomAgentActivityProjection, roomAgentDeliveryGroup, roomAgentDeliverySummary } from "../src/domain/room-agent-delivery";
import { roomMessageRevealDestination } from "../src/domain/room-message-reveal";

const rendererRoot = fileURLToPath(new URL("..", import.meta.url));

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${rendererRoot}/`), "utf8");
}

describe("durable room delivery UI contracts", () => {
  it("classifies connection, inbox, and turn facts without inferring work from connection", () => {
    const state = (connection: string, inbox: string, turn: string) => ({
      roomAgentState: {
        connection: { state: connection, detail: null },
        inbox: { state: inbox, pendingCount: 0 },
        turn: { state: turn, detail: null, sourceMessageId: null },
        task: { state: "none", title: null },
      },
    });
    assert.equal(roomAgentDeliveryGroup(state("connected", "empty", "idle") as never), "listening");
    assert.equal(roomAgentDeliveryGroup(state("connected", "queued", "responding") as never), "responding");
    assert.equal(roomAgentDeliveryGroup(state("connected", "blocked", "idle") as never), "attention");
    assert.equal(roomAgentDeliveryGroup(state("connected", "blocked", "responding") as never), "attention");
    assert.equal(roomAgentDeliveryGroup(state("connected", "waiting_for_desktop_credentials", "idle") as never), "attention");
    assert.equal(roomAgentDeliveryGroup(state("reconnecting", "queued", "responding") as never), "disconnected");
    assert.equal(roomAgentDeliveryGroup(state("disconnected", "queued", "responding") as never), "disconnected");
    assert.equal(roomAgentDeliverySummary((state("connected", "waiting_for_desktop_credentials", "idle") as never).roomAgentState), "Waiting for desktop credential handoff");
    assert.equal(roomAgentDeliverySummary((state("reconnecting", "queued", "idle") as never).roomAgentState), "Reconnecting");
    assert.equal(roomAgentDeliverySummary((state("connected", "blocked", "responding") as never).roomAgentState), "Delivery needs attention");
  });

  it("deduplicates only matching projected legacy roster rows and retains mixed rollout rows", async () => {
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
    assert.match(activity, /roomAgentActivityProjection\(props\.supervisorEntries, props\.roomIdentifier\)/);
    assert.match(activity, /!hasLiveActivity/);
    assert.match(activity, /projectedSessionIds/);
    assert.match(activity, /legacyReachableAgents/);
    assert.match(activity, /legacyWorkingAgents/);
    for (const group of ["listening", "responding", "attention", "disconnected"]) {
      assert.match(activity, new RegExp(`key: "${group}"`));
    }
    assert.match(activity, /Connection<\/span>/);
    assert.match(activity, /Inbox<\/span>/);
    assert.match(activity, /Current turn<\/span>/);
    assert.match(activity, /Assigned work<\/span>/);
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
    for (const content of [shell, chat, viewport, thread]) {
      assert.match(content, /delivery-receipts/);
    }
    assert.match(shell, /desktopIpc\.supervisor\?\.retryRoomDelivery/);
    assert.match(shell, /Delivery retry accepted\. The agent is resuming delivery/);
    assert.match(message, /:disabled="!deliveryRecoveryAvailable \|\| retryingReceipt/);
    assert.match(message, /Retry will be available when delivery recovery is connected/);
    assert.match(message, /scroll-to-message', receipt\.blockedByMessageId/);
    assert.match(viewport, /emit\("reveal-message", messageId\)/);
    assert.match(chat, /emit\("reveal-message", messageId\)/);
    assert.match(shell, /emit\("message-reveal-unavailable", messageId\)/);
    assert.match(app, /handleRoomMessageRevealUnavailable/);
  });
});
