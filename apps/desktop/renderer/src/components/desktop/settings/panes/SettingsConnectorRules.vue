<template>
  <details class="settings-connector-rules" :data-testid="`settings-connector-rules-${connection.id}`" @toggle="onToggle">
    <summary>Rules</summary>
    <p class="settings-control-description">
      A rule moves or comments on a ticket when a pull request, review or check matches it. A rule is an approval
      you give in advance: LetAgents writes to {{ trackerLabel(connection.provider) }} as you, once per event.
      Ticket changes from {{ trackerLabel(connection.provider) }} never start a rule.
    </p>
    <p v-if="feedback" class="settings-feedback" :data-state="feedback.state" role="status">{{ feedback.message }}</p>

    <article v-for="rule in rules" :key="rule.id" class="settings-connector-rule" :data-testid="`settings-connector-rule-${rule.id}`">
      <SettingsRow :title="rule.name" :description="`${ruleSummary(rule)} · ${roomLabel(rule.room_id)} · version ${rule.version}`" :description-id="`rule-${rule.id}`">
        <template #action>
          <div class="settings-connector-actions">
            <DesktopSwitch
              :label="`Rule ${rule.name} on`"
              :describedby="`rule-${rule.id}`"
              :test-id="`settings-connector-rule-switch-${rule.id}`"
              :checked="rule.enabled"
              :busy="busyId === rule.id"
              @toggle="toggle(rule)"
            />
            <button class="ghost-button" type="button" :disabled="busyId === rule.id" @click="edit(rule)">Edit</button>
            <button class="ghost-button" type="button" :disabled="busyId === rule.id" @click="toggleHistory(rule)">
              {{ history[rule.id] ? "Hide history" : "History" }}
            </button>
            <button class="ghost-button" type="button" :disabled="busyId === rule.id" @click="remove(rule)">
              {{ confirmRemoveId === rule.id ? "Confirm delete" : "Delete" }}
            </button>
          </div>
        </template>
      </SettingsRow>
      <ol v-if="history[rule.id]" class="settings-connector-rule-history" :aria-label="`Versions of ${rule.name}`">
        <li v-for="version in history[rule.id]" :key="version.version">
          <span><strong>Version {{ version.version }}</strong> · {{ version.name }} · {{ ruleSummary(version) }}</span>
          <span v-if="version.version === rule.version" class="state-pill" data-state="connected">Current</span>
          <button
            v-else
            class="ghost-button"
            type="button"
            :disabled="busyId === rule.id"
            :data-testid="`settings-connector-rule-rollback-${rule.id}-${version.version}`"
            @click="rollback(rule, version.version)"
          >Roll back to this</button>
        </li>
      </ol>
    </article>
    <p v-if="loaded && !rules.length" class="settings-control-description">No rules yet.</p>

    <button v-if="!draft" class="primary-button" type="button" :data-testid="`settings-connector-rule-add-${connection.id}`" @click="startNew">Add rule</button>

    <form v-if="draft" class="settings-form settings-connector-rule-form" data-testid="settings-connector-rule-form" @submit.prevent="save">
      <p class="settings-control-title">{{ draft.id ? "Edit rule" : "New rule" }}</p>
      <div v-if="canDraft" class="settings-connector-rule-sentence" data-testid="settings-connector-rule-sentence">
        <label class="settings-field"><span>Draft from a sentence</span>
          <input
            v-model="sentence"
            type="text"
            maxlength="500"
            placeholder="When a PR is merged, move the ticket to Done and comment"
            data-testid="settings-connector-rule-sentence-input"
            @keydown.enter.prevent="draftFromSentence"
          />
        </label>
        <button
          class="ghost-button"
          type="button"
          :disabled="drafting || !sentence.trim()"
          data-testid="settings-connector-rule-sentence-draft"
          @click="draftFromSentence"
        >{{ drafting ? "Drafting" : "Draft" }}</button>
        <p class="settings-muted-note">Jev fills the form below. Check it, then press Save. The sentence is sent to Jev's model provider.</p>
      </div>
      <slot name="draft" :apply="applyDraft" />
      <label class="settings-field"><span>Name</span>
        <input v-model="draft.name" type="text" maxlength="120" required placeholder="Move to In Review when a PR opens" />
      </label>
      <label class="settings-field"><span>Rooms</span>
        <select v-model="draft.room_id">
          <option value="">Every room that imports with this connection</option>
          <option v-for="room in rooms" :key="room" :value="room">{{ room }}</option>
        </select>
      </label>
      <fieldset class="settings-connector-rule-trigger">
        <legend>When</legend>
        <label class="settings-field"><span>Event</span>
          <select v-model="draft.event" @change="onEventChange">
            <option v-for="option in ruleEventOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label class="settings-field"><span>Action</span>
          <select v-model="draft.action">
            <option v-for="option in ruleActionOptions(draft.event)" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label v-if="fields.merged" class="settings-field"><span>Merged</span>
          <select v-model="draft.merged"><option value="">Any</option><option value="true">Merged</option><option value="false">Closed without merge</option></select>
        </label>
        <label v-if="fields.draft" class="settings-field"><span>Draft</span>
          <select v-model="draft.draft"><option value="">Any</option><option value="false">Not a draft</option><option value="true">Draft</option></select>
        </label>
        <label v-if="fields.baseBranch" class="settings-field"><span>Base branch</span>
          <input v-model="draft.baseBranch" type="text" maxlength="255" placeholder="Any branch" />
        </label>
        <label v-if="fields.reviewState" class="settings-field"><span>Review</span>
          <select v-model="draft.reviewState">
            <option value="">Any</option>
            <option v-for="option in reviewStateOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label v-if="fields.approvalsAtLeast" class="settings-field"><span>Approvals at least</span>
          <input v-model="draft.approvalsAtLeast" type="number" min="1" max="20" placeholder="Any" />
        </label>
        <label v-if="fields.conclusion" class="settings-field"><span>Conclusion</span>
          <select v-model="draft.conclusion">
            <option value="">Any</option>
            <option v-for="option in checkConclusionOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
      </fieldset>
      <fieldset class="settings-connector-rule-actions">
        <legend>Then</legend>
        <div v-for="(action, index) in draft.actions" :key="index" class="settings-connector-rule-action">
          <label v-if="action.kind === 'transition'" class="settings-field"><span>Move the ticket to status</span>
            <input v-model="action.toStatus" type="text" maxlength="200" required placeholder="In Review" />
          </label>
          <label v-else class="settings-field"><span>Comment</span>
            <textarea v-model="action.template" rows="3" maxlength="4000" required placeholder="PR opened: {{pr_url}}" />
            <small>Variables: {{ templateVariableHint }}. Values from GitHub are added as plain text.</small>
          </label>
          <button class="ghost-button" type="button" :aria-label="`Remove action ${index + 1}`" @click="draft.actions.splice(index, 1)">Remove</button>
        </div>
        <div class="settings-connector-actions">
          <button
            class="ghost-button"
            type="button"
            :disabled="draft.actions.some((action) => action.kind === 'transition') || draft.actions.length >= 5"
            @click="draft.actions.push({ kind: 'transition', toStatus: '' })"
          >Add status change</button>
          <button class="ghost-button" type="button" :disabled="draft.actions.length >= 5" @click="draft.actions.push({ kind: 'comment', template: '' })">Add comment</button>
        </div>
      </fieldset>
      <div class="settings-connector-actions">
        <button class="primary-button" type="submit" :disabled="saving || !draft.actions.length">{{ saving ? "Saving" : draft.id ? "Save new version" : "Save rule" }}</button>
        <button class="ghost-button" type="button" @click="draft = null">Cancel</button>
      </div>
    </form>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import type {
  TrackerConnectionView,
  TrackerRuleInput,
  TrackerRuleVersionView,
  TrackerRuleView,
} from "../../../../../../../../shared/ticket-connectors.mjs";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import SettingsRow from "../SettingsRow.vue";
import { trackerLabel } from "../connectors";
import {
  checkConclusionOptions,
  emptyRuleDraft,
  reviewStateOptions,
  ruleActionOptions,
  ruleDraftFrom,
  ruleEventOptions,
  ruleFieldsFor,
  ruleInputFromDraft,
  ruleSummary,
  templateVariableHint,
  type RuleDraft,
} from "../connector-rules";
import type { SettingsFeedback } from "../types";

