<template>
  <div class="drawer-section drawer-panel share-block">
    <div class="drawer-section-title">
      <h2>{{ shareKind === 'url' ? 'Room URL' : 'Invite Code' }}</h2>
      <span>{{ roomName || 'No active room' }}</span>
    </div>
    <div class="join-code-display">
      <button
        class="join-code-copy"
        :data-share-kind="shareKind"
        :disabled="!shareValue"
        @click="$emit('copy')"
      >
        <span>
          <span class="copy-help">{{ shareKind === 'url' ? 'Share this room URL instantly' : 'Share this room instantly' }}</span>
          <strong :title="shareValue">{{ shareDisplayValue || '----' }}</strong>
        </span>
        <span class="copy-pill">{{ copied ? 'Copied!' : 'Copy' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  copied: boolean
  roomName: string
  shareDisplayValue: string
  shareKind: string
  shareValue: string
}>()

defineEmits<{ copy: [] }>()
</script>
