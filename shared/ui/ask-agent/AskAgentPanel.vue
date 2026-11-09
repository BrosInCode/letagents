<template>
  <form class="give-agent-panel ask-agent-panel" :class="{ 'is-result': Boolean(createdLink) }" @submit.prevent="submit">
    <header class="give-header">
      <div class="give-heading">
        <h2 :id="headingId" tabindex="-1">Ask for an agent</h2>
        <slot name="close" />
      </div>
      <p v-if="!createdLink" class="ask-intro">Invite someone to share an agent with your room.</p>
    </header>

    <div v-if="createdLink" class="give-body give-result" role="status">
      <div class="give-result-avatar">
        <ChatAvatar :name="selectedModel?.label || 'Agent'" :provider="selectedModel?.providerId" agent />
        <span aria-hidden="true">✓</span>
      </div>
      <h3 ref="resultHeading" tabindex="-1">Your link is ready</h3>
      <p>Share it with someone who can give you an agent. It works for one person and expires in 24 hours.</p>
      <div class="ask-ready-link">
        <input :value="createdLink" readonly aria-label="Request link" data-testid="agent-ask-link" @focus="selectLink" />
        <button type="button" class="give-secondary" @click="emit('copy')">{{ copied ? 'Copied' : 'Copy link' }}</button>
      </div>
      <p v-if="error" class="give-field-error" role="alert">{{ error }}</p>
    </div>

    <div v-else class="give-body ask-fields" :aria-busy="busy || loading">
      <section>
        <div class="give-section-label"><h3>Room</h3></div>
        <FilterDropdown v-model="roomChoice" class="give-picker ask-room-picker" label="Room" :options="roomOptions" :disabled="busy || loading" searchable match-trigger-width data-testid="agent-ask-room">
          <template #trigger>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 3h9v11H3Z" /></svg>
            <span class="give-picker-label">{{ loading ? 'Loading rooms…' : roomOptions.find(room => room.id === roomChoice)?.label }}</span>
          </template>
          <template #option="{ option }">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="option.id === '__new__'" d="M12 5v14M5 12h14" /><path v-else d="M3 7V5h7l2 3h9v11H3Z" /></svg>
            <span class="give-picker-label">{{ option.label }}</span>
          </template>
        </FilterDropdown>
        <label v-if="roomChoice === '__new__'" class="ask-field ask-new-room">
          <span>New room name <small>Optional</small></span>
          <input v-model="newRoomName" type="text" maxlength="80" placeholder="Name your room" :disabled="busy" />
        </label>
      </section>

      <section>
        <div class="give-section-label"><h3>Agent</h3></div>
        <FilterDropdown v-model="modelChoice" class="give-picker ask-model-picker" label="Agent" :options="modelOptions" :disabled="busy || loading || !models.length" searchable search-placeholder="Find a model…" match-trigger-width data-testid="agent-ask-model">
          <template #trigger>
            <ChatAvatar v-if="selectedModel" :name="selectedModel.label" :provider="selectedModel.providerId" agent />
            <span class="give-picker-label"><strong>{{ loading ? 'Loading agents…' : selectedModel?.label || 'No agents available' }}</strong><small v-if="selectedModel && !loading">{{ providerLabel(selectedModel.providerId) }}</small></span>
          </template>
          <template #option="{ option }">
            <ChatAvatar :name="option.label" :provider="models[Number(option.id)]?.providerId" agent />
            <span class="give-picker-label">{{ option.label }}<small>{{ providerLabel(models[Number(option.id)]?.providerId ?? '') }}</small></span>
          </template>
        </FilterDropdown>
        <p v-if="loading" class="ask-loading" role="status">Loading available agents…</p>
        <div v-else-if="!models.length" class="give-error" role="alert">
          <div><p>{{ error || 'No agents are available right now.' }}</p><button type="button" class="give-secondary" @click="emit('retry')">Try again</button></div>
        </div>
      </section>

      <section>
        <div class="give-usage-heading">
          <div><h3>Usage you need <small class="ask-optional">Optional</small></h3><p>Of the giver’s main usage limit</p></div>
          <div class="give-amount"><span :class="{ 'ask-any': chosenAmount === null }">{{ custom && chosenAmount === null ? '—' : chosenAmount ?? 'Any' }}</span><small v-if="chosenAmount !== null">%</small></div>
        </div>
        <div class="give-allocation" aria-hidden="true"><span v-for="index in 25" :key="index" :style="{ '--fill': chosenAmount === null ? 0 : Math.max(0, Math.min(1, (chosenAmount - (index - 1) * 4) / 4)) }" /></div>
        <div class="give-amount-choices ask-amount-choices" role="group" aria-label="Usage amount">
          <button type="button" :aria-pressed="!custom && amount === null" :disabled="busy" @click="pickAmount(null)">Any</button>
          <button v-for="choice in AMOUNT_CHOICES" :key="choice" type="button" :aria-pressed="!custom && amount === choice" :disabled="busy" @click="pickAmount(choice)">{{ choice }}%</button>
          <button type="button" :aria-pressed="custom" :disabled="busy" @click="openCustom">Custom</button>
        </div>
        <div v-if="custom" class="give-custom">
          <label :for="`${headingId}-amount`">Custom amount</label>
          <span><input :id="`${headingId}-amount`" ref="customInput" v-model="customText" type="text" inputmode="numeric" autocomplete="off" :disabled="busy" :aria-invalid="chosenAmount === null" :aria-describedby="chosenAmount === null ? `${headingId}-amount-error` : undefined" /><span>%</span></span>
        </div>
        <p v-if="custom && chosenAmount === null" :id="`${headingId}-amount-error`" class="give-field-error" role="status">Enter a whole number from 1 to 100.</p>
      </section>

      <label class="ask-field">
        <span>Message <small>Optional</small></span>
        <textarea v-model="note" rows="3" maxlength="500" placeholder="What would you like the agent to help with?" :disabled="busy" />
      </label>
      <p v-if="error && models.length" class="give-error" role="alert">{{ error }}</p>
    </div>

    <footer class="give-footer">
      <button v-if="createdLink" type="button" class="give-primary" @click="emit('close')">Done</button>
      <div v-else class="give-actions">
        <button type="button" class="give-secondary" :disabled="busy" @click="emit('close')">Cancel</button>
        <button type="submit" class="give-primary" :disabled="busy || loading || !selectedModel || (custom && chosenAmount === null)" data-testid="agent-ask-create">
          {{ busy ? 'Creating link…' : 'Create link' }}
          <span v-if="busy" class="give-spinner" aria-hidden="true" />
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
        </button>
      </div>
    </footer>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ChatAvatar from '../ChatAvatar.vue';
