import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { roomAgentDeliveryGroup } from "../src/domain/room-agent-delivery";

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
    assert.equal(roomAgentDeliveryGroup(state("connected", "idle", "idle") as never), "listening");
    assert.equal(roomAgentDeliveryGroup(state("connected", "pending", "responding") as never), "responding");
    assert.equal(roomAgentDeliveryGroup(state("connected", "blocked", "idle") as never), "attention");
    assert.equal(roomAgentDeliveryGroup(state("disconnected", "pending", "responding") as never), "disconnected");
  });

  it("uses the supervised projection as the sole truthful roster and retains legacy fallback only when absent", async () => {
    const activity = await source("src/components/desktop/content/RoomActivityTabView.vue");
    assert.match(activity, /entry\.roomId === props\.roomIdentifier && entry\.roomAgentState/);
    assert.match(activity, /!liveRosterAgents\.length && !truthfulAgents\.length/);
    assert.match(activity, /!truthfulAgents\.length && reachableAgents\.length/);
    assert.match(activity, /!truthfulAgents\.length && workingAgents\.length/);
    for (const group of ["listening", "responding", "attention", "disconnected"]) {
      assert.match(activity, new RegExp(`key: "${group}"`));
    }
    assert.match(activity, /Connection<\/span>/);
    assert.match(activity, /Inbox<\/span>/);
    assert.match(activity, /Current turn<\/span>/);
    assert.match(activity, /Assigned work<\/span>/);
  });

  it("carries grouped receipts and typed retry/link events across chat surfaces", async () => {
    const [shell, chat, viewport, thread, message] = await Promise.all([
      source("src/components/desktop/content/DesktopRoomShell.vue"),
      source("src/components/desktop/content/RoomChatView.vue"),
      source("src/components/desktop/content/room-chat/RoomMessageViewport.vue"),
      source("src/components/desktop/content/room-chat/RoomThreadPanel.vue"),
      source("src/components/desktop/content/DesktopChatMessage.vue"),
    ]);
    assert.match(shell, /\(grouped\[receipt\.sourceMessageId\] \?\?= \[\]\)\.push/);
    for (const content of [shell, chat, viewport, thread]) {
      assert.match(content, /delivery-receipts/);
      assert.match(content, /retry-delivery/);
    }
    assert.match(message, /type="button"/);
    assert.match(message, /aria-label="`Retry delivery for \$\{receipt\.agentName\}`"/);
    assert.match(message, /scroll-to-message', receipt\.blockedByMessageId/);
  });
});
