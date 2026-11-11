<template>
  <Teleport to="body">
    <Transition name="room-erasure" @after-leave="restoreInvoker">
      <div v-if="visible && target" class="room-erasure" :class="{ 'room-erasure-leaving': phase === 'removed', 'room-erasure-archiving': operation === 'archive', 'room-erasure-keyboard': keyboard }" :style="{ '--room-sidebar-edge': sidebarEdge + 'px' }" @keydown.esc.stop.prevent="cancel" @keydown.tab="trapFocusInDialog($event, panel)">
        <div class="room-erasure-dimmer" @click="cancel"></div>
        <div class="room-erasure-affected" aria-hidden="true">
          <div v-for="(row,index) in rows" :key="row.title" class="room-erasure-row" :class="{ 'is-child': index > 0 }" :style="{ left: row.left + 'px', top: row.top + 'px', width: row.width + 'px', height: row.height + 'px', '--row-delay': Math.min(index, 2) * 25 + 'ms' }">
            <svg v-if="!row.isFocus" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none"><path d="M4 4h16v12H8l-4 4Z"/></svg>
            <span>{{ row.title }}</span>
            <svg class="row-minus" viewBox="0 0 24 24" fill="none"><path d="M6 12h12"/></svg>
          </div>
        </div>
        <section ref="panel" class="room-erasure-stage" role="dialog" aria-modal="true" aria-labelledby="room-erasure-title" aria-describedby="room-erasure-warning" tabindex="-1" :aria-busy="busy || phase !== 'confirm'">
          <header class="room-erasure-header">
            <span>Rooms <span aria-hidden="true">/</span> {{ target.displayName }}</span>
            <button ref="cancelButton" type="button" class="room-erasure-cancel" :disabled="busy || phase !== 'confirm'" @click="cancel">Cancel <span aria-hidden="true">Esc</span></button>
          </header>
          <div class="room-erasure-body">
            <div class="room-erasure-heading">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>
              <h1 id="room-erasure-title">Delete {{ target.displayName }}?</h1>
            </div>
            <p id="room-erasure-warning" class="room-erasure-warning">The room{{ impact ? (impact.children.length ? ` and its ${impact.children.length} focus rooms` : '') : ' and its focus rooms' }} will be permanently deleted{{ impact?.localOnly ? ' from this device' : ' for everyone' }}. <strong>This cannot be undone.</strong></p>
            <div class="room-erasure-impact">
              <p v-if="previewLoading" class="room-erasure-loading" role="status">Loading room details…</p>
              <p v-else-if="previewError" class="room-erasure-error" role="alert">{{ previewError }} <button type="button" class="room-erasure-details-toggle" @click="loadPreview">Try again</button></p>
              <p v-if="impact" class="room-erasure-inventory" aria-label="Content that will be deleted">
                <span v-for="item in inventory" :key="item.label"><strong v-if="item.count !== null">{{ item.count }}</strong> {{ item.label }}</span>
              </p>
              <button v-if="impact?.children.length" type="button" class="room-erasure-details-toggle" :aria-expanded="showDetails" aria-controls="room-erasure-details" @click="showDetails = !showDetails">
                {{ showDetails ? 'Hide details' : 'Show details' }}
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path :d="showDetails ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'"/></svg>
              </button>
              <ul v-if="showDetails" id="room-erasure-details" class="room-erasure-details" aria-label="Focus rooms that will also be deleted">
                <li v-for="child in impact?.children" :key="child.roomIdentifier"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4h16v12H8l-4 4Z"/></svg>{{ child.displayName }}</li>
              </ul>
            </div>
            <p class="room-erasure-kept">Your code, branches and pull requests are kept.</p>
            <form class="room-erasure-confirm" @submit.prevent="submit">
              <label for="room-erasure-name">To confirm, type <strong>{{ target.displayName }}</strong>.</label>
              <div class="room-erasure-controls">
                <input ref="confirmationInput" id="room-erasure-name" v-model="confirmation" :disabled="busy || phase !== 'confirm'" :aria-invalid="validationError ? true : undefined" :aria-describedby="validationError ? 'room-erasure-confirmation-error' : undefined" autocomplete="off" spellcheck="false" placeholder="Enter room name" @input="validationError = ''" />
                <button type="submit" class="room-erasure-delete" :data-confirmed="confirmation === target.displayName" :disabled="busy || phase !== 'confirm' || previewLoading || Boolean(previewError)">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>
                  {{ busy || phase === 'deleting' ? 'Deleting…' : 'Delete room' }}
                </button>
              </div>
            </form>
            <p v-if="validationError || error || localError" id="room-erasure-confirmation-error" class="room-erasure-error" role="alert">{{ validationError || error || localError }}</p>
            <div class="room-erasure-alternative">
              <div><strong>Keep it for later</strong><p>Archive to hide it. Restore it anytime.</p></div>
              <button type="button" class="room-erasure-archive" :disabled="busy || phase !== 'confirm'" @click="archive">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 3h18v5H3Zm2 5v13h14V8m-10 5h6"/></svg>
                Archive instead
              </button>
            </div>
          </div>
        </section>
      </div>
    </Transition>
    <div v-if="notice" class="room-erasure-notice" role="status">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
      <span><strong>{{ notice.displayName }} archived.</strong><small>{{ restoreError || "Everything is kept." }}</small></span>
      <button type="button" :disabled="restoring" @click="undoArchive">{{ restoring ? "Restoring…" : "Undo" }}</button>
      <button type="button" aria-label="Dismiss notification" @click="notice = null">×</button>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopRoomDeletionPreview } from "../../../../../electron/ipc-types/api.js";
