<script setup lang="ts">
/**
 * RentalStatusBadge — Consistent color-coded status badge for rental sessions.
 */
const props = defineProps<{
  status: string
}>()

const statusConfig: Record<string, { bg: string; color: string; border: string }> = {
  requested: { bg: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24', border: 'rgba(251, 191, 36, 0.3)' },
  accepted: { bg: 'rgba(96, 165, 250, 0.12)', color: '#60a5fa', border: 'rgba(96, 165, 250, 0.3)' },
  active: { bg: 'rgba(52, 211, 153, 0.12)', color: '#34d399', border: 'rgba(52, 211, 153, 0.3)' },
  paused: { bg: 'rgba(249, 115, 22, 0.12)', color: '#f97316', border: 'rgba(249, 115, 22, 0.3)' },
  completed: { bg: 'rgba(99, 102, 241, 0.12)', color: '#818cf8', border: 'rgba(99, 102, 241, 0.3)' },
  cancelled: { bg: 'rgba(107, 114, 128, 0.12)', color: '#9ca3af', border: 'rgba(107, 114, 128, 0.3)' },
  expired: { bg: 'rgba(239, 68, 68, 0.12)', color: '#f87171', border: 'rgba(239, 68, 68, 0.3)' },
  disputed: { bg: 'rgba(244, 63, 94, 0.12)', color: '#fb7185', border: 'rgba(244, 63, 94, 0.3)' },
}

const style = statusConfig[props.status] || statusConfig.cancelled
</script>

<template>
  <span
    class="status-badge"
    :style="{ background: style.bg, color: style.color, borderColor: style.border }"
  >
    {{ status }}
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  border: 1px solid;
  white-space: nowrap;
}
</style>