import FilterDropdown from '../FilterDropdown.vue';
import { AMOUNT_CHOICES, parseCustomAmount } from '../give-agent/types';
import type { AskAgentInput, AskAgentModel } from './types';
import '../give-agent/give-agent.css';
import './ask-agent.css';

const props = withDefaults(defineProps<{
  models: AskAgentModel[];
  rooms: { id: string; label: string }[];
  initialRoom?: string | null;
  presetModelLabel?: string | null;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  createdLink?: string | null;
  copied?: boolean;
  headingId?: string;
}>(), { headingId: 'ask-agent-title' });
const emit = defineEmits<{ create: [input: AskAgentInput]; close: []; retry: []; copy: [] }>();
const roomOptions = computed(() => [...props.rooms, { id: '__new__', label: 'New room' }]);
const roomChoice = ref(props.initialRoom ?? props.rooms[0]?.id ?? '__new__');
watch([() => props.rooms, () => props.loading], () => {
  if (!props.loading && !roomOptions.value.some(room => room.id === roomChoice.value)) roomChoice.value = props.rooms[0]?.id ?? '__new__';
}, { immediate: true });
const modelChoice = ref('');
const modelOptions = computed(() => props.models.map((model, index) => ({ id: String(index), label: model.label, keywords: `${providerLabel(model.providerId)} ${model.model ?? ''}` })));
const selectedModel = computed(() => modelChoice.value === '' ? undefined : props.models[Number(modelChoice.value)]);
const newRoomName = ref(''), note = ref(''), customText = ref('');
const amount = ref<number | null>(null), custom = ref(false);
const customInput = ref<HTMLInputElement>(), resultHeading = ref<HTMLElement>();
const chosenAmount = computed(() => custom.value ? parseCustomAmount(customText.value) : amount.value);
watch(() => props.models, models => {
  if (selectedModel.value) return;
  const preset = models.findIndex(model => model.label === props.presetModelLabel);
  modelChoice.value = models.length ? String(Math.max(0, preset)) : '';
}, { immediate: true });
watch(() => props.createdLink, async link => { if (link) { await nextTick(); resultHeading.value?.focus({ preventScroll: true }); } });
function providerLabel(provider: string) {
  return ({ 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' } as Record<string, string>)[provider] || provider;
}
function pickAmount(value: number | null) { amount.value = value; custom.value = false; }
async function openCustom() {
  customText.value = String(chosenAmount.value ?? ''); custom.value = true;
  await nextTick(); customInput.value?.focus(); customInput.value?.select();
}
function selectLink(event: FocusEvent) { (event.target as HTMLInputElement).select(); }
function submit() {
  if (props.busy || props.loading || props.createdLink || !selectedModel.value || (custom.value && chosenAmount.value === null)) return;
  if (!roomOptions.value.some(room => room.id === roomChoice.value)) return;
  emit('create', { roomId: roomChoice.value, newRoomName: newRoomName.value.trim(), providerId: selectedModel.value.providerId, model: selectedModel.value.model, amountPercent: chosenAmount.value, note: note.value });
}
</script>
