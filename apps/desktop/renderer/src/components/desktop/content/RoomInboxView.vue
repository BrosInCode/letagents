<template>
  <section class="room-tab-page desktop-inbox-panel" data-testid="room-inbox-view">
    <header class="desktop-inbox-toolbar">
      <div class="desktop-inbox-title">
        <h3>Inbox</h3>
        <p>{{ summaryLabel }}</p>
      </div>

      <div class="desktop-inbox-actions">
        <div class="desktop-inbox-segmented" role="group" aria-label="Inbox filter">
          <button
            type="button"
            :data-active="filter === 'actionable'"
            :aria-pressed="filter === 'actionable'"
            @click="emit('update:filter', 'actionable')"
          >
            <Bell :size="14" />
            <span>Attention</span>
          </button>
          <button
            type="button"
            :data-active="filter === 'all'"
            :aria-pressed="filter === 'all'"
            @click="emit('update:filter', 'all')"
          >
            <Inbox :size="14" />
            <span>All</span>
          </button>
        </div>

        <button
          class="desktop-inbox-icon-button"
          type="button"
          aria-label="Refresh inbox"
          title="Refresh"
          :disabled="loading || loadingOlder"
          @click="emit('refresh')"
        >
          <RefreshCw :size="15" />
        </button>
      </div>
    </header>

    <div v-if="error" class="desktop-inbox-error" role="alert">
      <AlertTriangle :size="16" />
      <span>{{ error }}</span>
      <button type="button" @click="emit('refresh')">Retry</button>
    </div>

    <Transition name="desktop-inbox-undo-motion">
      <div v-if="lastClearedItem" class="desktop-inbox-undo" role="status">
        <span>Dismissed "{{ lastClearedItem.title }}"</span>
        <button type="button" @click="emit('restore-item', lastClearedItem)">Undo</button>
      </div>
    </Transition>

    <div v-if="loading && items.length === 0" class="desktop-inbox-loading-list" aria-label="Loading inbox">
      <div v-for="index in 6" :key="index" class="desktop-inbox-skeleton" aria-hidden="true">
        <span></span>
        <div>
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>

    <div v-else-if="!error && items.length === 0" class="desktop-inbox-empty">
      <Inbox :size="22" />
      <strong>{{ filter === "actionable" ? "Nothing needs your attention" : "No inbox history yet" }}</strong>
      <span>{{ filter === "actionable" ? "Unread threads, blocked work, failed checks, and reviews will appear here." : "Threads, tasks, checks, and agent updates will appear here as they happen." }}</span>
    </div>

    <div v-else-if="selectedItem" class="desktop-inbox-workspace">
      <aside class="desktop-inbox-queue-pane" aria-label="Inbox queue">
        <header class="desktop-inbox-queue-header">
          <div>
            <span>Queue</span>
            <strong>{{ items.length }}</strong>
          </div>
          <p>{{ filter === "actionable" ? "Items that may need a reply, fix, or review." : "Threads, tasks, checks, and agent updates in one list." }}</p>
        </header>

        <TransitionGroup name="desktop-inbox-row-motion" tag="div" class="desktop-inbox-list">
          <article
            v-for="item in items"
            :key="item.id"
            class="desktop-inbox-row"
            :data-kind="item.kind"
            :data-active="selectedItem.id === item.id"
            :data-actionable="item.actionable"
          >
            <button
              class="desktop-inbox-row-select"
              type="button"
              :aria-pressed="selectedItem.id === item.id"
              @click="selectItem(item)"
            >
              <span class="desktop-inbox-status-dot" aria-hidden="true"></span>

              <div class="desktop-inbox-icon" aria-hidden="true">
                <component :is="itemIcon(item)" :size="17" />
              </div>

              <div class="desktop-inbox-body">
                <div class="desktop-inbox-row-title">
                  <strong>{{ item.title }}</strong>
                  <span v-if="item.occurrenceCount > 1">{{ item.occurrenceCount }}x</span>
                </div>
                <p>{{ itemPreview(item) }}</p>
                <div class="desktop-inbox-meta">
                  <span>{{ itemSourceLabel(item) }}</span>
                  <span v-if="item.context">{{ item.context }}</span>
                </div>
              </div>
            </button>

            <div class="desktop-inbox-trailing">
              <time v-if="item.timestamp" class="desktop-inbox-time" :datetime="item.timestamp">
                {{ formatTimestamp(item.timestamp) }}
              </time>
              <button
                class="desktop-inbox-clear-pill"
                type="button"
                aria-label="Dismiss inbox item"
                @click.stop="clearItem(item)"
              >
                <X :size="13" />
                <span>Dismiss</span>
              </button>
            </div>
          </article>
        </TransitionGroup>
      </aside>

      <Transition name="desktop-inbox-detail-motion" mode="out-in">
        <article
          :key="selectedItem.id"
          class="desktop-inbox-detail"
          :data-kind="selectedItem.kind"
          :data-actionable="selectedItem.actionable"
        >
          <header class="desktop-inbox-detail-header">
            <div class="desktop-inbox-detail-icon desktop-inbox-icon" aria-hidden="true">
              <component :is="itemIcon(selectedItem)" :size="22" />
            </div>

            <div class="desktop-inbox-detail-title">
              <span>{{ itemKindLabel(selectedItem) }}</span>
              <h4>{{ selectedItem.title }}</h4>
              <p>{{ itemPreview(selectedItem) }}</p>
            </div>

            <div class="desktop-inbox-detail-badges">
              <span v-if="selectedItem.actionable">{{ selectedItem.kind === "thread" ? "New" : "Needs action" }}</span>
              <span v-if="selectedItem.occurrenceCount > 1">{{ selectedItem.occurrenceCount }} grouped</span>
            </div>
          </header>

          <div v-if="selectedItem.context" class="desktop-inbox-context-card">
            <span>Context</span>
            <p>{{ selectedItem.context }}</p>
          </div>

          <div class="desktop-inbox-detail-actions">
            <button
              v-if="selectedItem.kind !== 'agent_offline'"
              class="desktop-inbox-primary-action"
              type="button"
              @click="openItem(selectedItem)"
            >
              <ExternalLink :size="15" />
              <span>{{ openActionLabel(selectedItem) }}</span>
            </button>
            <button type="button" @click="clearItem(selectedItem)">
              <X :size="14" />
              <span>Dismiss item</span>
            </button>
          </div>

          <section class="desktop-inbox-detail-grid" aria-label="Inbox item details">
            <div v-for="row in itemDetailRows(selectedItem)" :key="row.label">
              <span>{{ row.label }}</span>
              <strong>{{ row.value }}</strong>
            </div>
          </section>

          <section class="desktop-inbox-activity" aria-label="Recent inbox activity">
            <header>
              <span>Recent activity</span>
              <strong>{{ activityCountLabel(selectedItem.activity.length) }}</strong>
            </header>
            <ol>
              <li
                v-for="activity in selectedItem.activity.slice(0, 6)"
                :key="activity.id"
                :data-tone="activity.tone"
              >
                <span aria-hidden="true"></span>
                <div>
                  <strong>{{ activity.label }}</strong>
                  <p v-if="activity.description">{{ activity.description }}</p>
                </div>
                <time v-if="activity.timestamp" :datetime="activity.timestamp">
                  {{ formatTimestamp(activity.timestamp) }}
                </time>
              </li>
            </ol>
          </section>

          <section v-if="selectedItem.kind === 'thread'" class="desktop-inbox-thread-summary">
            <header>
              <span>Thread participants</span>
              <strong>{{ selectedItem.summary.replyCount }} replies</strong>
            </header>
            <div class="desktop-inbox-participants" aria-label="Thread participants">
              <span
                v-for="participant in selectedItem.summary.participants.slice(0, 6)"
                :key="`${selectedItem.id}:${participant.sender}:${participant.source || 'unknown'}`"
                :title="participant.sender"
              >
                {{ initials(participant.sender) }}
              </span>
            </div>
          </section>

          <section class="desktop-inbox-why">
            <span>Why it matters</span>
            <p>{{ whyText(selectedItem) }}</p>
          </section>
        </article>
      </Transition>
    </div>

    <footer v-if="hasMore" class="desktop-inbox-footer">
      <button type="button" :disabled="loadingOlder" @click="emit('load-older')">
        {{ loadingOlder ? "Loading..." : "Load older" }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  ExternalLink,
  Inbox,
  MessageSquare,
  RefreshCw,
  X,
} from "@lucide/vue";
import { computed, ref } from "vue";
import { formatShortDateTime } from "../../../domain/time";
import type { DesktopInboxFilter, DesktopInboxItem } from "./room-inbox/items";

