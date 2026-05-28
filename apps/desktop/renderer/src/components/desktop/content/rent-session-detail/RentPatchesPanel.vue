<template>
  <section>
    <p v-if="loading" class="rent-detail-empty">Loading patches...</p>
    <p v-else-if="patches.length === 0" class="rent-detail-empty">No patches yet.</p>
    <article
      v-for="patch in patches"
      v-else
      :key="patch.id"
      class="rent-detail-patch"
      :data-testid="`rent-detail-patch-${patch.id}`"
    >
      <header>
        <strong>{{ patch.summary || "(no summary)" }}</strong>
        <span class="state-pill" :data-state="patchState(patch.gateStatus)">
          {{ patch.gateStatus }}
        </span>
      </header>
      <p v-if="patch.warnings.length" class="rent-detail-warnings">
        <span v-for="warning in patch.warnings" :key="warning">{{ warning }}</span>
      </p>
      <pre v-if="patch.diffPreview">{{ patch.diffPreview }}</pre>
      <p v-else-if="patch.diffRef" class="rent-detail-diff-ref">
        {{ patch.diffRef }}
      </p>
      <ul v-if="patch.checkResults.length" class="rent-detail-checks">
        <li v-for="check in patch.checkResults" :key="check.id">
          <span class="state-pill" :data-state="patchCheckState(check.status)">
            {{ check.status }}
          </span>
          <span>{{ check.label }}</span>
          <small v-if="check.detail">{{ check.detail }}</small>
        </li>
      </ul>
      <a
        v-if="patch.prUrl"
        class="rent-detail-pr-link"
        :href="patch.prUrl"
        target="_blank"
        rel="noreferrer"
      >
        Open PR
      </a>
      <footer
        v-if="canRequestPatchChanges(patch) || canApprovePatch(patch)"
        class="rent-detail-patch-actions"
      >
        <button
          v-if="canRequestPatchChanges(patch)"
          type="button"
          class="rent-create-secondary"
          :data-testid="`rent-detail-patch-request-changes-${patch.id}`"
          :disabled="patchActionBusyFor === patch.id"
          @click="$emit('request-changes', patch.id)"
        >
          {{ patchActionBusyFor === patch.id && patchActionKind === "changes" ? "Requesting..." : "Request changes" }}
        </button>
        <button
          v-if="canApprovePatch(patch)"
          type="button"
          class="rent-create-primary"
          :data-testid="`rent-detail-patch-approve-${patch.id}`"
          :disabled="patchActionBusyFor === patch.id"
          @click="$emit('approve', patch.id)"
        >
          {{ patchActionBusyFor === patch.id && patchActionKind === "approve" ? "Approving..." : "Approve patch" }}
        </button>
      </footer>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { DesktopRentalPatch } from "../../../../../../electron/ipc-types";
import {
  canApprovePatch,
  canRequestPatchChanges,
  patchCheckState,
  patchState,
} from "./presentation";

defineProps<{
  loading: boolean;
  patchActionBusyFor: string | null;
  patchActionKind: "approve" | "changes" | null;
  patches: DesktopRentalPatch[];
}>();

defineEmits<{
  approve: [patchId: string];
  "request-changes": [patchId: string];
}>();
</script>

<style scoped>
.rent-detail-empty {
  opacity: 0.65;
  font-size: 0.9rem;
}
.rent-detail-patch {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
}
.rent-detail-patch header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}
.rent-detail-patch pre {
  margin: 0;
  font-size: 0.78rem;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.04));
  padding: 0.6rem;
  border-radius: 0.4rem;
  max-height: 18rem;
  overflow: auto;
}
.rent-detail-diff-ref {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.78rem;
  color: var(--color-muted, rgba(255, 255, 255, 0.68));
  overflow-wrap: anywhere;
}
.rent-detail-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.35rem;
}
.rent-detail-checks li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.35rem 0.55rem;
  font-size: 0.82rem;
}
.rent-detail-checks small {
  grid-column: 2;
  color: var(--color-muted, rgba(255, 255, 255, 0.62));
  overflow-wrap: anywhere;
}
.rent-detail-pr-link {
  width: fit-content;
  font-size: 0.85rem;
  color: var(--color-accent, #4f7cff);
}
.rent-detail-warnings {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
}
.rent-detail-warnings span {
  background: color-mix(in srgb, var(--color-warning, #f7c948) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warning, #f7c948) 30%, transparent);
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.75rem;
}
.rent-detail-patch-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.4rem;
}
.rent-create-secondary,
.rent-create-primary {
  appearance: none;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
}
.rent-create-secondary {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: inherit;
}
.rent-create-primary {
  border: 1px solid transparent;
  background: var(--color-accent, #4f7cff);
  color: white;
}
.rent-create-secondary:disabled,
.rent-create-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
