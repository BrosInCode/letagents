<template>
  <Teleport to="body">
    <dialog ref="dialog" class="message-reader attachment-text-reader" :aria-labelledby="titleId" @click.self="close" @keydown.esc.prevent.stop="close" @keydown.meta.f.prevent="find?.focus()" @keydown.ctrl.f.prevent="find?.focus()" @close="emit('close')">
      <section class="attachment-reader-layout">
        <header class="attachment-reader-header">
          <span class="attachment-reader-icon"><FileText :size="19" aria-hidden="true" /></span>
          <div class="attachment-reader-name">
            <h2 :id="titleId">{{ attachment.fileName }}</h2>
            <p>{{ metadata }}</p>
          </div>
          <div class="attachment-reader-actions">
            <button type="button" :disabled="text === null" aria-label="Copy file contents" @click="copy"><Copy aria-hidden="true" /><span>Copy</span></button>
            <button type="button" aria-label="Download file" @click="download"><Download aria-hidden="true" /><span>Download</span></button>
            <button type="button" aria-label="Close preview" @click="close"><X aria-hidden="true" /></button>
          </div>
        </header>
        <div v-if="text !== null" class="attachment-reader-toolbar">
          <div v-if="table" class="attachment-reader-mode" role="group" aria-label="File view">
            <button type="button" :aria-pressed="showRows" @click="setMode(true)"><Table2 aria-hidden="true" />Rows</button>
            <button type="button" :aria-pressed="!showRows" @click="setMode(false)"><Code aria-hidden="true" />Raw</button>
          </div>
          <span v-else class="attachment-reader-label">{{ type === "Text" || type === "Log" ? "Plain text" : "Raw text" }}</span>
          <div class="attachment-reader-find">
            <Search aria-hidden="true" />
            <input ref="find" v-model="query" type="search" aria-label="Find in file" placeholder="Find in file" @keydown.enter.prevent="moveMatch($event.shiftKey ? -1 : 1)">
            <template v-if="needle && !showRows">
              <span aria-live="polite">{{ matchLabel }}</span>
              <button type="button" aria-label="Previous match" :disabled="!matches.length" @click="moveMatch(-1)"><ChevronUp aria-hidden="true" /></button>
              <button type="button" aria-label="Next match" :disabled="!matches.length" @click="moveMatch(1)"><ChevronDown aria-hidden="true" /></button>
            </template>
          </div>
        </div>
        <div ref="content" class="attachment-reader-content" tabindex="0" aria-label="File contents" :aria-busy="text === null && !error">
          <p v-if="error" class="attachment-reader-state" role="status">{{ feedback || error }} <button type="button" @click="load">Retry</button></p>
          <p v-else-if="text === null" class="attachment-reader-state" role="status">Loading file…</p>
          <p v-else-if="!itemCount" class="attachment-reader-state" role="status">{{ needle ? "No matching rows." : "This file is empty." }}</p>
          <table v-else-if="showRows && table" class="attachment-reader-table" aria-label="File records">
            <thead><tr><th v-for="column in table.columns" :key="column" scope="col">{{ column }}</th></tr></thead>
            <tbody><tr v-for="(row, index) in pageRows" :key="pageStart + index">
              <td v-for="column in table.columns" :key="column">{{ attachmentCell(row, column) }}</td>
            </tr></tbody>
          </table>
          <div v-else class="attachment-reader-lines">
            <div v-for="(line, index) in pageLines" :key="pageStart + index" :data-line="pageStart + index" :class="{ 'is-match': pageStart + index === activeLine }">
              <span aria-hidden="true">{{ pageStart + index + 1 }}</span><code>{{ line }}</code>
            </div>
          </div>
        </div>
        <footer v-if="text !== null" class="attachment-reader-footer">
          <span aria-live="polite">{{ itemLabel }}</span>
          <span role="status">{{ feedback }}</span>
          <div v-if="itemCount > pageSize" class="attachment-reader-pages">
            <button type="button" :disabled="page === 0" aria-label="Previous page" @click="goToPage(page - 1)"><ChevronLeft aria-hidden="true" /></button>
            <span>{{ page + 1 }} of {{ Math.ceil(itemCount / pageSize) }}</span>
            <button type="button" :disabled="pageStart + pageSize >= itemCount" aria-label="Next page" @click="goToPage(page + 1)"><ChevronRight aria-hidden="true" /></button>
          </div>
        </footer>
      </section>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Code, Copy, Download, FileText, Search, Table2, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import type { DesktopRoomMessageAttachment } from "../../../../../../electron/ipc-types";
