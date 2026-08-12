<template>
  <section>
    <p v-if="loading" class="rent-detail-empty">Loading access requests...</p>
    <p v-else-if="requests.length === 0" class="rent-detail-empty">
      No access requests. The agent has not asked for anything outside the approved scope.
    </p>
    <ol v-else class="rent-context-requests">
      <li
        v-for="request in requests"
        :key="request.id"
        :data-testid="`rent-detail-context-request-${request.id}`"
      >
        <div class="rent-context-request-main">
          <div>
            <code class="rent-context-request-path">{{ request.path ?? "(no path)" }}</code>
            <span class="state-pill" :data-state="contextRequestState(request.status)">
              {{ humanizeToken(request.status) }}
            </span>
          </div>
          <p v-if="request.reason" class="rent-context-request-reason">
            {{ request.reason }}
          </p>
          <p class="rent-context-request-meta">
            Requested {{ formatTime(request.createdAt) }}
            <template v-if="request.decidedAt">
              · decided {{ formatTime(request.decidedAt) }}
            </template>
          </p>
        </div>
        <div v-if="request.status === 'pending'" class="rent-context-request-actions">
          <button
            type="button"
            class="rent-create-secondary rent-context-approve"
            :disabled="busyFor === request.id"
            :data-testid="`rent-detail-context-approve-${request.id}`"
            @click="$emit('approve', request.id)"
          >
            {{ busyFor === request.id ? "Working..." : "Approve" }}
          </button>
          <button
            type="button"
            class="rent-create-secondary rent-context-deny"
            :disabled="busyFor === request.id"
            :data-testid="`rent-detail-context-deny-${request.id}`"
            @click="$emit('deny', request.id)"
          >
            Deny
          </button>
        </div>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { DesktopRentalContextApproval } from "../../../../../../electron/ipc-types";
import { contextRequestState, formatTime, humanizeToken } from "./presentation";

defineProps<{
  requests: DesktopRentalContextApproval[];
  loading: boolean;
  busyFor: string | null;
}>();

defineEmits<{
  approve: [requestId: string];
  deny: [requestId: string];
}>();
</script>

<style scoped>
.rent-detail-empty {
  opacity: 0.65;
  font-size: 0.9rem;
}
.rent-context-requests {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rent-context-requests li {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 0.5rem;
}
.rent-context-request-path {
  font-size: 0.85rem;
  margin-right: 0.5rem;
  word-break: break-all;
}
.rent-context-request-reason {
  margin: 0.3rem 0 0;
  font-size: 0.85rem;
  opacity: 0.85;
}
.rent-context-request-meta {
  margin: 0.3rem 0 0;
  font-size: 0.75rem;
  opacity: 0.6;
}
.rent-context-request-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}
.rent-create-secondary {
  appearance: none;
  padding: 0.35rem 0.8rem;
  border-radius: 999px;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: inherit;
}
.rent-create-secondary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.rent-context-approve {
  border-color: color-mix(in srgb, var(--color-success, #7ddf9a) 50%, transparent);
  color: var(--color-success, #7ddf9a);
}
.rent-context-deny {
  border-color: color-mix(in srgb, var(--color-danger, #ff8a80) 50%, transparent);
  color: var(--color-danger, #ff8a80);
}
</style>
