<template>
  <article
    class="room-chat-message"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
    }"
    :data-owner-kind="ownerKind"
    :data-testid="`room-message-${message.id}`"
  >
    <div
      class="room-chat-avatar"
      :style="{ '--avatar-color': senderColor }"
      aria-hidden="true"
    />

    <div class="room-chat-message-content">
      <div class="room-message-meta">
        <div class="room-message-author-block">
          <strong>{{ displayName }}</strong>
          <span v-if="ownerAttribution" class="room-message-owner">{{ ownerAttribution }}</span>
          <span v-if="ideLabel" class="room-message-ide" :data-ide="ideLabel.toLowerCase()">
            {{ ideLabel }}
          </span>
        </div>
        <div class="room-message-meta-tail">
          <button class="room-message-reply-action" type="button" title="Reply" @click="$emit('reply', message)">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6.5 4.5 2.5 8l4 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 8h5.5A4.5 4.5 0 0 1 13 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <span class="room-message-provenance" :data-kind="ownerKind">
            {{ ownerKind }}
          </span>
          <time :datetime="message.timestamp">{{ formattedTime }}</time>
        </div>
      </div>

      <div class="room-message-bubble">
        <button
          v-if="message.replyTo"
          class="room-message-reply"
          type="button"
          :aria-label="`Reply preview from ${replyDisplayName}`"
          @click="$emit('scroll-to-message', message.replyTo.id)"
        >
          <span class="room-message-reply-label">Replying to {{ replyDisplayName }}</span>
          <span class="room-message-reply-text">{{ replyPreviewText }}</span>
        </button>

        <div v-if="githubEvent" class="desktop-github-event" :data-tone="githubEvent.tone">
          <div class="desktop-github-event-kicker">
            <span>{{ githubEvent.kindLabel }}</span>
            <span v-if="githubEvent.statusLabel">{{ githubEvent.statusLabel }}</span>
          </div>
          <strong>{{ githubEvent.headline }}</strong>
          <p v-if="githubEvent.detail">{{ githubEvent.detail }}</p>
          <div class="desktop-github-event-meta">
            <span v-if="githubEvent.repository">{{ githubEvent.repository }}</span>
            <span v-if="githubEvent.taskId">{{ githubEvent.taskId }}</span>
            <a v-if="githubEvent.url" :href="githubEvent.url" target="_blank" rel="noopener noreferrer">
              {{ githubEvent.urlLabel }}
            </a>
          </div>
        </div>

        <DesktopLongMessageContent
          v-else
          :text="message.text || 'No message body.'"
          :html="renderedText"
          :message-id="message.id"
        />

        <div v-if="message.attachments.length" class="room-message-attachments">
          <template v-for="attachment in message.attachments" :key="attachmentKey(attachment)">
            <button
              v-if="isImageAttachment(attachment)"
              class="room-message-attachment is-image"
              type="button"
              @click="$emit('open-image', imageAttachmentId(attachment))"
            >
              <img :src="attachmentHref(attachment)" :alt="attachmentName(attachment)">
              <span>
                <strong>{{ attachmentName(attachment) }}</strong>
                <small>{{ attachmentMeta(attachment) }}</small>
              </span>
            </button>
            <a
              v-else
              class="room-message-attachment"
              :href="attachmentHref(attachment)"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span class="room-message-attachment-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                  <path d="M9 2.5v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                </svg>
              </span>
              <span>
                <strong>{{ attachmentName(attachment) }}</strong>
                <small>{{ attachmentMeta(attachment) }}</small>
              </span>
            </a>
          </template>
        </div>
      </div>

      <button
        v-if="threadCount > 0"
        class="room-thread-marker"
        type="button"
        @click="$emit('scroll-to-message', latestThreadMessageId)"
      >
        {{ threadCount === 1 ? "1 reply" : `${threadCount} replies` }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopRoomMessage, DesktopRoomMessageAttachment } from "../../../../../electron/ipc-types";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";

interface GitHubEventPresentation {
  tone: "violet" | "amber" | "emerald" | "rose" | "sky" | "slate";
  kindLabel: string;
  statusLabel: string | null;
  headline: string;
  detail: string | null;
  repository: string | null;
  taskId: string | null;
  url: string | null;
  urlLabel: string;
}

const props = defineProps<{
  message: DesktopRoomMessage;
  threadCount: number;
  latestThreadMessageId: string | null;
}>();