import { desktopIpc } from "../../../ipc/index.js";
import { trapFocusInDialog } from "./modal-focus";

type RoomTarget = { roomIdentifier: string; displayName: string };
type AffectedRow = { title: string; isFocus: boolean; left: number; top: number; width: number; height: number };
const props = defineProps<{ room: RoomTarget | null; busy: boolean; error?: string | null }>();
const emit = defineEmits<{ close: []; confirm: [confirmation: string]; archived: [room: RoomTarget]; restored: [] }>();
const target = ref<RoomTarget | null>(null);
const visible = ref(false);
const confirmation = ref("");
const phase = ref<"confirm" | "deleting" | "archiving" | "removed">("confirm");
const operation = ref<"delete" | "archive">("delete");
const localError = ref("");
const rows = ref<AffectedRow[]>([]);
const sidebarEdge = ref(280);
const panel = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const confirmationInput = ref<HTMLInputElement | null>(null);
const notice = ref<RoomTarget | null>(null);
const restoring = ref(false);
const restoreError = ref("");
const keyboard = ref(false);
const validationError = ref("");
const showDetails = ref(false);
const impact = ref<DesktopRoomDeletionPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
let invoker: HTMLElement | null = null;
let root: HTMLElement | null = null;
let rootWasInert = false;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let lastInputWasKeyboard = false;
let previewRequest = 0;
const noteKeyboard = () => { lastInputWasKeyboard = true; };
const notePointer = () => { lastInputWasKeyboard = false; };
const inventory = computed(() => (["messages", "threads", "tasks", "files"] as const).map(key => {
  const count = impact.value?.counts?.[key] ?? null;
  return { count, label: count === 1 ? key.slice(0, -1) : key };
}));

async function loadPreview(): Promise<void> {
  const room = target.value;
  if (!room) return;
  const request = ++previewRequest;
  previewLoading.value = true;
  previewError.value = "";
  try {
    const result = await desktopIpc.room.getRoomDeletionPreview(room.roomIdentifier);
    if (request === previewRequest) impact.value = result;
  } catch (error) {
    if (request === previewRequest) previewError.value = error instanceof Error ? error.message : "Room details could not be loaded.";
  } finally {
    if (request === previewRequest) previewLoading.value = false;
  }
}

function measure(): void {
  sidebarEdge.value = document.querySelector(".desktop-sidebar-frame")?.getBoundingClientRect().width || 0;
  if (!target.value) return;
  const entry = [...document.querySelectorAll<HTMLElement>("[data-sidebar-entry-id]")]
    .find(element => element.dataset.sidebarEntryId?.endsWith(":" + target.value!.roomIdentifier));
  const group = entry?.closest(".project-group");
  const groupRoot = group?.querySelector<HTMLElement>("[data-sidebar-entry-id]");
  const selected = !entry ? [] : groupRoot === entry
    ? [...group!.querySelectorAll<HTMLElement>("[data-sidebar-entry-id]")]
        .filter(element => element === entry || impact.value?.children.some(child => element.dataset.sidebarEntryId?.endsWith(":" + child.roomIdentifier)))
    : [entry];
  rows.value = selected.map(element => {
    const box = element.getBoundingClientRect();
    return { isFocus: element.classList.contains("room-focus"), title: element.querySelector(".pinned-title,.room-title")?.textContent || element.textContent?.trim() || "",
      left: box.left, top: box.top, width: box.width, height: box.height };
  }).filter(row => row.height > 0);
}

