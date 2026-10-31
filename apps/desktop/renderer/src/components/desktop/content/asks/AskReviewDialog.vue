<template>
  <DesktopDialogShell
    :open="Boolean(askId)"
    panel-class="desktop-task-modal agent-ask-dialog agent-review-dialog"
    aria-labelledby="agent-review-title"
    close-label="Close"
    test-id="agent-review-dialog"
    @close="emit('close')"
  >
    <header class="agent-ask-header"><h3 id="agent-review-title">{{ title }}</h3></header>
    <p v-if="loading" class="agent-ask-ready-copy">Loading…</p>
    <p v-else-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>

    <template v-else-if="workspace">
      <section class="agent-review-section">
        <h4>Changes</h4>
        <p v-if="!workspace.proposals.length" class="agent-ask-ready-copy">No changes proposed yet.</p>
        <article v-for="proposal in workspace.proposals" :key="proposal.id" class="agent-review-proposal" :data-state="proposal.state">
          <div class="agent-review-proposal-head">
            <strong>{{ proposal.summary }}</strong>
            <span class="agent-review-state">{{ stateLabel(proposal.state) }}</span>
          </div>
          <details>
            <summary>{{ proposal.files?.length ?? 0 }} file{{ proposal.files?.length === 1 ? "" : "s" }}</summary>
            <div v-for="file in proposal.files ?? []" :key="file.path" class="agent-review-file">
              <code>{{ file.path }}</code><small v-if="file.deleted"> · deleted</small>
              <pre v-if="file.content !== null">{{ file.content }}</pre>
            </div>
          </details>
          <p v-if="proposal.error" class="desktop-task-dialog-error">{{ proposal.error }}</p>
          <a v-if="proposal.pr_url" :href="proposal.pr_url" target="_blank" rel="noreferrer">View pull request</a>
          <div v-if="proposal.state === 'waiting'" class="agent-ask-chips">
            <button type="button" :disabled="busyId !== null" @click="decide(proposal.id, true)">{{ busyId === proposal.id ? "Opening PR…" : "Approve" }}</button>
            <button type="button" :disabled="busyId !== null" @click="decide(proposal.id, false)">Decline</button>
          </div>
        </article>
      </section>

      <section class="agent-review-section">
        <h4>Files seen</h4>
        <p v-if="!workspace.files_seen.length" class="agent-ask-ready-copy">The agent hasn't read any code yet.</p>
        <ul class="agent-review-seen">
          <li v-for="(row, index) in workspace.files_seen" :key="index">
            <code>{{ row.kind === "search" ? `search: ${row.target}` : row.target }}</code>
            <small v-if="row.blocked"> · not shared (may hold secrets)</small>
          </li>
        </ul>
      </section>
    </template>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { DesktopAgentAskWorkspace } from "../../../../../../electron/ipc-types/asks";
import { desktopIpc, desktopBridgeUpgradeMessage } from "../../../../ipc/index.js";
import DesktopDialogShell from "../DesktopDialogShell.vue";

const props = defineProps<{ askId: string | null; title: string }>();
const emit = defineEmits<{ close: [] }>();
const workspace = ref<DesktopAgentAskWorkspace | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);

const stateLabel = (state: string) => ({ waiting: "Waiting for you", approved: "In the pull request", declined: "Declined", failed: "Couldn't open" }[state] ?? state);

async function load() {
  if (!props.askId) return;
  if (!desktopIpc.asks?.workspace) { error.value = desktopBridgeUpgradeMessage(); return; }
  loading.value = true; error.value = null;
  const result = await desktopIpc.asks.workspace(props.askId).catch(() => null);
  loading.value = false;
  if (!result) { error.value = "Couldn't reach LetAgents. Check your connection and try again."; return; }
  if (!result.ok) { error.value = result.error; return; }
  workspace.value = result.value;
}

async function decide(proposalId: string, approve: boolean) {
  if (!props.askId || busyId.value) return;
  busyId.value = proposalId;
  const result = await desktopIpc.asks!.decide(props.askId, proposalId, approve).catch(() => null);
  busyId.value = null;
  if (result && !result.ok) error.value = result.error;
  await load();
}

watch(() => props.askId, () => { workspace.value = null; void load(); }, { immediate: true });
</script>
