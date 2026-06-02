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
