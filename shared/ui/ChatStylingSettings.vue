<template>
  <section class="chat-styling" aria-label="Chat styling">
    <div class="styling-heading"><h2>Message colors</h2><button type="button" :disabled="isDefault" @click="reset">Reset</button></div>
    <p class="styling-note">Your colors, on this device. Everyone else keeps their own.</p>
    <div class="styling-layout">
      <div class="styling-colors">
      <section v-for="group in groups" :key="group.title" class="styling-group">
        <h3>{{ group.title }}</h3>
        <div v-for="role in group.roles" :key="role.id" class="styling-role">
          <span>{{ role.label }}</span>
          <div class="styling-role-controls">
            <button v-if="overrides[role.id]" type="button" class="use-theme" :aria-label="'Use theme color for ' + role.label" @click="useTheme(role.id)">Use theme</button>
            <ColorPalette :label="role.label" :model-value="colors[role.id]" :follows-theme="!overrides[role.id]" :theme-preview="styleFor(role.id)['--chat-bubble']" @update:model-value="setColor(role.id, $event)" />
          </div>
        </div>
      </section>
      </div>
      <div class="styling-preview" aria-label="Message color preview">
        <div v-for="message in preview" :key="message.role" class="preview-message" :data-side="message.side" :style="styleFor(message.role)">
          <span>{{ message.name }}</span><p>{{ message.text }}</p>
        </div>
      </div>
    </div>
    <p v-if="!saved" class="styling-save-error" role="status">Colors apply now, but this browser could not save them.</p>
  </section>
</template>

<script setup lang="ts">
import ColorPalette from './ColorPalette.vue';
import { useChatStyling } from './chat-styling';
const { colors, overrides, saved, isDefault, styleFor, setColor, useTheme, reset } = useChatStyling();
const groups = [
  { title: 'Your side', roles: [{ id: 'self', label: 'You' }, { id: 'own-agent', label: 'Your agents' }] },
  { title: 'Other people', roles: [{ id: 'human', label: 'Other humans' }, { id: 'other-agent', label: 'Other agents' }] },
] as const;
const preview = [
  { role: 'human', side: 'left', name: 'Ada', text: 'Ready for a second look?' },
  { role: 'other-agent', side: 'left', name: 'Ada’s agent', text: 'The changes are ready to review.' },
  { role: 'self', side: 'right', name: 'You', text: 'Let’s take a look.' },
  { role: 'own-agent', side: 'right', name: 'Your agent', text: 'I’ll check the details.' },
] as const;
</script>

<style scoped>
.chat-styling { color: light-dark(#242424, #eee); max-width: 760px; container-type: inline-size; }
.styling-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.styling-heading h2 { margin: 0; font-size: 17px; font-weight: 600; }
.styling-heading button { color: inherit; background: transparent; border: 1px solid light-dark(#ccc,#333); border-radius: 8px; padding: 7px 12px; cursor: pointer; font: inherit; font-size: 12px; }
.styling-heading button:disabled { opacity: .4; cursor: default; }
.styling-note { margin: 10px 0 28px; color: light-dark(#666,#999); font-size: 13px; line-height: 1.5; }
.styling-layout { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); align-items: start; gap: 28px; }
.styling-colors { display: grid; gap: 24px; }
.styling-group { min-width: 0; }
.styling-group h3 { color: light-dark(#666,#999); font-size: 12px; font-weight: 500; margin: 0 0 8px; }
.styling-role { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; font-size: 13px; }
.styling-role-controls { display: flex; align-items: center; gap: 5px; }
.use-theme { color: inherit; font: inherit; font-size: 11px; border: 0; border-radius: 5px; background: transparent; cursor: pointer; min-height: 32px; }
.styling-preview { display: flex; flex-direction: column; gap: 15px; padding: 20px 16px; border-radius: 18px; background: light-dark(#eee,#080808); border: 1px solid light-dark(#ddd,#262626); }
.preview-message { max-width: 85%; align-self: flex-start; }
.preview-message[data-side="right"] { align-self: flex-end; text-align: right; }
.preview-message > span { display: block; margin: 0 10px 5px; font-size: 11px; color: light-dark(#666,#999); }
.preview-message p { margin: 0; padding: 11px 16px; border-radius: 22px; text-align: left; color: var(--chat-foreground); background: linear-gradient(125deg,var(--chat-bubble-start),var(--chat-bubble) 48%,var(--chat-bubble-end)); font-size: 14px; line-height: 1.6; }
.styling-save-error { font-size: 12px; color: light-dark(#92571b,#dcb67f); }
.styling-heading button:focus-visible { outline: 2px solid light-dark(#315b8c,#a9c7ec); outline-offset: 3px; }
@container (max-width: 580px) { .styling-layout { grid-template-columns: minmax(0,1fr); } }
</style>
