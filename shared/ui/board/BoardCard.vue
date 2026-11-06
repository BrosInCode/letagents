<template>
  <article class="board-task-card" :class="{ 'is-blocked': task.status === 'blocked' }" :data-board-task-id="task.id"
    :draggable="draggable" @dragstart="emit('dragstart', $event)" @dragend="emit('dragend')">
    <div class="board-card-heading"><button class="board-card-title" type="button" @click="emit('select')">{{ task.title }}</button><slot name="actions" /></div>
    <p v-if="task.status === 'blocked'" class="board-card-blocked"><BoardIcon name="flag" />Blocked</p>
    <div class="board-card-meta">
      <a v-if="ticketUrl" class="board-card-key" :href="ticketUrl" @click.prevent.stop="emit('external', ticketUrl)"><BoardIcon :name="type" />{{ task.ticket!.key }}</a>
      <span v-else class="board-card-key"><BoardIcon :name="type" />{{ task.ticket?.key || task.id.replace(/^task_/, 'T') }}</span>
      <a v-if="prUrl" class="board-pr" :class="{ 'is-merged': task.pr?.state?.toLowerCase() === 'merged' }" :href="prUrl"
        :aria-label="`Open pull request ${task.pr?.number ? '#' + task.pr.number : ''}`" @click.prevent.stop="emit('external', prUrl)"><BoardIcon name="pr" />{{ task.pr?.number ? '#' + task.pr.number : 'PR' }}</a>
      <span v-if="points !== null && points !== undefined" class="board-card-points" :aria-label="`${points} story points`">{{ points }}</span>
      <span class="board-card-owner" :title="task.assigneeLabel || 'Unassigned'">
        <ChatAvatar v-if="task.assigneeLabel" :name="task.assigneeLabel" :agent="Boolean(task.provider || task.assigneeKey)" :agent-key="task.assigneeKey" :provider="task.provider" :avatar-url="task.avatarUrl" />
        <BoardIcon v-else name="user" />
      </span>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import ChatAvatar from '../ChatAvatar.vue';
import { safeWorkUrl } from '../my-work/model';
import BoardIcon from './BoardIcon.vue';
import type { BoardTask } from './types';
const props = withDefaults(defineProps<{ task: BoardTask; draggable?: boolean; points?: number | null; type?: string }>(), { type: 'task' });
const emit = defineEmits<{ select: []; external: [url: string]; dragstart: [event: DragEvent]; dragend: [] }>();
const prUrl = computed(() => safeWorkUrl(props.task.pr?.url || null));
const ticketUrl = computed(() => safeWorkUrl(props.task.ticket?.url || null));
</script>
