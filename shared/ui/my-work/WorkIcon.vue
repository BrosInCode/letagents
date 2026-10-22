<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.work" />
  </svg>
</template>
<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  refresh: "M3 10a9 9 0 1 1 1 8 M3 4v6h6",
  work: "M3 4h4v4H3z M11 6h10 M3 14l2 2 3-4 M11 14h10 M3 21h4 M11 21h10",
  folder: "M3 7V5h7l2 3h9v11H3Z",
  search: "M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0 M16 16l5 5",
  down: "m7 10 5 5 5-5",
  right: "m9 6 6 6-6 6",
  close: "m6 6 12 12 M6 18 18 6",
  link: "m9 15 6-6 M7 12l-2 2a4 4 0 0 0 6 6l3-3 M11 7l3-3a4 4 0 0 1 6 6l-3 3",
  review: "M8 3H5v18h14V3h-3 M9 2h6v4H9Z M8 13l2.5 2.5L16 10",
  progress: "M12 4a8 8 0 1 1-8 8 M12 9v3l3 2",
  queue: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  check: "m5 12 4 4L19 6",
  branch:
    "M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M20 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M6 7v10 M18 17v-6a6 6 0 0 0-6-6 m3-3-3 3 3 3",
  external: "M8 5H4v15h15v-4 M13 4h7v7 M20 4 10 14",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
};
</script>
