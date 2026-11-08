<template>
  <main class="receipts-harness room-tab-page room-chat-page">
    <div class="room-chat-layout">
      <div class="room-chat-main">
        <RoomMessageViewport
          :active="true"
          :active-search-message-id="null"
          :active-thread-parent-id="null"
          :has-older-messages="false"
          :loading-older-messages="false"
          :older-messages-error="null"
          :messages="messages"
          :thread-messages="[]"
          :message-namespace="`harness:${ROOM}`"
          :local-agent-work="[]"
          :delivery-receipts-by-message="{}"
          :has-filtered-room-activity="false"
          :room-identifier="ROOM"
          :github-activity-available="false"
          :room-loading="false"
          search-query=""
          :task-reference-ids="new Set()"
          :initial-scroll-position="null"
        />
      </div>
    </div>
    <RoomMessageReceiptPopover
      :room-identifier="ROOM"
      :participants="participants"
      :supervisor-entries="[]"
      :mention-for="(key, name) => `@${name}`"
      :message-link="(id) => `https://letagents.chat/r/${ROOM}/${id}`"
      @scroll-to-message="(id) => document.querySelector(`[data-message-id='${id}']`)?.scrollIntoView({ block: 'center' })"
      @ask="ask"
    />
  </main>
</template>

<script setup lang="ts">
import { computed, shallowRef } from "vue";
import RoomMessageViewport from "../../renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue";
import RoomMessageReceiptPopover from "../../renderer/src/components/desktop/content/room-chat/RoomMessageReceiptPopover.vue";
import { invalidateRoomMessageReceipts, provideRoomMessageReceipts, useRoomMessageReceipts } from "../../renderer/src/composables/useRoomMessageReceipts";
import { setMessageReactionViewer } from "../../renderer/src/composables/useRoomMessageReactions";
import { ROOM, messages as seed, participants, receipts } from "./fake-receipts";

const document = window.document;
setMessageReactionViewer({ login: "EmmyMay", displayName: "EmmyMay", avatarUrl: null } as never);
provideRoomMessageReceipts(useRoomMessageReceipts(computed(() => ROOM)));
const messages = shallowRef(seed);

// QuartzPeak answers seven seconds in, and Kemi reads the @everyone message: both arrive as one invalidation.
setTimeout(() => {
  const receipt = receipts.get("msg_103")!;
  const quartz = receipt.agents.find((agent) => agent.displayName === "QuartzPeak")!;
  quartz.state = "replied"; quartz.finishedAt = new Date().toISOString(); quartz.replyMessageId = "msg_107";
  receipt.readers.push({ name: "Kemi", avatarUrl: null, readAt: new Date().toISOString() });
  receipt.notRead = receipt.notRead!.filter((person) => person.name !== "Kemi");
  const reply = { ...seed[3]!, id: "msg_107", sender: "QuartzPeak", text: "Search API is green on staging. p95 is 180 ms.", timestamp: new Date().toISOString(),
    agentIdentity: { ...seed[3]!.agentIdentity!, name: "quartzpeak", displayName: "QuartzPeak", ideLabel: "Claude Code", agentKey: "emmymay/desktop-claude-code-quartzpeak" } };
  const list = [...messages.value]; list.splice(4, 0, reply); messages.value = list;
  invalidateRoomMessageReceipts(ROOM);
}, 7000);

function ask(messageId: string, target: { agentKey: string; displayName: string; mention: string }, done: (sent: boolean) => void): void {
  setTimeout(() => {
    const id = `msg_${200 + messages.value.length}`;
    messages.value = [...messages.value, { ...seed[0]!, id, text: target.mention, timestamp: new Date().toISOString(), threadRootId: id,
      replyTo: { id: messageId, sender: "EmmyMay", text: "hellooooo ?", source: "browser", timestamp: seed[5]!.timestamp, agentIdentity: null } }];
    receipts.set(id, { messageId: id, sentAt: new Date().toISOString(), agents: [{
      agentKey: target.agentKey, displayName: target.displayName, provider: participants.find((p) => p.agentKey === target.agentKey)?.ideLabel ?? null,
      ownerName: "EmmyMay", mine: true, state: "responding", activationReason: "explicit_mention", activationReasonLabel: "Mentioned directly",
      replyMessageId: null, askedAt: new Date().toISOString(), finishedAt: null }], readers: [], notRead: null, noWake: null });
    done(true);
  }, 400);
}
</script>

<style>
html, body, #app { height: 100%; margin: 0; }
body { background: var(--bg, #0a0a0a); }
.receipts-harness { min-height: 0; height: 100vh; display: flex; flex-direction: column; }
.receipts-harness .room-chat-layout { flex: 1; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr); }
</style>
