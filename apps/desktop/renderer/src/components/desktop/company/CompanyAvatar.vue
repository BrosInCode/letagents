<template>
  <span class="company-avatar" :data-size="size" :data-kind="all ? 'all' : 'company'" aria-hidden="true">
    <Layers v-if="all" />
    <img v-else-if="avatarUrl && !failed" :src="avatarUrl" alt="" @error="failed = true">
    <span v-else>{{ initial }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Layers } from "@lucide/vue";

const props = withDefaults(defineProps<{
  login?: string | null;
  avatarUrl?: string | null;
  /** The "All rooms" choice, which has no company. */
  all?: boolean;
  size?: "s" | "m" | "l" | "xl";
}>(), { login: null, avatarUrl: null, all: false, size: "l" });

const failed = ref(false);
watch(() => props.avatarUrl, () => { failed.value = false; });
const initial = computed(() => (props.login?.trim()[0] || "?").toUpperCase());
</script>

<style scoped>
.company-avatar {
  display: inline-grid;
  flex: none;
  place-items: center;
  overflow: hidden;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.company-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.company-avatar svg {
  width: 17px;
  height: 17px;
}

.company-avatar[data-size="s"] {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: 9.5px;
}

.company-avatar[data-size="s"] svg {
  width: 11px;
  height: 11px;
}

.company-avatar[data-size="m"] {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  font-size: 11px;
}

.company-avatar[data-size="m"] svg {
  width: 14px;
  height: 14px;
}

.company-avatar[data-size="xl"] {
  width: 52px;
  height: 52px;
  border-radius: 13px;
  font-size: 18px;
}
</style>