interface DetailRow {
  label: string;
  value: string;
}

const props = defineProps<{
  filter: DesktopInboxFilter;
  items: DesktopInboxItem[];
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  hasMore: boolean;
  lastClearedItem: DesktopInboxItem | null;
}>();

const emit = defineEmits<{
  "update:filter": [filter: DesktopInboxFilter];
  refresh: [];
  "load-older": [];
  "open-thread": [item: Extract<DesktopInboxItem, { kind: "thread" }>];
  "clear-item": [item: DesktopInboxItem];
  "restore-item": [item: DesktopInboxItem];
  "open-task": [taskId: string];
  "open-github-event": [eventId: string];
  "open-reasoning": [sessionId: string];
}>();

const selectedItemId = ref<string | null>(null);

const summaryLabel = computed(() => {
  const count = props.items.length;
  if (props.loading && count === 0) return "Loading room updates";
  if (props.filter === "actionable") return count === 1 ? "1 item needs attention" : `${count} items need attention`;
  return count === 1 ? "1 room item" : `${count} room items`;
});

const selectedItem = computed(() => (
  props.items.find((item) => item.id === selectedItemId.value) || props.items[0] || null
));

function selectItem(item: DesktopInboxItem): void {
  selectedItemId.value = item.id;
}

function clearItem(item: DesktopInboxItem): void {
  emit("clear-item", item);
}

