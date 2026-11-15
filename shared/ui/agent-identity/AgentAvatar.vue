<template>
  <span class="agent-identity-avatar" :style="{ width: `${size}px`, height: `${size}px`, '--avatar-color': finish.shell }">
    <img v-if="portrait" :src="portrait" :alt="name" draggable="false" />
    <span v-else class="agent-identity-initials" :aria-label="name">{{ initials }}</span>
  </span>
</template>
<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import type { AgentAvatar } from '../../../src/shared/agent-avatar';
import { avatarFinish } from './avatar-catalog';
import { avatarPortraits, requestAvatarPortrait } from './avatar-portraits';
const props = withDefaults(defineProps<{ avatar?: AgentAvatar | null; name?: string; size?: number }>(), { name: 'Agent', size: 40 });
const finish = computed(() => avatarFinish(props.avatar && 'color' in props.avatar ? props.avatar.color : 'sage'));
const initials = computed(() => props.name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toLocaleUpperCase() || 'A');
const portrait = computed(() => props.avatar?.kind === 'image' ? props.avatar.dataUrl : props.avatar?.kind === 'character' ? avatarPortraits.get(`${props.avatar.character}/${props.avatar.color}`) : null);
watchEffect(() => { if (props.avatar?.kind === 'character') requestAvatarPortrait(props.avatar.character, props.avatar.color); });
</script>
<style scoped>
.agent-identity-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;vertical-align:middle}
.agent-identity-avatar img{width:100%;height:100%;object-fit:contain;user-select:none}
.agent-identity-initials{display:grid;place-items:center;width:80%;height:80%;border-radius:28%;background:color-mix(in srgb,var(--avatar-color) 20%,transparent);color:var(--text-primary,light-dark(#222,#eee));font-size:1em;font-weight:600}
</style>