defineEmits<{
  reply: [message: DesktopRoomMessage];
  "scroll-to-message": [messageId: string | null];
  "open-image": [imageId: string];
}>();

const identity = computed(() => parseSenderIdentity(props.message));
const displayName = computed(() => props.message.agentIdentity?.displayName || identity.value.displayName);
const ownerAttribution = computed(() => props.message.agentIdentity?.ownerAttribution || identity.value.ownerAttribution);
const ideLabel = computed(() => props.message.agentIdentity?.ideLabel || identity.value.ideLabel);
const isSystem = computed(() => ["system", "letagents"].includes(props.message.sender.toLowerCase()));
const githubEvent = computed(() => parseGitHubEvent(props.message));
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source));
const ownerKind = computed(() => {
  if (isSystem.value) return "system";
  if (props.message.source === "github") return "github";
  if (props.message.source === "agent" || ownerAttribution.value || ideLabel.value) return "agent";
  if (props.message.source === "browser") return "human";
  return "room";
});
const replyDisplayName = computed(() =>
  props.message.replyTo ? parseSenderIdentity(props.message.replyTo).displayName : "unknown"
);
const replyPreviewText = computed(() => truncate((props.message.replyTo?.text || "").replace(/\s+/g, " ").trim(), 160));
const formattedTime = computed(() => formatTimestamp(props.message.timestamp));
const renderedText = computed(() => renderMessageText(props.message.text || "No message body."));

function parseSenderIdentity(input: { sender?: string | null }): {
  displayName: string;
  ownerAttribution: string | null;
  ideLabel: string | null;
} {
  const raw = (input?.sender || "").trim();
  const parts = raw.split(" | ").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 3 && /agent$/i.test(parts[1])) {
    return {
      displayName: parts[0],
      ownerAttribution: parts[1],
      ideLabel: normalizeIdeLabel(parts[2]),
    };
  }
  return {
    displayName: raw || "Unknown",
    ownerAttribution: null,
    ideLabel: inferIdeLabel(raw),
  };
}

function normalizeIdeLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "codex") return "Codex";
  if (normalized === "antigravity") return "Antigravity";
  if (normalized === "claude") return "Claude";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "agent") return null;
  return normalized.split(/[^a-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function inferIdeLabel(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("codex")) return "Codex";
  if (normalized.startsWith("antigravity")) return "Antigravity";
  if (normalized.startsWith("claude")) return "Claude";
  if (normalized.startsWith("cursor")) return "Cursor";
  return null;
}

function getSenderColor(sender: string, source: string | null): string {
  if (source === "github") return "#a78bfa";
  if (["system", "letagents"].includes(sender.toLowerCase())) return "#71717a";
  let hash = 5381;
  const ownerKey = parseSenderIdentity({ sender }).ownerAttribution || sender;
  for (let index = 0; index < ownerKey.length; index += 1) {
    hash = ((hash << 5) + hash + ownerKey.charCodeAt(index)) >>> 0;
  }
  const palette = ["#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#fb7185", "#22d3ee"];
  return palette[hash % palette.length];
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function renderMessageText(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(https?:\/\/[^\s<"']+)/g, (_match, url) => {
      const safeHref = escapeAttr(url);
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    })
    .replace(/(^|[\s(])@([A-Za-z0-9._-]+)/g, '$1<span class="mention-token">@$2</span>')
    .replace(/\n/g, "<br>");
}

function parseGitHubEvent(message: DesktopRoomMessage): GitHubEventPresentation | null {
  if (message.source !== "github" && message.sender.toLowerCase() !== "github") return null;
  const text = message.text.trim();
  const urlMatch = text.match(/\s(https?:\/\/\S+)$/i);
  const url = urlMatch?.[1] || null;
  const body = urlMatch ? text.slice(0, urlMatch.index).trim() : text;
  const reviewMatch = /^(.+?)\s+(approved|requested changes on|reviewed)\s+(PR #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i.exec(body);
  if (reviewMatch) {
    const action = reviewMatch[2].trim();
    return {
      tone: action === "approved" ? "emerald" : action === "requested changes on" ? "rose" : "sky",
      kindLabel: "Review",
      statusLabel: action === "requested changes on" ? "changes requested" : action,
      headline: `${reviewMatch[1].trim()} ${action} ${reviewMatch[3]}`,
      detail: null,
      repository: reviewMatch[4],
      taskId: reviewMatch[5] || null,
      url,
      urlLabel: "Open review",
    };
  }
  const commentMatch = /^(.+?)\s+commented on\s+(PR #\d+|Issue #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?:\s+"([\s\S]*)"$/i.exec(body);
  if (commentMatch) {
    return {
      tone: "sky",
      kindLabel: "Comment",
      statusLabel: "new comment",
      headline: `${commentMatch[1].trim()} commented on ${commentMatch[2]}`,
      detail: commentMatch[5].trim(),
      repository: commentMatch[3],
      taskId: commentMatch[4] || null,
      url,
      urlLabel: "Open thread",
    };
  }
  const checkMatch = /^Check "([^"]+)"(?: \(([^)]+)\))?\s+([a-z_]+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i.exec(body);
  if (checkMatch) {
    const conclusion = checkMatch[3].trim();
    const conclusionLabel = titleCase(conclusion);
    return {
      tone: checkTone(conclusion),
      kindLabel: "Check run",
      statusLabel: conclusionLabel,
      headline: `Check ${checkMatch[1].trim()} ${conclusionLabel.toLowerCase()}`,
      detail: checkMatch[2] ? `Reported by ${checkMatch[2].trim()}` : null,
      repository: checkMatch[4],
      taskId: checkMatch[5] || null,
      url,
      urlLabel: "Open check",
    };
  }
  const prMatch = /^(PR #\d+|Issue #\d+)\s+(.+?)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?:\s+([\s\S]+)$/i.exec(body);
  if (prMatch) {
    const kindLabel = prMatch[1].startsWith("PR ") ? "Pull request" : "Issue";
    const action = prMatch[2].trim();
    return {
      tone: action.includes("merged") ? "emerald" : action.includes("closed") ? "slate" : kindLabel === "Issue" ? "amber" : "violet",
      kindLabel,
      statusLabel: summarizeAction(action),
      headline: `${prMatch[1]} ${action}`,
      detail: prMatch[5].trim(),
      repository: prMatch[3],
      taskId: prMatch[4] || null,
      url,
      urlLabel: kindLabel === "Pull request" ? "Open pull request" : "Open issue",
    };
  }
  return {
    tone: "slate",
    kindLabel: "GitHub event",
    statusLabel: null,
    headline: body,
    detail: null,
    repository: null,
    taskId: null,
    url,
    urlLabel: "Open on GitHub",
  };
}

function summarizeAction(action: string): string | null {
  const normalized = action.toLowerCase();
  if (normalized.includes("ready for review")) return "ready";
  if (normalized.includes("merged")) return "merged";
  if (normalized.includes("closed")) return "closed";
  if (normalized.includes("opened")) return "opened";
  if (normalized.includes("draft")) return "draft";
  if (normalized.includes("commits")) return "updated";
  return null;
}

function titleCase(value: string): string {
  return value.split(/[_\s-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function checkTone(conclusion: string): GitHubEventPresentation["tone"] {
  const normalized = conclusion.toLowerCase();
  if (["failure", "timed_out", "cancelled"].includes(normalized)) return "rose";
  if (["action_required", "neutral"].includes(normalized)) return "amber";
  return "sky";
}

function attachmentName(attachment: DesktopRoomMessageAttachment): string {
  return attachment.fileName || attachment.name || "attachment";
}

function attachmentMimeType(attachment: DesktopRoomMessageAttachment): string {
  return attachment.mimeType || "application/octet-stream";
}

function attachmentHref(attachment: DesktopRoomMessageAttachment): string {
  if (attachment.url) return attachment.url;
  if (attachment.downloadUrl) return attachment.downloadUrl;
  if (attachment.dataUrl) return attachment.dataUrl;
  if (attachment.contentBase64) return `data:${attachmentMimeType(attachment)};base64,${attachment.contentBase64}`;
  return "#";
}

function attachmentKey(attachment: DesktopRoomMessageAttachment): string {
  return attachment.id || `${attachmentName(attachment)}-${attachment.sizeBytes || 0}-${attachmentMimeType(attachment)}`;
}

function imageAttachmentId(attachment: DesktopRoomMessageAttachment): string {
  return `${props.message.id}:${attachmentKey(attachment)}`;
}

function isImageAttachment(attachment: DesktopRoomMessageAttachment): boolean {
  return attachmentMimeType(attachment).startsWith("image/") && attachmentHref(attachment) !== "#";
}

function attachmentMeta(attachment: DesktopRoomMessageAttachment): string {
  return [attachmentMimeType(attachment), formatBytes(attachment.sizeBytes || 0)].filter(Boolean).join(" · ");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
</script>
