<template>
  <div class="git-room-meta" aria-label="Git room metadata">
    <span class="git-room-badge">Git Room</span>
    <span class="git-room-item provider-item" :title="providerLabel">
      <GitHubIcon v-if="gitRoom.provider === 'github'" :size="14" />
      <span>{{ providerLabel }}</span>
    </span>
    <span class="git-room-item repo-item" :title="gitRoom.repository.full_name">
      <RepositoryIcon :size="14" />
      <span>{{ gitRoom.repository.full_name }}</span>
    </span>
    <span class="git-room-item ref-item" :title="refTitle">
      <GitPullRequestIcon v-if="gitRoom.ref.type === 'pull_request'" :size="14" />
      <TagIcon v-else-if="gitRoom.ref.type === 'tag'" :size="14" />
      <GitBranchIcon v-else :size="14" />
      <span>{{ refLabel }}</span>
    </span>
    <span class="git-room-item access-item" :title="accessTitle">
      <LockIcon v-if="gitRoom.access_mode === 'private'" :size="14" />
      <GlobeIcon v-else-if="gitRoom.access_mode === 'public'" :size="14" />
      <InfoIcon v-else :size="14" />
      <span>{{ accessLabel }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import GitBranchIcon from '@/components/icons/GitBranchIcon.vue'
import GitHubIcon from '@/components/icons/GitHubIcon.vue'
import GitPullRequestIcon from '@/components/icons/GitPullRequestIcon.vue'
import GlobeIcon from '@/components/icons/GlobeIcon.vue'
import InfoIcon from '@/components/icons/InfoIcon.vue'
import LockIcon from '@/components/icons/LockIcon.vue'
import RepositoryIcon from '@/components/icons/RepositoryIcon.vue'
import TagIcon from '@/components/icons/TagIcon.vue'
import {
  gitRoomAccessLabel,
  gitRoomAccessTitle,
  gitRoomProviderLabel,
  gitRoomRefLabel,
  gitRoomRefTitle,
} from './gitRoomLabels'
import type { GitRoomInfo } from '@/composables/useRoom'

const props = defineProps<{
  gitRoom: GitRoomInfo
}>()

const providerLabel = computed(() => gitRoomProviderLabel(props.gitRoom))
const refLabel = computed(() => gitRoomRefLabel(props.gitRoom))
const refTitle = computed(() => gitRoomRefTitle(props.gitRoom))
const accessLabel = computed(() => gitRoomAccessLabel(props.gitRoom))
const accessTitle = computed(() => gitRoomAccessTitle(props.gitRoom))
</script>

<style scoped>
.git-room-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(520px, 34vw);
  height: 34px;
  padding: 0 8px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 72%, transparent);
  color: var(--muted, #71717a);
}

.git-room-badge,
.git-room-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 22px;
  font-size: 0.7rem;
  line-height: 1;
  white-space: nowrap;
}

.git-room-badge {
  flex: 0 0 auto;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  font-weight: 700;
}

.git-room-item {
  flex: 0 1 auto;
  overflow: hidden;
}

.git-room-item svg {
  flex: 0 0 auto;
}

.provider-item,
.access-item {
  flex: 0 0 auto;
}

.repo-item {
  color: var(--text, #fafafa);
  font-weight: 600;
}

.repo-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ref-item {
  max-width: 120px;
}

.ref-item span,
.access-item span,
.provider-item span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.access-item {
  color: var(--muted, #71717a);
}

@media (max-width: 1120px) {
  .git-room-meta {
    max-width: 26vw;
  }

  .provider-item span,
  .access-item span {
    display: none;
  }
}

@media (max-width: 980px) {
  .git-room-meta {
    display: none;
  }
}
</style>