function openItem(item: DesktopInboxItem): void {
  if (item.kind === "thread") {
    emit("open-thread", item);
    return;
  }
  if (item.kind === "task_review" || item.kind === "task_blocked") {
    emit("open-task", item.task.id);
    return;
  }
  if (item.kind === "github_failure") {
    emit("open-github-event", item.event.id);
    return;
  }
  if (item.kind === "agent_blocked") {
    emit("open-reasoning", item.session.id);
  }
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] || "";
  const second = words.length > 1 ? words[1]?.[0] || "" : words[0]?.[1] || "";
  return `${first}${second}`.toUpperCase();
}

function itemIcon(item: DesktopInboxItem) {
  if (item.kind === "thread") return MessageSquare;
  if (item.kind === "task_review") return CheckCircle2;
  if (item.kind === "task_blocked" || item.kind === "github_failure" || item.kind === "agent_offline") return AlertTriangle;
  return Bot;
}

function itemKindLabel(item: DesktopInboxItem): string {
  if (item.kind === "thread") return item.unreadCount > 0 ? "Unread thread" : "Thread";
  if (item.kind === "task_review") return "Review needed";
  if (item.kind === "task_blocked") return "Blocked task";
  if (item.kind === "github_failure") return "Failed check";
  if (item.kind === "agent_offline") return "Agent offline";
  return "Blocked agent";
}

function itemSourceLabel(item: DesktopInboxItem): string {
  if (item.kind === "thread") return "Thread";
  if (item.kind === "task_review") return "Review";
  if (item.kind === "task_blocked") return "Task";
  if (item.kind === "github_failure") return "GitHub";
  return "Agent";
}

function itemPreview(item: DesktopInboxItem): string {
  if (item.preview?.trim()) return item.preview.trim();
  return itemKindLabel(item);
}

function openActionLabel(item: DesktopInboxItem): string {
  if (item.kind === "thread") return "Open thread";
  if (item.kind === "github_failure") return "Open check";
  if (item.kind === "agent_blocked") return "Open agent";
  return "Open task";
}

function itemStatusLabel(item: DesktopInboxItem): string {
  if (item.actionable) return "Needs action";
  if (item.kind === "thread") return item.unreadCount > 0 ? "Unread" : "Read";
  return "No action needed";
}

function itemDetailRows(item: DesktopInboxItem): DetailRow[] {
  const rows: DetailRow[] = [
    { label: "Source", value: itemSourceLabel(item) },
    { label: "Status", value: itemStatusLabel(item) },
  ];
  if (item.timestamp) rows.push({ label: "Latest", value: formatTimestamp(item.timestamp) });
  if (item.firstSeenTimestamp && item.firstSeenTimestamp !== item.timestamp) {
    rows.push({ label: "First seen", value: formatTimestamp(item.firstSeenTimestamp) });
  }
  if (item.occurrenceCount > 1) rows.push({ label: "Grouped", value: `${item.occurrenceCount} occurrences` });

  if (item.kind === "thread") {
    rows.push(
      { label: "Replies", value: String(item.summary.replyCount) },
      { label: "Unread", value: String(item.unreadCount) },
    );
  } else if (item.kind === "task_review" || item.kind === "task_blocked") {
    rows.push(
      { label: "Task", value: item.task.id },
      { label: "Owner", value: item.task.assignee || item.task.createdBy || "Unassigned" },
    );
  } else if (item.kind === "github_failure") {
    rows.push(
      { label: "Event", value: item.event.action || item.event.eventType },
      { label: "Task", value: item.event.linkedTaskId || "None" },
    );
  } else if (item.kind === "agent_blocked") {
    rows.push(
      { label: "Agent", value: item.session.actorLabel || item.session.agentKey || "Unknown" },
      { label: "Task", value: item.session.taskId || "None" },
    );
  } else if (item.kind === "agent_offline") {
    rows.push(
      { label: "Agent", value: item.presence.actorLabel || item.presence.agentKey || "Unknown" },
      { label: "Last seen", value: formatTimestamp(item.presence.lastHeartbeatAt) },
    );
  }

  return rows;
}

function activityCountLabel(count: number): string {
  return count === 1 ? "1 event" : `${count} events`;
}

function whyText(item: DesktopInboxItem): string {
  if (item.kind === "thread") {
    return item.unreadCount > 0
      ? "A thread has replies you have not read yet."
      : "This thread is part of the room inbox history.";
  }
  if (item.kind === "github_failure") {
    return "A GitHub check reported failure and may need someone to inspect or repair the workflow.";
  }
  if (item.kind === "task_review") {
    return "A task is waiting for review before it can move forward.";
  }
  if (item.kind === "task_blocked") {
    return "A task is blocked and needs a decision or additional information.";
  }
  if (item.kind === "agent_offline") {
    return "A worker agent stopped responding and its in-flight work may be stalled until it recovers or someone takes over.";
  }
  return "An agent session is blocked and needs human attention.";
}

function formatTimestamp(timestamp: string): string {
  return formatShortDateTime(timestamp, { hourStyle: "numeric" }) ?? "";
}
</script>
