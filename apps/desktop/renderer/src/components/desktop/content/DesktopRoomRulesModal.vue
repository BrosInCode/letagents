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
                <p>Keep the room, board, and pull request aligned before moving work forward.</p>
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
                <h3>Warnings mean routing</h3>
                <p>Read these as signals before changing workflow state.</p>
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
defineProps<{
  open: boolean;
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
    title: "Keep ownership visible.",
    body: "If someone else takes over, make the handoff explicit before the work continues.",
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
    body: "The GitHub event did not match a clear room workflow, so it should be inspected before the board moves.",
  },
  {
    title: "No checks reported.",
    body: "GitHub has not sent CI status for that branch yet. Keep local checks visible while waiting.",
  },
  {
    title: "Review route unclear.",
    body: "The room cannot tell who should review or move the work next. Clarify it before merging.",
  },
];
</script>
