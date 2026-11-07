<template>
  <svg v-if="name === 'task' || name === 'bug' || name === 'feature'" viewBox="0 0 24 24" fill="none" aria-hidden="true" :class="`issue-type-${name}`">
    <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" />
    <path v-if="name === 'task'" d="m7 12 3 3 7-7" stroke="var(--board-bg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <circle v-else-if="name === 'bug'" cx="12" cy="12" r="4" fill="var(--board-bg)" />
    <path v-else d="m12 6 6 6-6 6-6-6Z" fill="var(--board-bg)" />
  </svg>
  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.task" /></svg>
</template>
<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  more: 'M5 12h.01M12 12h.01M19 12h.01', up: 'm6 15 6-6 6 6', undo: 'M3 10h7M3 10V3m0 7 4-4a8 8 0 1 1-1 11',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M18 6 6 18', down: 'm6 9 6 6 6-6',
  search: 'm21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  board: 'M3 4h18v16H3zM9 4v16M15 4v16', list: 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
  user: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4',
  pr: 'M6 8v8m0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-6V8a3 3 0 0 0-3-3h-2m0 0 3-3m-3 3 3 3',
  external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
  flag: 'M5 22V3m0 1c5-5 9 5 14 0v10c-5 5-9-5-14 0',
  collapse: 'M3 12h5m-3-3 3 3-3 3M21 12h-5m3-3-3 3 3 3',
  expand: 'M8 12H3m3-3-3 3 3 3M16 12h5m-3-3 3 3-3 3',
  settings: 'M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4m-8 3v4',
  refresh: 'M20 7V2m0 5h-5M4 17v5m0-5h5M4.5 8a8 8 0 0 1 13-3L20 7M4 17l2.5 2a8 8 0 0 0 13-3',
  left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6', grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  calendar: 'M4 5h16v16H4ZM4 10h16M8 3v4M16 3v4',
};
</script>
