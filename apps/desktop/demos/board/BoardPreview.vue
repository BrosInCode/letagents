<template>
  <main class="board-preview" :style="{ colorScheme: light ? 'light' : 'dark' }">
    <header class="preview-header">
      <strong>LetAgents <span>/</span> The Board</strong>
      <div>
        <span>Sample data</span>
        <button type="button" @click="light = !light">{{ light ? 'Dark theme' : 'Light theme' }}</button>
      </div>
    </header>
    <RoomBoardView
      room-identifier="board-preview"
      :tasks="tasks"
      :presence="presence"
      :workers="workers"
      :board-settings="governance"
      :can-edit-tasks="!params.has('readonly')"
      @task-updated="updateTask"
    />
  </main>
</template>

<script setup lang="ts">
import { ref, toRaw } from "vue";
import type { DesktopApi, DesktopTaskSummary, DesktopAgentPresence, DesktopBoardGovernanceSnapshot, WorkerSnapshot } from "../../electron/ipc-types";
import RoomBoardView from "../../renderer/src/components/desktop/content/RoomBoardView.vue";

const params = new URLSearchParams(location.search);
const light = ref(params.get("theme") === "light");
const now = new Date().toISOString();
const workers: WorkerSnapshot[] = params.has("worker") ? [{
  id: "worker_DawnRidge", runtime: "codex", state: "connected", roomId: "board-preview",
  actorLabel: "DawnRidge", agentKey: "DawnRidge", agentSessionId: "session_DawnRidge", detail: "DawnRidge",
}] : [];
function task(id: number, title: string, status: string, owner: string | null = null): DesktopTaskSummary {
  return {
    id: `task_${id}`, title, status, assignee: owner, assigneeAgentKey: owner,
    description: "Preserve the room's approval rules and verify the full workflow with an independent reviewer.",
    createdBy: "EmmyMay", createdAt: now, updatedAt: new Date(Date.now() - id * 60000).toISOString(),
    prUrl: null, workflowArtifacts: [], workflowRefs: [], activeLocks: [], stalePromptState: null,
    activeLeases: owner ? [{ id: `lease_${id}`, kind: "work", holderLabel: owner, agentKey: owner,
      agentSessionId: `session_${owner}`, status: "active", updatedAt: now }] : [],
  };
}
const tasks = ref(params.has("empty") ? [] : [
  task(21, "Make event-turn timeouts activity-aware", "proposed"),
  task(22, "Separate runtime activity from room connectivity", "proposed"),
  task(23, "Deliver approved work directly to its owner", "accepted"),
  task(24, "Preserve the task owner through reconnects", "assigned", "DawnRidge"),
  task(25, "Make board updates safe to retry", "in_progress", "RiverField"),
  task(26, "Verify the approval handoff end to end", "in_review", "DawnRidge"),
  task(27, "Confirm the room's repository permissions", "blocked", "RiverField"),
  task(28, "Readable manager notifications", "done"),
]);
if (tasks.value.length) {
  tasks.value[4].workflowRefs = [{ provider: "github", kind: "pull_request", label: "PR #1159", url: "https://github.com/BrosInCode/letagents/pull/1159" }];
  tasks.value[5].activeLeases.push({ id: "review_26", kind: "review", holderLabel: "SilverCove", agentKey: "SilverCove", agentSessionId: "session_SilverCove", status: "active", updatedAt: now });
  tasks.value[6].activeLocks = [{ id: "lock_27", scope: "task", reason: "Repository access", message: "Waiting for repository access", createdBy: "EmmyMay" }];
}
const presence: DesktopAgentPresence[] = ["DawnRidge", "RiverField"].map(name => ({
  roomId: "board-preview", actorLabel: name, agentKey: name, agentInstanceId: name,
  agentSessionId: `session_${name}`, sessionKind: "worker", runtime: "codex",
  displayName: name, ownerLabel: "EmmyMay", ideLabel: "Codex", repoBranch: null,
  status: "idle", statusText: "Available", lastHeartbeatAt: now, freshness: "active",
  activityState: "active", sourceFlags: [], livenessObservation: null,
}));
const governance = ref<DesktopBoardGovernanceSnapshot>({
  roomId: "board-preview", managerMode: "manager_optional", activeManager: null,
  candidates: presence.map(agent => ({
    agentSessionId: agent.agentSessionId!, agentKey: agent.agentKey!, actorLabel: agent.actorLabel,
    displayName: agent.displayName, runtime: "codex", runtimeSource: "desktop_managed",
    lastSeenAt: now, isActiveManager: false,
  })),
  pendingIntents: [{ id: "intent_preview", taskId: null, actionType: "task_create", status: "pending",
    proposerActorLabel: "RiverField", payload: { title: "Document the approval handoff" }, createdAt: now, expiresAt: null }],
  pendingIntentCount: 1, audit: [], warnings: [],
  capabilities: { canViewGovernance: true, canAssignManager: true, canReleaseManager: true, canSetManagerMode: true, canDecideIntents: true },
});
const snapshot = () => structuredClone(toRaw(governance.value));
function updateTask(updated: DesktopTaskSummary) {
  const index = tasks.value.findIndex(task => task.id === updated.id);
  if (index < 0) tasks.value.push(updated);
  else tasks.value[index] = updated;
}
function checkConnection() {
  if (params.has("error")) throw new Error("The room could not be reached.");
}
// This dev-only fixture exercises the production UI without writing to a real room.
const room: Partial<DesktopApi["room"]> = {
  async updateTask(_room, id, input) {
    if (params.has("slow")) await new Promise(resolve => setTimeout(resolve, 2000));
    checkConnection();
    return { task: { ...tasks.value.find(task => task.id === id)!, ...input, updatedAt: now } };
  },
  async addTask(_room, input) {
    checkConnection();
    return { task: { ...task(100 + tasks.value.length, input.title, "proposed"), description: input.description ?? null } };
  },
  async updateTaskLease(_room, id, input) {
    checkConnection();
    const current = tasks.value.find(task => task.id === id)!;
    return { task: { ...current, activeLeases: current.activeLeases.filter(lease => lease.id !== input.lease_id) } };
  },
  async updateTaskReviewLease(_room, id, input) {
    checkConnection();
    const current = tasks.value.find(task => task.id === id)!;
    const leases = current.activeLeases.filter(lease => lease.id !== input.lease_id);
    if (input.action === "assign") leases.push({
      id: `review_${id}`, kind: "review", holderLabel: input.target_actor_key || "Reviewer",
      agentKey: input.target_actor_key || null, agentSessionId: input.target_agent_session_id || null,
      status: "active", updatedAt: now,
    });
    return { task: { ...current, activeLeases: leases } };
  },
  async runTaskWorkerAction(_room, id, input) {
    checkConnection();
    const current = tasks.value.find(task => task.id === id)!;
    const status = { claim: "assigned", start: "in_progress", resume: "in_progress", block: "blocked", submit_review: "in_review" }[input.action];
    const claimed = input.action === "claim" ? {
      assignee: "DawnRidge", assigneeAgentKey: "DawnRidge",
      activeLeases: task(999, "", "assigned", "DawnRidge").activeLeases,
    } : {};
    return { task: { ...current, ...claimed, status } };
  },
  async runTaskReviewWorkerAction(_room, id, input) {
    checkConnection();
    const current = tasks.value.find(task => task.id === id)!;
    const leases = current.activeLeases.filter(lease => lease.id !== input.lease_id);
    if (input.action === "claim") leases.push({
      id: `review_${id}`, kind: "review", holderLabel: "DawnRidge",
      agentKey: "DawnRidge", agentSessionId: "session_DawnRidge", status: "active", updatedAt: now,
    });
    return { task: { ...current, activeLeases: leases } };
  },
  async getBoardGovernance() { checkConnection(); return snapshot(); },
  async setBoardManagerMode(_room, input) {
    governance.value.managerMode = input.managerMode;
    return { governance: snapshot() };
  },
  async assignBoardManager(_room, input) {
    const candidate = governance.value.candidates.find(candidate => candidate.agentSessionId === input.agentSessionId)!;
    governance.value.activeManager = { ...candidate, assignmentId: "assignment_preview", assignedBy: "EmmyMay", lastHeartbeatAt: now };
    return { governance: snapshot() };
  },
  async releaseBoardManager() { governance.value.activeManager = null; return { governance: snapshot() }; },
  async decideBoardIntent(_room, id) {
    governance.value.pendingIntents = governance.value.pendingIntents.filter(intent => intent.id !== id);
    governance.value.pendingIntentCount = governance.value.pendingIntents.length;
    return { governance: snapshot() };
  },
};
window.letagentsDesktop = { room } as DesktopApi;
</script>

<style>
.board-preview {
  display: grid;
  grid-template-rows: 56px minmax(0, 1fr);
  height: 100dvh;
  background: var(--bg);
}
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 28px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
}
.preview-header strong { font-weight: 600; }
.preview-header strong span { margin: 0 12px; color: var(--text-tertiary); }
.preview-header > div { display: flex; align-items: center; gap: 12px; color: var(--text-secondary); }
.preview-header button {
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  background: var(--bg-subtle);
  cursor: pointer;
}
@media (max-width: 600px) {
  .preview-header { padding-inline: 16px; }
  .preview-header > div > span { display: none; }
}
</style>
