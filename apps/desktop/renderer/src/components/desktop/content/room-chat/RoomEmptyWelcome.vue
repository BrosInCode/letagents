<template>
  <article class="room-empty-welcome" data-testid="room-chat-empty">
    <div class="welcome-bubbles" aria-hidden="true">
      <div class="welcome-bubble-back"></div>
      <div class="welcome-bubble-front"><i></i><i></i><i></i></div>
    </div>
    <h3>Welcome to {{ roomName }}{{ viewerName ? `, ${viewerName}` : "" }}.</h3>
    <p>Send a message to start the conversation.</p>
    <button class="room-tour-start" type="button" aria-haspopup="dialog" @click="$emit('tour')">
      <Compass aria-hidden="true" /> Quick tour <ArrowUpRight aria-hidden="true" />
    </button>
  </article>
</template>

<script setup lang="ts">
import { ArrowUpRight, Compass } from "@lucide/vue";
defineProps<{ roomName: string; viewerName?: string | null }>();
defineEmits<{ tour: [] }>();
</script>

<style scoped>
.room-empty-welcome {
  position: relative;
  align-self: center;
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 13px;
  width: min(100%, var(--room-chat-content-max, 920px));
  min-height: min(480px, 65vh);
  padding: 42px 20px;
  text-align: center;
  animation: room-welcome-in 300ms cubic-bezier(.16,1,.3,1) both;
}
.room-empty-welcome h3 { margin: 0; color: var(--text); font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: clamp(30px, 4.7vw, 53px); font-weight: 500; line-height: 1.08; letter-spacing: -.035em; text-wrap: balance; }
.room-empty-welcome p { margin: 0; color: var(--text-secondary); }
.welcome-bubbles { position: relative; width: 142px; height: 95px; margin-bottom: 4px; }
.welcome-bubble-back, .welcome-bubble-front { position: absolute; height: 58px; width: 96px; border-radius: 21px; border: 1px solid var(--workspace-border, var(--border)); }
.welcome-bubble-back { right: 2px; bottom: 10px; background: var(--workspace-sidebar, var(--bg-subtle)); transform: rotate(9deg); }
.welcome-bubble-front { top: 10px; display: flex; justify-content: center; align-items: center; gap: 8px; background: var(--workspace-composer, var(--bg-card)); transform: rotate(-8deg); }
.welcome-bubble-front::after, .welcome-bubble-back::after { content: ""; position: absolute; bottom: -5px; width: 10px; height: 10px; background: inherit; border: inherit; border-top: 0; border-left: 0; transform: rotate(45deg); }
.welcome-bubble-front::after { left: 21px; }
.welcome-bubble-back::after { right: 20px; }
.welcome-bubble-front i { width: 5px; height: 5px; border-radius: 50%; background: var(--workspace-accent, var(--text-secondary)); }
.room-tour-start { display: inline-flex; align-items: center; gap: 9px; min-height: 40px; margin-top: 9px; padding: 0 12px; border: 1px solid var(--workspace-border, var(--border)); border-radius: 10px; background: var(--workspace-composer, var(--bg-card)); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
.room-tour-start svg { width: 14px; height: 14px; color: var(--workspace-accent, var(--text-secondary)); }
.room-tour-start:hover { border-color: var(--workspace-accent, var(--text-secondary)); }
.room-tour-start:focus-visible { outline: 2px solid var(--workspace-accent, var(--text)); outline-offset: 3px; }
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  .welcome-bubbles:hover i { animation: room-typing 760ms ease-in-out infinite; }
  .welcome-bubbles:hover i:nth-child(2) { animation-delay: 100ms; }
  .welcome-bubbles:hover i:nth-child(3) { animation-delay: 200ms; }
}
@keyframes room-typing { 0%, 65%, 100% { opacity: .65; transform: none; } 30% { opacity: 1; transform: translateY(-4px); } }
@keyframes room-welcome-in { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .room-empty-welcome { animation: none; } }
</style>
