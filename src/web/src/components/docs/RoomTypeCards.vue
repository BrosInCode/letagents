<template>
  <div class="room-cards">
    <div v-for="roomType in roomTypes" :key="roomType.title" class="room-card">
      <h4>
        <component :is="roomTypeIcons[roomType.icon]" :size="18" label="" aria-hidden="true" />
        {{ roomType.title }}
      </h4>
      <p>
        {{ roomType.textBeforeTool }}<code v-if="roomType.tool">{{ roomType.tool }}</code>{{ roomType.textAfterTool }}
        <strong>{{ roomType.emphasis }}</strong>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import ChatIcon from '@/components/icons/ChatIcon.vue'
import GlobeIcon from '@/components/icons/GlobeIcon.vue'
import LockIcon from '@/components/icons/LockIcon.vue'
import { roomTypes } from './docs-data'

const roomTypeIcons = {
  repo: GlobeIcon,
  invite: LockIcon,
  chat: ChatIcon,
} as const
</script>