import { attachmentCell, attachmentPreviewType, attachmentTable } from "../../../../domain/attachment-preview";
import { desktopIpc } from "../../../../ipc/index.js";
import { formatDisplayBytes } from "./attachments";
import "../../../../../../../../shared/ui/message-reader.css";
import "./attachment-text-reader.css";

const props = defineProps<{ attachment: DesktopRoomMessageAttachment; opener: HTMLElement | null }>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
const dialog = ref<HTMLDialogElement>();
const find = ref<HTMLInputElement>();
const content = ref<HTMLElement>();
const text = ref<string | null>(null);
const error = ref("");
const feedback = ref("");
const showRows = ref(false);
const query = ref("");
const page = ref(0);
const matchIndex = ref(0);
const pageSize = 150;
let requestId = 0;

const type = computed(() => attachmentPreviewType(props.attachment));
const metadata = computed(() => [type.value, formatDisplayBytes(props.attachment.sizeBytes ?? 0)].filter(Boolean).join(" · "));
const table = computed(() => text.value !== null && type.value ? attachmentTable(type.value, text.value) : null);
const lines = computed(() => text.value ? text.value.replace(/\r?\n$/, "").split(/\r?\n/) : []);
const needle = computed(() => query.value.trim().toLowerCase());
const rows = computed(() => table.value?.rows.filter(row => !needle.value || JSON.stringify(row).toLowerCase().includes(needle.value)) ?? []);
const matches = computed(() => needle.value
  ? lines.value.flatMap((line, index) => line.toLowerCase().includes(needle.value) ? [index] : [])
  : []);
const activeLine = computed(() => matches.value[matchIndex.value] ?? null);
const matchLabel = computed(() => matches.value.length ? String(matchIndex.value + 1) + " / " + String(matches.value.length) : "0 matches");
const itemCount = computed(() => showRows.value ? rows.value.length : lines.value.length);
const itemLabel = computed(() => showRows.value && needle.value
  ? String(itemCount.value) + " of " + String(table.value?.rows.length ?? 0) + " rows"
  : String(itemCount.value) + (showRows.value ? " rows" : " lines"));
const pageStart = computed(() => page.value * pageSize);
const pageRows = computed(() => rows.value.slice(pageStart.value, pageStart.value + pageSize));
const pageLines = computed(() => lines.value.slice(pageStart.value, pageStart.value + pageSize));

onMounted(() => {
  dialog.value?.showModal();
  content.value?.focus({ preventScroll: true });
  void load();
});
onBeforeUnmount(() => {
  requestId += 1;
  dialog.value?.close();
  if (props.opener?.isConnected) props.opener.focus({ preventScroll: true });
});

async function load() {
  const id = ++requestId;
  error.value = "";
  try {
    const read = desktopIpc.room?.readAttachmentText;
    const href = props.attachment.href;
    if (!href || !read) throw new Error("Attachment reader unavailable.");
    const result = await read(href);
    if (requestId !== id) return;
    if ("error" in result) {
      error.value = result.error;
      return;
    }
    text.value = result.text;
    showRows.value = Boolean(table.value);
  } catch {
    if (requestId === id) error.value = "Couldn’t load this file.";
  }
}

function close() { dialog.value?.close(); }

async function goToPage(next: number) {
  page.value = next;
  await nextTick();
  if (content.value) content.value.scrollTop = 0;
}

async function revealMatch() {
  const line = activeLine.value;
  if (line === null) return;
  page.value = Math.floor(line / pageSize);
  await nextTick();
  content.value?.querySelector('[data-line="' + String(line) + '"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function setMode(rowsMode: boolean) {
  showRows.value = rowsMode;
  resetFind();
}

function resetFind() {
  matchIndex.value = 0;
  if (!showRows.value && activeLine.value !== null) void revealMatch();
  else void goToPage(0);
}
watch(needle, resetFind);

function moveMatch(step: number) {
  if (showRows.value || !matches.value.length) return;
  matchIndex.value = (matchIndex.value + step + matches.value.length) % matches.value.length;
  void revealMatch();
}

async function download() {
  const href = props.attachment.href;
  if (text.value === null) {
    try {
      if (href && desktopIpc.room?.downloadAttachment) await desktopIpc.room.downloadAttachment(href);
    } catch { feedback.value = "Couldn’t download"; }
    return;
  }
  const url = URL.createObjectURL(new Blob([text.value], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = props.attachment.fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy() {
  if (text.value === null) return;
  try {
    await navigator.clipboard.writeText(text.value);
    feedback.value = "Copied";
  } catch { feedback.value = "Couldn’t copy"; }
}
</script>
