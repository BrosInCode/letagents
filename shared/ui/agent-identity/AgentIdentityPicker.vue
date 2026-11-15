<template>
  <section class="agent-identity-picker" :class="{ compact }" aria-label="Agent identity">
    <div class="identity-studio">
      <div class="identity-modes" aria-label="Avatar style">
        <button type="button" :aria-pressed="modelValue.kind === 'character'" @click="chooseMode('character')">Character</button>
        <button type="button" :aria-pressed="modelValue.kind === 'initials'" @click="chooseMode('initials')">Initials</button>
        <button type="button" :aria-pressed="modelValue.kind === 'image'" aria-label="Upload avatar image" @click="fileInput?.click()"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1"/><path d="m3 16 5-5 5 5 4-4 4 4"/></svg></button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="upload" />
      </div>
      <div ref="stage" class="identity-live-stage" :class="{ invisible: modelValue.kind !== 'character' || failed }" />
      <div v-if="modelValue.kind !== 'character' || failed" class="identity-fallback" data-agent-avatar-source><AgentAvatar :avatar="modelValue" :name="name" :size="compact ? 112 : 160" /></div>
      <div class="identity-studio-caption"><span>{{ modelValue.kind === 'character' ? characterNames[modelValue.character] : modelValue.kind === 'initials' ? 'Initials' : 'Your image' }}</span><span v-if="modelValue.kind === 'character'">{{ String(characterIndex + 1).padStart(2, '0') }} / {{ characterIds.length }}</span></div>
    </div>
    <div v-if="modelValue.kind !== 'image'" class="identity-colors" role="group" aria-label="Avatar colour">
      <button v-for="color in avatarColors" :key="color.id" type="button" :aria-label="color.name" :title="color.name" :aria-pressed="color.id === selectedColor" :style="{ '--swatch': color.shell }" @click="chooseColor(color.id)" />
    </div>
    <div v-if="modelValue.kind === 'character'" ref="rail" class="identity-character-rail" role="group" aria-roledescription="carousel" aria-label="Choose a character" @pointerdown="startDrag" @pointermove="drag" @pointerup="endDrag" @pointercancel="endDrag" @click.capture="preventDragClick" @keydown="moveCharacter">
      <button v-for="id in characterIds" :key="id" type="button" :aria-label="characterNames[id]" :aria-pressed="id === modelValue.character" :tabindex="id === modelValue.character ? 0 : -1" :data-character="id" @click="chooseCharacter(id)"><AgentAvatar :avatar="{ kind: 'character', character: id, color: selectedColor }" :name="characterNames[id]" :size="compact ? 50 : 64" /></button>
    </div>
    <div class="identity-name-heading"><label :for="nameId">Name</label><button type="button" @click="suggest">Suggest a name <span aria-hidden="true">↗</span></button></div>
    <input :id="nameId" class="identity-name" :value="name" maxlength="32" placeholder="Give your agent a name" autocomplete="off" :aria-invalid="Boolean(error)" @input="emit('update:name', ($event.target as HTMLInputElement).value)" @change="emit('update:name', ($event.target as HTMLInputElement).value)" />
    <p v-if="error || uploadError" class="identity-error" role="alert">{{ error || uploadError }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { normalizeAgentAvatar } from '../../../src/shared/agent-avatar';
import type { AgentAvatar as Avatar, AgentAvatarCharacter, AgentAvatarColor } from '../../../src/shared/agent-avatar';
import AgentAvatar from './AgentAvatar.vue';
import { avatarColors, avatarFinish, characterNames } from './avatar-catalog';
import { rememberAvatarPortrait } from './avatar-portraits';
import type { AvatarPreview } from './scene/avatar-3d';
const props = withDefaults(defineProps<{ modelValue: Avatar; name: string; compact?: boolean; active?: boolean; animate?: boolean; error?: string }>(), { compact: false, active: true, animate: true, error: '' });
const emit = defineEmits<{ 'update:modelValue': [value: Avatar]; 'update:name': [value: string]; select: [value: Avatar] }>();
const nameId = `agent-name-${useId()}`;
const stage = ref<HTMLElement>(); const rail = ref<HTMLElement>(); const fileInput = ref<HTMLInputElement>();
const failed = ref(false); const uploadError = ref(''); const reduced = ref(false);
const characterIds = Object.keys(characterNames) as AgentAvatarCharacter[];
const selectedColor = computed(() => props.modelValue.kind === 'image' ? 'sage' : props.modelValue.color);
const characterIndex = computed(() => props.modelValue.kind === 'character' ? characterIds.indexOf(props.modelValue.character) : 0);
let preview: AvatarPreview | undefined; let disposed = false; let uploadVersion = 0;
let lastCharacter: AgentAvatarCharacter = 'orbit';
function choose(value: Avatar) { uploadVersion++; uploadError.value = ''; emit('update:modelValue', value); emit('select', value); }
function chooseMode(kind: 'character' | 'initials') { choose(kind === 'character' ? { kind, character: lastCharacter, color: selectedColor.value } : { kind, color: selectedColor.value }); }
function chooseColor(id: string) { if (props.modelValue.kind !== 'image') choose({ ...props.modelValue, color: id as AgentAvatarColor }); }
function chooseCharacter(character: AgentAvatarCharacter) { choose({ kind: 'character', character, color: selectedColor.value }); }
function suggest() { const names = ['Atlas', 'Scout', 'Nova', 'Milo', 'Echo', 'Sage', 'Reviewer', 'Builder']; emit('update:name', names[(names.indexOf(props.name) + 1) % names.length]); }
function moveCharacter(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? characterIds.length - 1 : (characterIndex.value + (event.key === 'ArrowRight' ? 1 : -1) + characterIds.length) % characterIds.length;
  chooseCharacter(characterIds[index]); void nextTick(() => { const button = rail.value?.querySelector<HTMLButtonElement>(`[data-character="${characterIds[index]}"]`); button?.focus({ preventScroll: true }); button?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'instant' }); });
}
let gesture: { id: number; x: number; y: number; scroll: number; moved: boolean } | null = null; let suppressClick = false;
function startDrag(event: PointerEvent) { if (event.pointerType !== 'mouse' || event.button !== 0 || !rail.value) return; suppressClick = false; gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: rail.value.scrollLeft, moved: false }; }
function drag(event: PointerEvent) { if (!gesture || gesture.id !== event.pointerId || !rail.value) return; const dx = event.clientX - gesture.x; if (Math.abs(dx) < 6 && !gesture.moved) return; gesture.moved = true; rail.value.setPointerCapture(event.pointerId); rail.value.scrollLeft = gesture.scroll - dx; }
function endDrag() { suppressClick = Boolean(gesture?.moved); gesture = null; }
function preventDragClick(event: MouseEvent) { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; if (!file) return;
  const version = ++uploadVersion; uploadError.value = '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { uploadError.value = 'Choose a PNG, JPEG or WebP image under 5 MB.'; return; }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (disposed || version !== uploadVersion) return;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image canvas unavailable');
    const edge = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 96, 96);
    const dataUrl = canvas.toDataURL('image/png');
    const avatar = normalizeAgentAvatar({ kind: 'image', dataUrl });
    if (!avatar) throw new Error('Image too detailed');
    choose(avatar);
  } catch { if (!disposed && version === uploadVersion) uploadError.value = 'This image could not be used. Choose another image.'; }
  finally { bitmap?.close(); }
}
function sync() {
  if (!preview) return;
  if (props.modelValue.kind === 'character') { const prior = lastCharacter; lastCharacter = props.modelValue.character; preview.setCharacter(lastCharacter, avatarFinish(props.modelValue.color), { animate: props.animate && !reduced.value, direction: characterIds.indexOf(lastCharacter) >= characterIds.indexOf(prior) ? 1 : -1 }); }
  preview.setState({ active: props.active && props.modelValue.kind === 'character', animate: props.animate && !reduced.value });
}
let media: MediaQueryList | undefined;
function motionChange() { reduced.value = Boolean(media?.matches); sync(); }
onMounted(async () => {
  media = matchMedia('(prefers-reduced-motion: reduce)'); motionChange(); media.addEventListener('change', motionChange);
  try { const module = await import('./scene/avatar-3d.js'); if (disposed || !stage.value) return;
    preview = module.createAvatarPreview(stage.value, { character: props.modelValue.kind === 'character' ? props.modelValue.character : 'orbit', characterNames, palette: avatarFinish(selectedColor.value), onPortrait: rememberAvatarPortrait, onUnavailable: () => { failed.value = true; } }); sync();
  } catch { failed.value = true; }
});
watch(() => [props.modelValue, props.active, props.animate], sync, { deep: true });
onBeforeUnmount(() => { disposed = true; uploadVersion++; media?.removeEventListener('change', motionChange); preview?.dispose(); });
</script>
<style scoped>
.agent-identity-picker{--identity-bg:var(--bg-0,light-dark(#fff,#090909));color:var(--text-primary,light-dark(#222,#eee))}.identity-studio{height:245px;position:relative;overflow:hidden;border-radius:24px;background:radial-gradient(ellipse at 50% 60%,color-mix(in srgb,#83b49b 9%,transparent),transparent 70%),var(--bg-1,light-dark(#f6f6f4,#111))}.identity-live-stage{position:absolute;inset:32px 0 8px}.identity-live-stage.invisible{visibility:hidden}.identity-live-stage :deep(canvas){width:100%;height:100%;outline-offset:-8px}.identity-live-stage :deep(.avatar-hint){position:absolute;bottom:8px;left:0;right:0;text-align:center;font-size:10px;color:var(--text-tertiary,#888);opacity:0;transition:opacity 160ms}.identity-live-stage:hover :deep(.avatar-hint),.identity-live-stage:focus-within :deep(.avatar-hint){opacity:1}.identity-modes{position:absolute;z-index:1;right:14px;top:14px;display:flex;padding:4px;gap:3px;border-radius:12px;background:var(--identity-bg)}.identity-modes button{border:0;border-radius:8px;background:none;color:var(--text-secondary,#999);font:inherit;font-size:12px;padding:7px 9px;cursor:pointer}.identity-modes button[aria-pressed=true]{color:var(--text-primary,#eee);background:var(--bg-2,light-dark(#e5e5e3,#252525))}.identity-modes svg{height:17px;width:17px;fill:none;stroke:currentColor;stroke-width:1.6}.identity-fallback{height:100%;display:grid;place-items:center;font-size:48px}.identity-studio-caption{position:absolute;bottom:16px;left:20px;right:20px;display:flex;justify-content:space-between;font-size:12px;pointer-events:none}.identity-studio-caption span+span{color:var(--text-tertiary,#888);letter-spacing:2px}.identity-colors{display:flex;justify-content:center;gap:14px;padding:18px 0}.identity-colors button{width:22px;height:22px;background:var(--swatch);border:3px solid var(--identity-bg);border-radius:50%;outline:1px solid transparent;cursor:pointer}.identity-colors button[aria-pressed=true]{outline-color:var(--swatch)}.identity-character-rail{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;touch-action:pan-x;overscroll-behavior-x:contain;padding:4px 0 12px;cursor:grab}.identity-character-rail::-webkit-scrollbar{display:none}.identity-character-rail button{flex:0 0 76px;display:grid;place-items:center;border:0;border-radius:14px;background:none;cursor:pointer;transition:transform 180ms,background 180ms}.identity-character-rail button[aria-pressed=true]{background:var(--bg-1,light-dark(#eee,#151515))}.identity-character-rail button:active{transform:scale(.95)}.identity-name-heading{display:flex;justify-content:space-between;align-items:center;margin:10px 0 12px;font-size:14px}.identity-name-heading button{font:inherit;font-size:12px;color:var(--text-secondary,#999);background:none;border:0;padding:6px;cursor:pointer}.identity-name{box-sizing:border-box;width:100%;border:1px solid var(--border,light-dark(#ddd,#2b2b2b));border-radius:14px;background:var(--bg-1,light-dark(#f5f5f3,#121212));color:inherit;padding:14px 16px;font:inherit;font-size:24px;outline-offset:3px}.identity-error{font-size:13px;color:var(--error,#e7a398)}.compact .identity-studio{height:164px}.compact .identity-live-stage{inset:25px 0 0}.compact .identity-character-rail button{flex-basis:56px}.compact .identity-name{font-size:18px;padding:10px 13px}.compact .identity-colors{padding:12px 0;gap:12px}button:focus-visible{outline:2px solid var(--focus-ring,#aaa);outline-offset:3px}@media(prefers-reduced-motion:reduce){.identity-character-rail button{transition:none}}
</style>