function restoreInvoker(): void {
  if (root) { root.inert = rootWasInert; root = null; }
  if (invoker?.isConnected) invoker.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>("[data-sidebar-entry-id].active, .sidebar-navigation button")?.focus({ preventScroll: true });
  invoker = null;
}

watch(() => props.room, async room => {
  if (room) {
    clearTimeout(completionTimer);
    target.value = { ...room };
    showDetails.value = false;
    confirmation.value = "";
    validationError.value = "";
    phase.value = "confirm";
    operation.value = "delete";
    localError.value = "";
    notice.value = null;
    impact.value = null;
    keyboard.value = lastInputWasKeyboard;
    invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visible.value = true;
    void loadPreview();
    await nextTick();
    if (props.room !== room) return;
    measure();
    root = document.querySelector<HTMLElement>("#app");
    if (root) { rootWasInert = root.inert; root.inert = true; }
    cancelButton.value?.focus({ preventScroll: true });
  } else if (visible.value) {
    ++previewRequest;
    if (phase.value === "deleting" || phase.value === "archiving") complete();
    else visible.value = false;
  }
}, { flush: "post", immediate: true });
watch(impact, () => { if (visible.value) measure(); });
watch(() => props.error, error => { if (error) phase.value = "confirm"; });

function cancel(): void {
  if (props.busy || phase.value !== "confirm") return;
  keyboard.value = lastInputWasKeyboard;
  emit("close");
}
function submit(event: Event): void {
  if (props.busy || phase.value !== "confirm" || !target.value || previewLoading.value || previewError.value) return;
  if (confirmation.value !== target.value.displayName) {
    validationError.value = `Type “${target.value.displayName}” to confirm deletion.`;
    confirmationInput.value?.focus({ preventScroll: true });
    return;
  }
  validationError.value = "";
  keyboard.value = lastInputWasKeyboard;
  phase.value = "deleting";
  operation.value = "delete";
  // The human confirms the displayed name; the existing IPC/server guard still receives the exact identifier.
  emit("confirm", target.value.roomIdentifier);
}
async function archive(event: MouseEvent): Promise<void> {
  if (props.busy || phase.value !== "confirm" || !target.value) return;
  keyboard.value = event.detail === 0;
  phase.value = "archiving";
  operation.value = "archive";
  try {
    await desktopIpc.room.updateAccountRoom(target.value.roomIdentifier, { archived: true });
    emit("archived", { ...target.value });
  } catch (error) {
    localError.value = error instanceof Error ? error.message : "Room could not be archived.";
    phase.value = "confirm";
  }
}
function complete(): void {
  phase.value = "removed";
  completionTimer = setTimeout(() => {
    notice.value = operation.value === "archive" ? target.value : null;
    restoreError.value = "";
    visible.value = false;
  }, matchMedia("(prefers-reduced-motion: reduce)").matches || keyboard.value ? 0 : 220);
}
async function undoArchive(): Promise<void> {
  if (!notice.value || restoring.value) return;
  restoring.value = true;
  restoreError.value = "";
  try {
    await desktopIpc.room.updateAccountRoom(notice.value.roomIdentifier, { archived: false });
    emit("restored");
    notice.value = null;
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : "Room could not be restored. Try again.";
  } finally { restoring.value = false; }
}
window.addEventListener("resize", measure);
window.addEventListener("keydown", noteKeyboard, true);
window.addEventListener("pointerdown", notePointer, true);
onBeforeUnmount(() => {
  ++previewRequest;
  clearTimeout(completionTimer);
  window.removeEventListener("resize", measure);
  window.removeEventListener("keydown", noteKeyboard, true);
  window.removeEventListener("pointerdown", notePointer, true);
  restoreInvoker();
});
</script>
<style>
.room-erasure {position:fixed;inset:0;z-index:10000;color:var(--text);isolation:isolate;--erase-red:var(--red-text);--erase-ease:cubic-bezier(.23,1,.32,1);}
.room-erasure-dimmer {position:absolute;inset:0;background:color-mix(in srgb,var(--bg) 70%,transparent);}
.room-erasure-stage {position:absolute;inset:0 0 0 var(--room-sidebar-edge);background:var(--bg);border-left:1px solid var(--border);overflow-y:auto;outline:none;}
.room-erasure-header {display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 28px;font-size:12px;color:var(--text-tertiary);}
.room-erasure-header > span {display:flex;gap:10px;min-width:0;overflow-wrap:anywhere;}
.room-erasure-cancel {display:flex;align-items:center;gap:10px;flex-shrink:0;padding:7px 9px;border:0;background:transparent;color:var(--text-secondary);font:inherit;cursor:pointer;border-radius:6px;}
.room-erasure-cancel span {font-size:10px;padding:2px 4px;border:1px solid var(--border-strong);border-radius:4px;color:var(--text-tertiary);}
.room-erasure-body {width:min(100% - 64px,460px);margin:clamp(36px,12vh,112px) auto 48px;}
.room-erasure svg {width:16px;height:16px;flex:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;}
.room-erasure-heading {display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;}
.room-erasure-heading > svg {width:24px;height:24px;margin-top:4px;color:var(--erase-red);stroke-width:1.6;}
.room-erasure h1 {margin:0;font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.8px;overflow-wrap:anywhere;}
.room-erasure-warning {margin:0;color:var(--text-secondary);font-size:14px;line-height:1.65;text-wrap:pretty;}
.room-erasure-warning strong {font-weight:500;color:var(--text);}
.room-erasure-loading {margin:0;font-size:12px;color:var(--text-tertiary);}
.room-erasure-impact {margin-top:22px;}
.room-erasure-inventory {display:flex;flex-wrap:wrap;gap:5px 0;margin:0;font-size:12px;line-height:1.5;color:var(--text-secondary);}
.room-erasure-inventory > span {display:inline-flex;gap:4px;align-items:baseline;white-space:nowrap;}
.room-erasure-inventory > span + span::before {content:'·';margin:0 9px;color:var(--text-muted);}
.room-erasure-inventory strong {color:var(--text);font-weight:500;font-variant-numeric:tabular-nums;}
.room-erasure-details-toggle {display:flex;align-items:center;gap:4px;margin:6px 0 0 -6px;padding:5px 6px;border:0;border-radius:5px;background:transparent;color:var(--text-secondary);font:inherit;font-size:12px;cursor:pointer;}
.room-erasure-details-toggle svg {width:12px;height:12px;}
.room-erasure-details {list-style:none;margin:8px 0 0;padding:0;color:var(--text-secondary);font-size:12px;}
.room-erasure-details li {display:flex;align-items:center;gap:8px;padding:5px 0;overflow-wrap:anywhere;}
.room-erasure-details li svg {color:var(--text-tertiary);width:14px;height:14px;}
.room-erasure-kept {margin:14px 0 30px;color:var(--text-tertiary);font-size:12px;line-height:1.6;}
.room-erasure-confirm label {display:block;margin-bottom:10px;font-size:12px;line-height:1.5;color:var(--text-secondary);overflow-wrap:anywhere;}
.room-erasure-confirm label strong {color:var(--text);font-weight:550;}
.room-erasure-controls {display:flex;gap:8px;}
.room-erasure-controls input {min-width:0;flex:1;min-height:40px;border:1px solid var(--border-strong);border-radius:var(--radius-md);padding:10px 12px;background:var(--bg-subtle);color:var(--text);font:inherit;font-size:13px;}
.room-erasure-controls input::placeholder {color:var(--text-tertiary);opacity:1;}
.room-erasure-delete {display:flex;justify-content:center;gap:7px;align-items:center;padding:10px 14px;flex-shrink:0;border:1px solid var(--red);border-radius:var(--radius-md);background:var(--red);color:#fff;font:inherit;font-size:12px;font-weight:550;cursor:pointer;}
.room-erasure-delete[data-confirmed="false"] {color:var(--erase-red);border-color:color-mix(in srgb,var(--red) 28%,transparent);background:var(--red-dim);}
.room-erasure-delete:disabled,.room-erasure-archive:disabled {opacity:.55;cursor:wait;}
.room-erasure-alternative {display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:32px;padding-top:24px;border-top:1px solid var(--border);}
.room-erasure-alternative strong {font-size:12px;font-weight:500;color:var(--text-secondary);}
.room-erasure-alternative p {margin:5px 0 0;font-size:12px;color:var(--text-tertiary);line-height:1.5;}
.room-erasure-archive {display:flex;gap:7px;align-items:center;justify-content:center;flex:none;min-height:36px;padding:8px 10px;background:var(--accent-dim);color:var(--text-secondary);border:1px solid var(--border-strong);border-radius:var(--radius-md);cursor:pointer;font:inherit;font-size:12px;font-weight:500;}
.room-erasure button:focus-visible,.room-erasure input:focus-visible,.room-erasure-notice button:focus-visible {outline:2px solid var(--text);outline-offset:3px;}
.room-erasure input:focus-visible {outline-offset:2px;}
.room-erasure input[aria-invalid="true"] {border-color:var(--erase-red);}
.room-erasure-row {position:fixed;display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box;background:color-mix(in srgb,var(--red) 10%,var(--bg));color:var(--erase-red);border:1px solid color-mix(in srgb,var(--red) 18%,transparent);border-radius:var(--radius-md);transform-origin:left center;transition:transform 170ms var(--erase-ease),opacity 150ms var(--erase-ease);transition-delay:var(--row-delay);}
.room-erasure-row.is-child {border-color:transparent;background:color-mix(in srgb,var(--red) 6%,var(--bg));}
.room-erasure-row span {font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.room-erasure-row .row-minus {margin-left:auto;width:12px;opacity:.65;}
.room-erasure-leaving .room-erasure-row {transform:translateX(-20px) scale(.97);opacity:0;}
.room-erasure-leaving.room-erasure-archiving .room-erasure-row {transform:translateY(10px) scale(.98);}
.room-erasure-error {margin:12px 0 0;color:var(--erase-red);font-size:12px;line-height:1.5;}
.room-erasure-enter-active .room-erasure-stage {transition:opacity 200ms var(--erase-ease),transform 200ms var(--erase-ease);}
.room-erasure-leave-active .room-erasure-stage {transition:opacity 120ms var(--erase-ease),transform 120ms var(--erase-ease);}
.room-erasure-enter-from .room-erasure-stage,.room-erasure-leave-to .room-erasure-stage {opacity:0;transform:translateX(-8px);}
.room-erasure-enter-active .room-erasure-dimmer,.room-erasure-leave-active .room-erasure-dimmer {transition:opacity 120ms var(--erase-ease);}
.room-erasure-enter-from .room-erasure-dimmer,.room-erasure-leave-to .room-erasure-dimmer {opacity:0;}
.room-erasure-notice {position:fixed;z-index:10001;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;max-width:calc(100vw - 32px);padding:14px 16px;border:1px solid var(--border-strong);border-radius:var(--radius-lg);background:var(--bg-elevated);color:var(--text);box-shadow:var(--shadow-lg);}
.room-erasure-notice > svg {width:18px;height:18px;stroke:currentColor;stroke-width:1.5;}
.room-erasure-notice strong {display:block;font-size:13px;font-weight:550;}
.room-erasure-notice small {display:block;color:var(--text-secondary);font-size:12px;margin-top:3px;}
.room-erasure-notice button {border:0;border-radius:5px;background:transparent;color:var(--text);cursor:pointer;font:inherit;font-size:13px;padding:7px;}
@media (hover:hover) and (pointer:fine) {.room-erasure-cancel:hover,.room-erasure-details-toggle:hover,.room-erasure-archive:not(:disabled):hover,.room-erasure-notice button:hover {background:var(--accent-hover);color:var(--text);} .room-erasure-delete[data-confirmed="true"]:not(:disabled):hover {background:color-mix(in srgb,var(--red) 85%,black);} .room-erasure-delete[data-confirmed="false"]:not(:disabled):hover {background:color-mix(in srgb,var(--red) 18%,transparent);} }
@media(max-width:780px) {.room-erasure-stage {left:0;} .room-erasure-affected {display:none;} .room-erasure-header {padding:18px 20px;} .room-erasure-body {width:calc(100% - 48px);max-width:460px;margin-top:44px;} }
@media(max-width:420px) {.room-erasure-controls {flex-direction:column;} .room-erasure-alternative {align-items:flex-start;flex-direction:column;gap:12px;} .room-erasure h1 {font-size:25px;} }
@media(prefers-reduced-motion:reduce) {.room-erasure-row,.room-erasure-stage {transform:none!important;transition-property:opacity!important;transition-duration:80ms!important;transition-delay:0ms!important;}}
.room-erasure-keyboard .room-erasure-row,.room-erasure-keyboard .room-erasure-stage,.room-erasure-keyboard .room-erasure-dimmer {transition:none!important;transform:none!important;}
</style>
