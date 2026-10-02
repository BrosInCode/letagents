<template>
  <button v-if="reference && room" type="button" class="pull-request-changes-button" @click="open = true">View changes</button>
  <PullRequestChangesDialog
    v-if="open && reference && room"
    :room="room" :number="reference.number" :github-url="reference.url"
    @close="open = false"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { usePullRequestDiffContext } from "../../../../composables/usePullRequestDiffContext";
import { pullRequestReference } from "../../../../domain/pull-request-diff";
import PullRequestChangesDialog from "./PullRequestChangesDialog.vue";

const props = defineProps<{ url: string | null }>();
const context = usePullRequestDiffContext();
const room = computed(() => context?.room.value ?? "");
const reference = computed(() => pullRequestReference(props.url, context?.repository.value ?? null));
const open = ref(false);
watch([room, () => reference.value?.url], () => { open.value = false; }, { flush: "sync" });
</script>

<style scoped>
.pull-request-changes-button { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; background: var(--bg-card); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
.pull-request-changes-button:hover { background: var(--accent-hover); }
.pull-request-changes-button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
</style>
