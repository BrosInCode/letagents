<template>
  <div class="task-detail">
    <div class="task-detail-scroll">
      <header class="task-detail-heading"><slot name="heading" /></header>
      <div class="task-detail-layout">
        <div class="task-detail-content"><slot /></div>
        <aside class="task-detail-properties" aria-label="Task details">
          <h3 class="task-detail-properties-label">Details</h3>
          <button type="button" class="task-detail-toggle" :aria-expanded="expanded" :aria-controls="detailsId" @click="expanded = !expanded">
            <strong>{{ expanded ? 'Hide details' : 'Show details' }}</strong>
            <span class="task-detail-summary">{{ summary }}</span>
            <svg viewBox="0 0 16 16" fill="none" :class="{ expanded }" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
          <div :id="detailsId" class="task-detail-properties-content" :class="{ expanded }"><slot name="details" /></div>
        </aside>
      </div>
    </div>
    <footer class="task-detail-footer"><slot name="actions" /></footer>
  </div>
</template>
<script setup lang="ts">
import { ref, useId, watch } from 'vue';
const props = defineProps<{ summary?: string; detailKey: string }>();
const expanded = ref(false);
const detailsId = `task-details-${useId()}`;
watch(() => props.detailKey, () => { expanded.value = false; });
</script>
<style scoped>
.task-detail { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; color:var(--text); }
.task-detail-scroll { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; }
.task-detail-heading { padding:27px 32px 26px; }
.task-detail-layout { display:grid; grid-template-columns:minmax(0,1fr) 232px; align-items:start; gap:38px; padding:0 32px 30px; }
.task-detail-content { display:grid; grid-template-columns:minmax(0,1fr); align-content:start; gap:28px; min-width:0; }
.task-detail-properties { min-width:0; padding-top:7px; }
.task-detail-properties-label { margin:0 0 13px; font-size:13px; font-weight:600; line-height:1.5; }
.task-detail-toggle { display:none; }
.task-detail-properties-content { min-width:0; }
.task-detail-footer { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; min-height:69px; padding:15px 24px; border-top:1px solid var(--border); background:var(--bg); }
.task-detail-content :deep(.task-markdown-preview) { font-size:15px; line-height:1.8; color:var(--text); overflow-wrap:anywhere; }
.task-detail-content :deep(.task-markdown-preview :is(p,li)) { font-size:inherit; line-height:inherit; }
.task-detail-content :deep(.task-markdown-preview p) { margin:0 0 16px; }
.task-detail-content :deep(.task-markdown-preview pre) { max-width:100%; overflow:auto; white-space:pre; font-size:12px; }
.task-detail-content :deep(.task-markdown-preview table) { display:block; max-width:100%; overflow:auto; }
.task-detail-content :deep(.task-markdown-preview img) { max-width:100%; }
.task-detail-content :deep(.task-markdown-preview :is(h1,h2,h3,h4)) { font-size:16px; line-height:1.5; margin:24px 0 12px; }
.task-detail-properties :deep(.board-plan-fields) { grid-template-columns:minmax(0,1fr); gap:4px; margin:12px 0; }
.task-detail-properties :deep(.board-plan-field) { display:grid; grid-template-columns:78px minmax(0,1fr); align-items:center; gap:6px; min-height:39px; font-size:12px; }
.task-detail-properties :deep(.board-plan-field .work-filter-trigger) { min-height:32px; height:32px; padding:0 7px; border-color:transparent; border-radius:6px; color:var(--text); font-size:12px; }
.task-detail-properties :deep(.board-plan-field .work-filter-trigger > svg) { margin-left:auto; }
.task-detail-properties :deep(.board-plan-field input) { width:100%; height:32px; padding:5px 7px; border-color:transparent; background:transparent; color:var(--text); font-size:12px; }
.task-detail-properties :deep(.board-plan-field input:focus) { border-color:var(--border-strong); background:var(--bg-subtle); }
.task-detail-properties :deep(.board-plan-actions) { flex-wrap:wrap; gap:8px; margin-top:8px; }
.task-detail-properties :deep(.board-plan-actions button) { min-height:32px; padding:6px 10px; font-size:12px; }
.task-detail :is(button,a,summary,input):focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
@media(max-width:760px) {
  .task-detail-heading { padding:22px 23px 21px; }
  .task-detail-layout { grid-template-columns:minmax(0,1fr); gap:25px; padding:0 23px 25px; }
  .task-detail-properties { grid-row:1; padding:0; }
  .task-detail-content { grid-row:2; }
  .task-detail-properties-label { display:none; }
  .task-detail-toggle { display:flex; width:100%; align-items:center; min-height:46px; gap:12px; padding:12px; text-align:left; color:var(--text); background:var(--bg-subtle); border:1px solid var(--border-strong); border-radius:9px; font:inherit; cursor:pointer; }
  .task-detail-toggle strong { flex-shrink:0; font-size:13px; font-weight:550; }
  .task-detail-summary { margin-left:auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary); font-size:11px; }
  .task-detail-toggle svg { width:16px; height:16px; flex-shrink:0; color:var(--text-secondary); stroke:currentColor; stroke-width:1.5; transition:transform 160ms ease; }
  .task-detail-toggle svg.expanded { transform:rotate(180deg); }
  .task-detail-properties-content { padding:10px 4px 0; }
  .task-detail-properties-content:not(.expanded) { display:none; }
  .task-detail-properties :deep(.board-plan-field) { grid-template-columns:minmax(78px,1fr) 145px; }
  .task-detail-footer { padding:12px 18px max(12px,env(safe-area-inset-bottom)); min-height:65px; }
  .task-detail-content :deep(.task-markdown-preview) { font-size:14px; }
}
@media(hover:hover) and (pointer:fine) { .task-detail-toggle:hover { background:var(--bg-elevated); } .task-detail-properties :deep(.board-plan-field input:hover) { background:var(--bg-subtle); } }
@media(prefers-reduced-motion:reduce) { .task-detail-toggle svg { transition:none; } }
</style>
