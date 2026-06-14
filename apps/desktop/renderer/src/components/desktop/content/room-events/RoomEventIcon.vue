<template>
  <span class="desktop-event-icon" :data-kind="kind" :data-tone="tone" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none">
      <path
        v-if="kind === 'pull-request'"
        d="M5 3.25a1.75 1.75 0 1 1-2 1.73v6.04a1.75 1.75 0 1 1-1.25 0V4.98A1.75 1.75 0 0 1 3.5 3.25Zm7.25 1.75h-1.9a2.85 2.85 0 0 0-2.85 2.85v3.17a1.75 1.75 0 1 1-1.25 0V7.85A4.1 4.1 0 0 1 10.35 3.75h1.9L10.9 2.4l.85-.9L14.6 4.35 11.75 7.2l-.85-.9 1.35-1.3Z"
        fill="currentColor"
      />
      <path
        v-else-if="kind === 'review'"
        d="M2.75 3.25h10.5v6.5h-5L5.6 12.4V9.75H2.75v-6.5Z"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path
        v-else-if="kind === 'comment'"
        d="M3 3.5h10v6.25H8.8L5.5 12.5V9.75H3V3.5Z"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path
        v-else-if="kind === 'check'"
        d="M3.25 3.25h9.5v9.5h-9.5v-9.5Zm2.1 5.05 1.65 1.65 3.75-4"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        v-else-if="kind === 'issue'"
        d="M8 2.75a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5Zm0 2.25v3.2M8 10.6h.01"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
      />
      <path
        v-else-if="kind === 'repository'"
        d="M4.25 2.75h6.5a1.5 1.5 0 0 1 1.5 1.5v9H5a1.75 1.75 0 0 1-1.75-1.75V3.75a1 1 0 0 1 1-1Zm1 8.5h7M5.25 4.75h4.5"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        v-else-if="kind === 'installation'"
        d="M8 1.75 13 4.5v3.65c0 2.5-1.7 4.65-5 6.1-3.3-1.45-5-3.6-5-6.1V4.5l5-2.75Zm-2 6.3 1.35 1.35L10.4 6.3"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        v-else
        d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.1 4.1l2.1 2.1M9.8 9.8l2.1 2.1M11.9 4.1 9.8 6.2M6.2 9.8l-2.1 2.1"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
      />
    </svg>
  </span>
</template>

<script setup lang="ts">
import type { DesktopGitHubEventKind, DesktopGitHubEventTone } from "./presenter";

defineProps<{
  kind: DesktopGitHubEventKind;
  tone: DesktopGitHubEventTone;
}>();
</script>
