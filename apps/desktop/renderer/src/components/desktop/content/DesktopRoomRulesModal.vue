<template>
  <Teleport to="body">
    <Transition name="room-panel">
      <div v-if="open" class="desktop-rules-backdrop" data-testid="desktop-room-rules" @click.self="$emit('close')">
        <section class="desktop-rules-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-room-rules-title">
          <header class="desktop-rules-header">
            <div>
              <p>Pinned room rules</p>
              <h2 id="desktop-room-rules-title">How work moves here</h2>
            </div>
            <button type="button" aria-label="Close room rules" @click="$emit('close')">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </header>

          <div class="desktop-rules-body">
            <section class="desktop-rules-section">
              <div class="desktop-rules-section-heading">
                <h3>Operating contract</h3>
                <p>Keep the board, room, and pull request aligned before moving work forward.</p>
              </div>
              <ol class="desktop-rules-list">
                <li v-for="rule in workflowRules" :key="rule.title">
                  <strong>{{ rule.title }}</strong>
                  <span>{{ rule.body }}</span>
                </li>
              </ol>
            </section>

            <section class="desktop-rules-section">
              <div class="desktop-rules-section-heading">
                <h3>Current authority</h3>
                <p>Active tasks with a lease, branch, review, or merge state.</p>
              </div>
              <div v-if="authorityRows.length" class="desktop-rules-authority-list">
                <article v-for="row in authorityRows" :key="row.id" class="desktop-rules-authority-row">
                  <div>
                    <span>{{ row.shortId }}</span>
                    <strong>{{ row.title }}</strong>
                  </div>
                  <dl>
                    <span>
                      <dt>Status</dt>
                      <dd>{{ row.status }}</dd>
                    </span>
                    <span>
                      <dt>Lease</dt>
                      <dd>{{ row.lease }}</dd>
                    </span>
                    <span>
                      <dt>Owner</dt>
                      <dd>{{ row.owner }}</dd>
                    </span>
                    <span>
                      <dt>PR</dt>
                      <dd>{{ row.pr }}</dd>
                    </span>
                  </dl>
                </article>
              </div>
              <p v-else class="desktop-rules-empty">No active task authority is visible right now.</p>
            </section>

            <section class="desktop-rules-section">
              <div class="desktop-rules-section-heading">
                <h3>Warnings mean routing</h3>
                <p>Read these as signals before taking over someone else’s work.</p>
              </div>
              <details v-for="warning in warningRules" :key="warning.title" class="desktop-rules-warning">
                <summary>{{ warning.title }}</summary>
                <p>{{ warning.body }}</p>
              </details>
            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopTaskSummary } from "../../../../../electron/ipc-types";

const props = defineProps<{
  open: boolean;
  tasks: DesktopTaskSummary[];
}>();

defineEmits<{
  close: [];
}>();

const workflowRules = [
  {
    title: "Claim before coding.",
    body: "Start implementation only after the board shows who owns the work.",
  },
  {
    title: "Keep the lease honest.",
    body: "If the active worker changes, hand off or release the work lane before continuing.",
  },
  {
    title: "Open a visible PR.",
    body: "Attach the pull request to the task so reviews, checks, and merge state stay with the room.",
  },
  {
    title: "No self-review.",
    body: "Another human or agent should review before merge.",
  },
  {
    title: "Close the loop.",
    body: "Move tasks through review, merge, and done so the room history stays useful.",
  },
];

const warningRules = [
  {
    title: "GitHub event ignored.",
    body: "The GitHub event did not match the active task or room lane, so it cannot move the board safely.",
  },
  {
    title: "No checks reported.",
    body: "GitHub has not sent CI status for that branch yet. Keep local checks visible while waiting.",
  },
  {
    title: "Lease holder missing.",
    body: "The task may still have an assignee, but no reachable session currently owns the work lane.",
  },
];

const activeStatuses = new Set(["assigned", "in_progress", "blocked", "in_review", "merged"]);

const authorityRows = computed(() =>
  props.tasks
    .filter((task) => activeStatuses.has(task.status) || task.activeLeases.length > 0 || Boolean(task.prUrl))
    .slice(0, 6)
    .map((task) => {
      const lease = task.activeLeases.find((entry) => entry.kind === "work") || task.activeLeases[0] || null;
      return {
        id: task.id,
        shortId: formatTaskShortId(task.id),
        title: task.title,
        status: task.status.replace(/_/g, " "),
        lease: lease ? `${lease.kind} lease` : "No active lease",
        owner: lease?.holderLabel || task.assignee || "Unassigned",
        pr: task.prUrl ? "Linked" : "Not linked",
      };
    }),
);

function formatTaskShortId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim());
  if (match) return `T${match[1]}`;
  return taskId.replace(/^task_/i, "T");
}
</script>
