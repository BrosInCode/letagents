<template>
  <Teleport to="body">
    <DesktopDialogShell
      :open="true" :aria-label="`Changes in pull request #${number}`"
      backdrop-class="pr-changes-backdrop" panel-class="pr-changes-dialog"
      :show-close="false" initial-focus=".pr-changes-close" @close="emit('close')"
    >
      <header class="pr-changes-header">
        <div><h2>Changes in #{{ number }}</h2><p>Read only<span v-if="state.headSha"> · {{ state.headSha.slice(0, 8) }}</span></p></div>
        <a :href="githubUrl" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
        <button type="button" class="pr-changes-close" aria-label="Close pull request changes" @click="emit('close')">Close</button>
      </header>
      <div v-if="state.loading || state.error" class="pr-changes-state" role="status">
        <p>{{ state.error || "Loading changes…" }}</p>
        <button v-if="state.error" type="button" @click="load">Try again</button>
      </div>
      <template v-if="state.model">
        <p v-if="state.model.fileListUnavailable" class="pr-changes-notice" role="status">
          The file list from GitHub is unavailable. Showing files found in the diff; line counts are unavailable.
          <button type="button" @click="load">Try again</button>
        </p>
        <p v-if="state.model.snapshot.hidden_files" class="pr-changes-notice">
          Showing {{ state.model.snapshot.files.length }} of {{ state.model.snapshot.files.length + state.model.snapshot.hidden_files }} files.
          Open on GitHub for the rest.
        </p>
        <WorkspaceDiff
          :snapshot="state.model.snapshot" :view-key="`${room}:${number}:${state.headSha}`"
          :load-page="state.model.loadPage" :file-notices="state.model.notices"
          :show-file-counts="true" :counts-unavailable="state.model.fileListUnavailable"
          footer-label="Pull request changes · read only" partial-label="Some files are omitted · open on GitHub"
          @escape="emit('close')"
        />
      </template>
    </DesktopDialogShell>
  </Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from "vue";
import { desktopIpc } from "../../../../ipc";
import { createPullRequestDiffSession, type PullRequestDiffState } from "../../../../domain/pull-request-diff";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import WorkspaceDiff from "../agent-inspector/WorkspaceDiff.vue";

const props = defineProps<{ room: string; number: number; githubUrl: string }>();
const emit = defineEmits<{ close: [] }>();
const state = shallowRef<PullRequestDiffState>({ loading: false, model: null, error: null, headSha: null });
const session = createPullRequestDiffSession(
  (room, number) => desktopIpc.room?.getPullRequestDiff?.(room, number) ?? Promise.resolve({ ok: false, code: "bridge_unavailable" }),
  next => { state.value = next; },
);
function load() { void session.load(props.room, props.number); }
watch(() => [props.room, props.number], load, { immediate: true });
onBeforeUnmount(() => session.close());
</script>

<style>
.pr-changes-backdrop { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; padding: 24px; background: var(--overlay-scrim); }
.pr-changes-dialog { display: flex; flex-direction: column; width: min(1440px, 100%); height: 100%; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text); box-shadow: var(--shadow-xl); }
.pr-changes-header { display: flex; align-items: center; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.pr-changes-header > div { flex: 1; }
.pr-changes-header h2 { margin: 0; font-size: 16px; }
.pr-changes-header p { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); }
.pr-changes-header a, .pr-changes-header button, .pr-changes-state button, .pr-changes-notice button { font-size: 12px; }
.pr-changes-header a { color: var(--blue); }
.pr-changes-close, .pr-changes-state button, .pr-changes-notice button { background: var(--accent-dim); color: var(--text); border-radius: 6px; padding: 8px 12px; cursor: pointer; }
.pr-changes-header button:focus-visible, .pr-changes-header a:focus-visible, .pr-changes-state button:focus-visible, .pr-changes-notice button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.pr-changes-state { margin: auto; padding: 24px; max-width: 520px; text-align: center; font-size: 14px; line-height: 1.6; }
.pr-changes-notice { margin: 0; padding: 10px 20px; font-size: 12px; line-height: 1.6; border-bottom: 1px solid var(--border); }
.pr-changes-dialog > .workspace-diff { border: 0; border-radius: 0; min-height: 0; }
@media (max-width: 600px) {
  .pr-changes-backdrop { padding: 0; }
  .pr-changes-dialog { border: 0; border-radius: 0; }
  .pr-changes-header { flex-wrap: wrap; padding: 12px; gap: 12px; }
}
</style>
