<script setup lang="ts">
/**
 * ComputeUnitMeter — Reusable CU budget meter with gradient fill,
 * warning/exhausted states, and animated transitions.
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  used: number
  budget: number
  showLabels?: boolean
  size?: 'sm' | 'md' | 'lg'
}>(), {
  showLabels: true,
  size: 'md',
})

const percent = computed(() => {
  if (props.budget <= 0) return 0
  return Math.min(100, Math.round((props.used / props.budget) * 100))
})

const remaining = computed(() => Math.max(0, props.budget - props.used))

const state = computed(() => {
  if (percent.value >= 100) return 'exhausted'
  if (percent.value >= 80) return 'warning'
  return 'healthy'
})

function formatCU(cu: number): string {
  if (cu >= 1_000_000) return `${(cu / 1_000_000).toFixed(1)}M`
  if (cu >= 1_000) return `${(cu / 1_000).toFixed(0)}K`
  return String(cu)
}
</script>

<template>
  <div :class="['cu-meter', `cu-meter--${size}`, `cu-meter--${state}`]">
    <div class="cu-bar">
      <div
        class="cu-fill"
        :style="{ width: percent + '%' }"
        role="progressbar"
        :aria-valuenow="used"
        :aria-valuemin="0"
        :aria-valuemax="budget"
      >
        <span v-if="percent >= 20 && size !== 'sm'" class="cu-fill-label">{{ percent }}%</span>
      </div>
    </div>
    <div v-if="showLabels" class="cu-labels">
      <span class="cu-used">{{ formatCU(used) }} <span class="cu-dim">used</span></span>
      <span class="cu-remaining">{{ formatCU(remaining) }} <span class="cu-dim">left</span></span>
    </div>
  </div>
</template>

<style scoped>
.cu-meter { width: 100%; }

/* Bar */
.cu-bar {
  width: 100%;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}

.cu-meter--sm .cu-bar { height: 4px; }
.cu-meter--md .cu-bar { height: 8px; }
.cu-meter--lg .cu-bar { height: 12px; border-radius: 6px; }

.cu-bar {
  background: rgba(255, 255, 255, 0.06);
}

/* Fill */
.cu-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 0.3rem;
}

.cu-meter--healthy .cu-fill {
  background: linear-gradient(90deg, #6366f1, #a78bfa);
}

.cu-meter--warning .cu-fill {
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
}

.cu-meter--exhausted .cu-fill {
  background: linear-gradient(90deg, #ef4444, #f87171);
}

.cu-fill-label {
  font-size: 0.55rem;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* Labels */
.cu-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 0.35rem;
  font-size: 0.78rem;
  font-weight: 500;
}

.cu-meter--sm .cu-labels { font-size: 0.7rem; margin-top: 0.2rem; }
.cu-meter--lg .cu-labels { font-size: 0.85rem; margin-top: 0.4rem; }

.cu-used { color: rgba(255, 255, 255, 0.6); }
.cu-remaining { color: rgba(255, 255, 255, 0.4); }
.cu-dim { color: rgba(255, 255, 255, 0.25); font-weight: 400; }

.cu-meter--warning .cu-used { color: #fbbf24; }
.cu-meter--exhausted .cu-used { color: #f87171; }
</style>
