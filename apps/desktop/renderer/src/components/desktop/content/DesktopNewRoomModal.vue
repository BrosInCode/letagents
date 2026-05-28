<template>
  <div
    class="desktop-modal-backdrop"
    data-testid="new-room-modal"
    @click.self="emit('close')"
  >
    <section class="desktop-new-room-modal" role="dialog" aria-modal="true" aria-labelledby="new-room-title">
      <header class="desktop-new-room-header">
        <div>
          <p class="sidebar-label">New room</p>
          <h2 id="new-room-title">Choose how to open a room</h2>
        </div>
        <button class="desktop-modal-close" type="button" aria-label="Close new room dialog" @click="emit('close')">
          &times;
        </button>
      </header>

      <div class="desktop-new-room-grid">
        <button
          class="desktop-new-room-option"
          type="button"
          :disabled="busy"
          data-testid="new-room-create-invite"
          @click="emit('createInvite')"
        >
          <span class="desktop-new-room-icon">#</span>
          <strong>Invite room</strong>
          <small>Create a room with a random join code for ad-hoc collaboration.</small>
        </button>

        <button
          class="desktop-new-room-option"
          type="button"
          :disabled="busy"
          data-testid="new-room-open-project"
          @click="emit('openProject')"
        >
          <span class="desktop-new-room-icon">&#8962;</span>
          <strong>Project folder</strong>
          <small>Open a folder and use its .letagents.json, git remote, or local room fallback.</small>
        </button>
      </div>

      <form class="desktop-new-room-join" @submit.prevent="emit('join')">
        <label>
          <span>Join with code</span>
          <input
            v-model="joinCode"
            type="text"
            placeholder="ABCD-1234"
            :disabled="busy"
          />
        </label>
        <button type="submit" :disabled="busy || !joinCode.trim()">Join</button>
      </form>

      <p v-if="feedback" class="desktop-new-room-feedback" :data-state="feedbackState">
        {{ feedback }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  busy: boolean;
  feedback: string | null;
  feedbackState: "info" | "error" | "success";
}>();

const joinCode = defineModel<string>("joinCode", { required: true });

const emit = defineEmits<{
  close: [];
  createInvite: [];
  openProject: [];
  join: [];
}>();
</script>
