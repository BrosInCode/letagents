<template>
  <section
    v-if="visible"
    class="repo-state-strip"
    aria-label="Repository state"
    data-testid="repo-state-strip"
  >
    <div class="repo-state-strip-main">
      <span class="repo-state-strip-ref">
        <GitBranch :size="14" aria-hidden="true" />
        <strong>{{ branchLabel }}</strong>
      </span>
      <span v-if="repoStatus.detached" class="repo-state-strip-warning">
        <TriangleAlert :size="13" aria-hidden="true" />
        detached
      </span>
    </div>

    <dl class="repo-state-strip-facts">
      <div
        v-for="item in items"
        :key="item.key"
        class="repo-state-strip-fact"
        :data-tone="item.tone"
        :data-testid="`repo-state-strip-${item.key}`"
      >
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { GitBranch, TriangleAlert } from "@lucide/vue";
import { computed } from "vue";
import type { DesktopRoomInfo, RepoStatus } from "../../../../../electron/ipc-types";
import {
  repoStateBranchLabel,
  repoStateStripItems,
  shouldShowRepoStateForRoom,
} from "../../../domain/repo-state-strip";

const props = defineProps<{
  room: DesktopRoomInfo;
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
}>();

const visible = computed(() =>
  shouldShowRepoStateForRoom(props.room, props.repoStatus, props.gitRoomMatchesActiveRepo)
);
const branchLabel = computed(() => repoStateBranchLabel(props.repoStatus));
const items = computed(() => repoStateStripItems(props.repoStatus));
</script>

<style scoped>
.repo-state-strip {
  display: flex;
  align-items: stretch;
  gap: 12px;
  padding: 8px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  color: rgba(255, 255, 255, 0.84);
}

.repo-state-strip-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 180px;
  max-width: 280px;
}

.repo-state-strip-ref,
.repo-state-strip-warning {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.repo-state-strip-ref strong,
.repo-state-strip-warning {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-state-strip-ref strong {
  font-size: 0.82rem;
  line-height: 1.2;
  color: rgba(255, 255, 255, 0.94);
}

.repo-state-strip-warning {
  flex: 0 0 auto;
  color: #f4c06a;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}

.repo-state-strip-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex: 1;
  gap: 1px;
  min-width: 0;
  margin: 0;
  border-radius: 6px;
  overflow: hidden;
}

.repo-state-strip-fact {
  min-width: 0;
  padding: 2px 10px;
  background: rgba(255, 255, 255, 0.035);
}

.repo-state-strip-fact[data-tone="attention"] {
  background: rgba(244, 192, 106, 0.11);
}

.repo-state-strip-fact[data-tone="danger"] {
  background: rgba(255, 91, 116, 0.13);
}

.repo-state-strip-fact dt,
.repo-state-strip-fact dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-state-strip-fact dt {
  margin: 0;
  color: rgba(255, 255, 255, 0.46);
  font-size: 0.64rem;
  font-weight: 700;
  line-height: 1.15;
  text-transform: uppercase;
}

.repo-state-strip-fact dd {
  margin: 1px 0 0;
  color: rgba(255, 255, 255, 0.86);
  font-size: 0.74rem;
  font-weight: 700;
  line-height: 1.25;
}

@media (max-width: 900px) {
  .repo-state-strip {
    flex-direction: column;
    gap: 8px;
    padding-inline: 16px;
  }

  .repo-state-strip-main {
    max-width: none;
  }

  .repo-state-strip-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
