<template>
  <section
    v-if="loading || error || entries.length"
    class="activity-approvals"
    aria-label="Agent approval requests"
  >
    <header class="activity-approvals-header">
      <div>
        <h3>Agent approvals</h3>
        <p>Review the requested file changes before allowing them.</p>
      </div>
      <span v-if="entries.length" class="activity-group-count">{{ entries.length }}</span>
    </header>

    <div v-if="error" class="activity-approval-alert" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="emit('refresh')">Try again</button>
    </div>

    <p v-if="loading && !entries.length" class="activity-approval-loading" role="status">
      Loading approval requests…
    </p>

    <div class="activity-approval-list">
      <article
        v-for="entry in entries"
        :key="entry.publication.publication_id"
        class="activity-approval-card"
      >
        <header class="activity-approval-card-header">
          <div>
            <span class="activity-approval-kind">File changes</span>
            <h4>{{ agentName(entry.publication.agent_key) }} needs approval</h4>
          </div>
          <time :datetime="entry.publication.expires_at">
            Expires {{ expiryLabel(entry.publication.expires_at) }}
          </time>
        </header>

        <button
          v-if="entry.evidenceStatus === 'idle'"
          class="activity-approval-review"
          type="button"
          @click="emit('review', entry.publication.publication_id)"
        >
          Review changes
        </button>

        <p v-else-if="entry.evidenceStatus === 'loading'" class="activity-approval-loading" role="status">
          Checking that the request is complete and unchanged…
        </p>

        <div v-else-if="entry.evidenceStatus === 'unsupported'" class="activity-approval-alert">
          <strong>Update needed</strong>
          <span>This app cannot display this request. Update LetAgents before reviewing it.</span>
        </div>

        <div v-else-if="entry.evidenceStatus === 'unavailable'" class="activity-approval-alert">
          <strong>No longer available</strong>
          <span>The request is being refreshed from the room.</span>
        </div>

        <div v-else-if="entry.evidenceStatus === 'invalid'" class="activity-approval-alert" role="alert">
          <strong>Request could not be verified</strong>
          <span>{{ entry.evidenceError }}</span>
        </div>

        <div v-else-if="entry.evidenceStatus === 'error'" class="activity-approval-alert" role="alert">
          <span>{{ entry.evidenceError }}</span>
          <button type="button" @click="emit('review', entry.publication.publication_id)">
            Try again
          </button>
        </div>

        <template v-else-if="entry.projection && entry.projectionJson">
          <p class="activity-approval-summary">
            {{ entry.projection.totals.file_count }}
            {{ entry.projection.totals.file_count === 1 ? 'file' : 'files' }}
            <span class="activity-approval-add">+{{ entry.projection.totals.added_lines }}</span>
            <span class="activity-approval-delete">−{{ entry.projection.totals.removed_lines }}</span>
          </p>

          <ul class="activity-approval-changes">
            <li v-for="change in entry.projection.changes" :key="`${change.path}:${change.kind}`">
              <span class="activity-approval-path">
                {{ change.kind === 'move' ? `${change.path} → ${change.move_path}` : change.path }}
              </span>
              <span class="activity-approval-counts">
                <span>{{ change.kind }}</span>
                <b class="activity-approval-add">+{{ change.added_lines }}</b>
                <b class="activity-approval-delete">−{{ change.removed_lines }}</b>
              </span>
            </li>
          </ul>

          <details class="activity-approval-exact">
            <summary>Technical details</summary>
            <p>Agent reference: {{ entry.publication.agent_key }}</p>
            <pre>{{ entry.projectionJson }}</pre>
          </details>

          <p v-if="entry.decisionError" class="activity-approval-decision-error" role="alert">
            {{ entry.decisionError }}
          </p>
          <div class="activity-approval-actions">
            <button
              type="button"
              :disabled="entry.decisionBusy"
              @click="emit('decide', entry.publication.publication_id, 'allow_once')"
            >
              {{ entry.decisionBusy ? 'Sending…' : 'Allow once' }}
            </button>
            <button
              class="activity-approval-deny"
              type="button"
              :disabled="entry.decisionBusy"
              @click="emit('decide', entry.publication.publication_id, 'deny')"
            >
              Deny
            </button>
          </div>
        </template>
      </article>
    </div>

    <button
      v-if="hasMore"
      class="activity-approvals-more"
      type="button"
      :disabled="loadingMore"
      @click="emit('loadMore')"
    >
      {{ loadingMore ? 'Loading…' : 'Load more approvals' }}
    </button>
  </section>
</template>

<script setup lang="ts">
import type { ExecutionDelegationDecisionChoice } from '../../../../../../shared/execution-delegation-decision.mjs'
import type { RoomAgentApprovalEntry } from '@/composables/roomAgentApprovalTypes'

const props = defineProps<{
  agents?: readonly { agent_key?: string | null; display_name?: string | null }[]
  entries: readonly RoomAgentApprovalEntry[]
  loading: boolean
  loadingMore: boolean
  error: string
  hasMore: boolean
}>()

function agentName(agentKey: string): string {
  return props.agents?.find(agent => agent.agent_key === agentKey && agent.display_name)?.display_name || 'An agent'
}

function expiryLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'at an unknown time' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const emit = defineEmits<{
  refresh: []
  loadMore: []
  review: [publicationId: string]
  decide: [publicationId: string, decision: ExecutionDelegationDecisionChoice]
}>()
</script>

<style src="./styles/approvals.css"></style>
