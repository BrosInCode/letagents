<template>
  <article
    class="room-chat-message"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
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

        <div v-if="githubEvent" class="desktop-github-event" :data-tone="githubEvent.tone" :data-kind="githubEvent.kind">
          <div class="desktop-github-event-icon" aria-hidden="true">
            <svg v-if="githubEvent.kind === 'pull-request'" viewBox="0 0 16 16" fill="none">
              <circle cx="4" cy="4" r="2" stroke="currentColor" stroke-width="1.3" />
              <circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.3" />
              <path d="M5.5 5.5l5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              <path d="M11 7V4h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="githubEvent.kind === 'issue'" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" />
              <line x1="8" y1="5" x2="8" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
            </svg>
            <svg v-else-if="githubEvent.kind === 'review'" viewBox="0 0 16 16" fill="none">
              <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H8l-3 2v-2H4.5A1.5 1.5 0 0 1 3 9.5v-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
              <path d="M6 7.8l1.2 1.2L10 6.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="githubEvent.kind === 'comment'" viewBox="0 0 16 16" fill="none">
              <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H8l-3 2v-2H4.5A1.5 1.5 0 0 1 3 9.5v-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
              <line x1="5.5" y1="6.5" x2="10.5" y2="6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <line x1="5.5" y1="8.8" x2="9.5" y2="8.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            <svg v-else-if="githubEvent.kind === 'check'" viewBox="0 0 16 16" fill="none">
              <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" stroke-width="1.3" />
              <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <svg v-else-if="githubEvent.kind === 'repository'" viewBox="0 0 16 16" fill="none">
              <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h2l1 1h4A1.5 1.5 0 0 1 13 6.5v4A1.5 1.5 0 0 1 11.5 12h-7A1.5 1.5 0 0 1 3 10.5v-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
            <svg v-else viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" />
              <path d="M8 5.2v2.8M8 10.7h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </div>
          <div class="desktop-github-event-content">
            <div class="desktop-github-event-chips">
              <span class="desktop-github-chip is-brand">GitHub</span>
              <span class="desktop-github-chip">{{ githubEvent.kindLabel }}</span>
              <span v-if="githubEvent.statusLabel" class="desktop-github-chip is-status">{{ githubEvent.statusLabel }}</span>
              <span v-if="githubEvent.repository" class="desktop-github-chip is-repo">{{ githubEvent.repository }}</span>
              <span v-if="githubEvent.taskId" class="desktop-github-chip is-task">{{ githubEvent.taskId }}</span>
            </div>
            <strong>{{ githubEvent.headline }}</strong>
            <p v-if="githubEvent.detail">{{ githubEvent.detail }}</p>
            <a v-if="githubEvent.url" class="desktop-github-event-link" :href="githubEvent.url" target="_blank" rel="noopener noreferrer">
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
  kind: "pull-request" | "issue" | "review" | "comment" | "check" | "repository" | "generic";
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
  highlightQuery: string;
  searchActive: boolean;
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
const renderedText = computed(() => renderMessageText(props.message.text || "No message body.", props.highlightQuery));

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

function renderMessageText(value: string, highlightQuery: string): string {
  return highlightEscapedText(escapeHtml(value), highlightQuery)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(https?:\/\/[^\s<"']+)/g, (_match, url) => {
      const safeHref = escapeAttr(url);
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    })
    .replace(/(^|[\s(])@([A-Za-z0-9._-]+)/g, '$1<span class="mention-token">@$2</span>')
    .replace(/\n/g, "<br>");
}

function highlightEscapedText(value: string, query: string): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return value;
  const escapedQuery = escapeHtml(normalizedQuery).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedQuery) return value;
  return value.replace(new RegExp(escapedQuery, "gi"), '<mark class="message-search-hit">$&</mark>');
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
      kind: "review",
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
      kind: "comment",
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
      kind: "check",
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
  const prMatch = /^(PR #\d+|Issue #\d+)\s+(.+?)\s+in\s+([^\s:]+)(?:\s+linked to\s+(task_\d+))?(?::\s*([\s\S]*))?$/i.exec(body);
  if (prMatch) {
    const kindLabel = prMatch[1].startsWith("PR ") ? "Pull request" : "Issue";
    const action = prMatch[2].trim();
    const kind = kindLabel === "Pull request" ? "pull-request" : "issue";
    return {
      kind,
      tone: artifactTone(kind, action),
      kindLabel,
      statusLabel: summarizeAction(action),
      headline: `${prMatch[1]} ${action}`,
      detail: prMatch[5]?.trim() || null,
      repository: prMatch[3],
      taskId: prMatch[4] || null,
      url,
      urlLabel: kindLabel === "Pull request" ? "Open pull request" : "Open issue",
    };
  }
  const repositoryEvent = parseRepositoryEvent(body, url);
  if (repositoryEvent) return repositoryEvent;
  return {
    kind: "generic",
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
  if (normalized.includes("reopened")) return "reopened";
  if (normalized.includes("opened")) return "opened";
  if (normalized.includes("converted to draft") || normalized.includes("draft")) return "draft";
  if (normalized.includes("commits")) return "updated";
  return null;
}

function artifactTone(kind: GitHubEventPresentation["kind"], action: string): GitHubEventPresentation["tone"] {
  const normalized = action.trim().toLowerCase();
  if (normalized.includes("merged")) return "emerald";
  if (normalized.includes("closed")) return "slate";
  if (normalized.includes("converted to draft")) return "amber";
  if (normalized.includes("received new commits")) return "sky";
  if (kind === "issue") return "amber";
  return "violet";
}

function parseRepositoryEvent(body: string, url: string | null): GitHubEventPresentation | null {
  if (!/^Repository\b/i.test(body)) return null;
  const statusLabel = /\brenamed\b/i.test(body)
    ? "renamed"
    : /\btransferred\b/i.test(body)
      ? "transferred"
      : null;
  return {
    kind: "repository",
    tone: "sky",
    kindLabel: "Repository",
    statusLabel,
    headline: body,
    detail: null,
    repository: null,
    taskId: null,
    url,
    urlLabel: "Open repository",
  };
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