const props = defineProps<{ connection: TrackerConnectionView; rulesApi?: import("../../../../../../../../shared/ui/connectors/types").TrackerApi["rules"] }>();
let live = true;
onBeforeUnmount(() => { live = false; });

const rules = ref<TrackerRuleView[]>([]);
const rooms = ref<string[]>([]);
const loaded = ref(false);
const feedback = ref<SettingsFeedback | null>(null);
const busyId = ref<string | null>(null);
const saving = ref(false);
const confirmRemoveId = ref<string | null>(null);
const history = reactive<Record<string, TrackerRuleVersionView[]>>({});
const draft = ref<RuleDraft | null>(null);

const api = () => props.rulesApi ?? (window as unknown as { letagentsDesktop: { connectors: { rules: NonNullable<typeof props.rulesApi> } } }).letagentsDesktop.connectors.rules;
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const fields = computed(() => draft.value ? ruleFieldsFor(draft.value.event, draft.value.action) : ruleFieldsFor("pull_request", "opened"));

function roomLabel(roomId: string | null): string {
  return roomId ? `room ${roomId}` : "every room";
}

function replace(rule: TrackerRuleView) {
  const index = rules.value.findIndex((entry) => entry.id === rule.id);
  if (index >= 0) rules.value.splice(index, 1, rule);
  else rules.value.push(rule);
  delete history[rule.id];
}

async function load() {
  try {
    const list = await api().list(props.connection.id);
    if (!live) return;
    rules.value = list.rules;
    rooms.value = list.rooms;
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "Rules could not be loaded.") };
  } finally {
    loaded.value = true;
  }
}

// Rules load when the section opens, so a closed section costs no request.
function onToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !loaded.value) void load();
}

async function run(id: string | null, task: () => Promise<void>) {
  busyId.value = id;
  feedback.value = null;
  try {
    await task();
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "The rule could not be changed. Try again.") };
  } finally {
    busyId.value = null;
  }
}

function startNew() {
  draft.value = emptyRuleDraft();
}

function edit(rule: TrackerRuleView) {
  draft.value = ruleDraftFrom(rule, rule.id);
}

/** PR6: fills the editor with a drafted rule. Nothing is saved until the person presses Save. */
function applyDraft(rule: TrackerRuleInput) {
  draft.value = ruleDraftFrom(rule, draft.value?.id ?? null);
}

// PR6: "Draft from a sentence". Behind the connection's Jev switch, as every Jev call.
const sentence = ref("");
const drafting = ref(false);
const canDraft = computed(() => props.connection.jev_linking_enabled && typeof api().draft === "function");

async function draftFromSentence() {
  const draftRule = api().draft;
  const text = sentence.value.trim();
  if (!draftRule || !text || drafting.value) return;
  drafting.value = true;
  feedback.value = null;
  try {
    const result = await draftRule(props.connection.id, text);
    if (result.draft) {
      applyDraft(result.draft);
      feedback.value = { state: "success", message: "Jev drafted the rule. Check every field, then press Save." };
    } else {
      feedback.value = { state: "error", message: result.error ?? "Jev could not draft this rule. Write it by hand." };
    }
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "Jev could not draft this rule. Write it by hand.") };
  } finally {
    drafting.value = false;
  }
}

function onEventChange() {
  if (!draft.value) return;
  draft.value.action = ruleActionOptions(draft.value.event)[0]!.value;
}

async function save() {
  const current = draft.value;
  if (!current) return;
  saving.value = true;
  feedback.value = null;
  try {
    const input = ruleInputFromDraft(current);
    const saved = current.id
      ? await api().update(props.connection.id, current.id, input)
      : await api().create(props.connection.id, input);
    replace(saved);
    draft.value = null;
    feedback.value = { state: "success", message: current.id ? `Saved version ${saved.version}.` : "Rule saved." };
  } catch (error) {
    feedback.value = { state: "error", message: message(error, "The rule could not be saved.") };
  } finally {
    saving.value = false;
  }
}

function toggle(rule: TrackerRuleView) {
  return run(rule.id, async () => {
    replace(await api().setEnabled(props.connection.id, rule.id, !rule.enabled));
  });
}

function toggleHistory(rule: TrackerRuleView) {
  if (history[rule.id]) {
    delete history[rule.id];
    return;
  }
  return run(rule.id, async () => {
    history[rule.id] = await api().versions(props.connection.id, rule.id);
  });
}

function rollback(rule: TrackerRuleView, version: number) {
  return run(rule.id, async () => {
    const saved = await api().rollback(props.connection.id, rule.id, version);
    replace(saved);
    feedback.value = { state: "success", message: `Rolled back: version ${saved.version} has version ${version}'s content.` };
  });
}

function remove(rule: TrackerRuleView) {
  if (confirmRemoveId.value !== rule.id) {
    confirmRemoveId.value = rule.id;
    return;
  }
  confirmRemoveId.value = null;
  return run(rule.id, async () => {
    await api().remove(props.connection.id, rule.id);
    rules.value = rules.value.filter((entry) => entry.id !== rule.id);
  });
}

defineExpose({ applyDraft });
</script>

<style scoped>
.settings-connector-rules {
  display: grid;
  gap: 8px;
}

.settings-connector-rule-sentence {
  display: grid;
  gap: 6px;
}

.settings-connector-rules summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-weight: 600;
}

.settings-connector-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.settings-connector-rule-history {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
}

.settings-connector-rule-history li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.settings-connector-rule-form,
.settings-connector-rule-trigger,
.settings-connector-rule-actions {
  display: grid;
  gap: 10px;
}

.settings-connector-rule-trigger,
.settings-connector-rule-actions {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}

.settings-connector-rule-action {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}

.settings-connector-rule-action .settings-field {
  flex: 1 1 280px;
}

.settings-connector-rule-form select,
.settings-connector-rule-form input,
.settings-connector-rule-form textarea {
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(10, 10, 10, 0.36);
  color: var(--text);
  font: inherit;
  padding: 6px 10px;
}
</style>
