<template>
  <div class="give-agent-panel" :class="{ 'is-result': Boolean(done) }">
    <header class="give-header">
      <div class="give-heading"><h2 :id="headingId" tabindex="-1">{{ done ? 'Agent request' : 'Give an agent' }}</h2><slot name="close" /></div>
      <div v-if="request && !done && !unavailable && !loading" class="give-context">
        <div class="give-recipient">
          <ChatAvatar :name="request.asker" :avatar-url="request.asker_avatar_url" />
          <strong>{{ request.asker }}</strong>
          <span v-if="request.room_display_name" class="give-room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 3h9v11H3Z" /></svg>{{ request.room_display_name }}</span>
        </div>
        <div v-if="request.note" class="give-message">
          <p><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Z" /></svg>Message</p>
          <blockquote>{{ request.note }}</blockquote>
        </div>
      </div>
    </header>
    <div v-if="loading" class="give-body give-state" role="status">Opening the request…</div>
    <div v-else-if="unavailable || !request" class="give-body give-state" role="status">
      <h3>Request unavailable</h3><p>{{ unavailable || error || "This link isn't valid." }}</p>
      <button v-if="error" type="button" class="give-secondary" @click="emit('retry')">Try again</button>
    </div>
    <div v-else-if="done" class="give-body give-result" role="status">
      <div class="give-result-avatar"><ChatAvatar :name="current?.model.label || request.model_label" :provider="current?.model.providerId || request.provider_id" agent /><span>✓</span></div>
      <h3 ref="resultHeading" tabindex="-1">{{ offered ? 'Offer sent' : 'Agent added' }}</h3><p>{{ done }}</p>
      <div class="give-result-summary"><span>{{ current?.model.label || request.model_label }}</span><span>{{ amount }}% of your usage limit</span></div>
    </div>
    <div v-else class="give-body" :aria-busy="Boolean(busy)">
      <section>
        <div class="give-section-label"><h3>Agent</h3><span v-if="handoff || current?.requested" class="give-requested">Requested</span></div>
        <div v-if="handoff" class="give-model-summary"><ChatAvatar :name="request.model_label" :provider="request.provider_id" agent /><strong>{{ request.model_label }}</strong></div>
        <FilterDropdown v-else class="give-picker" :model-value="selected || ''" label="Agent" :options="dropdownOptions" :disabled="Boolean(busy) || !options.length" match-trigger-width @update:model-value="select">
          <template #trigger><ChatAvatar v-if="current" :name="current.model.label" :provider="current.model.providerId" agent /><span class="give-picker-label"><strong>{{ current?.model.label || 'No agents available' }}</strong><small>{{ current ? providerLabel(current.model.providerId) : 'Connect an agent app to continue.' }}</small></span></template>
          <template #option="{ option }"><ChatAvatar :name="option.label" :provider="options.find(item => item.key === option.id)?.model.providerId" agent /><span class="give-picker-label">{{ option.label }}<small v-if="option.disabled">Can’t be given yet</small><small v-else-if="options.find(item => item.key === option.id)?.requested" class="give-requested">Requested</small></span></template>
        </FilterDropdown>
        <p v-if="!handoff && current && !current.requested" class="give-choice-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></svg>{{ request.asker }} will need to accept this alternative.</p>
      </section>
      <section v-if="!handoff" class="give-usage">
        <div class="give-usage-heading"><div><h3>Usage to share</h3><p>Of your main usage limit</p></div><div class="give-amount"><span>{{ amount ?? '—' }}</span><small>%</small></div></div>
        <div class="give-allocation" aria-hidden="true"><span v-for="index in 25" :key="index" :style="{ '--fill': amount === null ? 0 : Math.max(0, Math.min(1, (amount - (index - 1) * 4) / 4)) }" /></div>
        <div class="give-amount-choices" role="group" aria-label="Usage amount"><button v-for="choice in AMOUNT_CHOICES" :key="choice" type="button" :aria-pressed="!custom && preset === choice" :disabled="Boolean(busy)" @click="preset = choice; custom = false">{{ choice }}%</button><button type="button" :aria-pressed="custom" :disabled="Boolean(busy)" @click="openCustom">Custom</button></div>
        <div v-if="custom" class="give-custom"><label :for="`${headingId}-amount`">Custom amount</label><span><input :id="`${headingId}-amount`" ref="customInput" v-model="customText" inputmode="numeric" type="text" autocomplete="off" :disabled="Boolean(busy)" :aria-invalid="amount === null" :aria-describedby="`${headingId}-amount-error`" @keydown.enter.prevent="submit" /><span>%</span></span></div>
        <p v-if="amount === null" :id="`${headingId}-amount-error`" class="give-field-error" role="status">Enter a whole number from 1 to 100.</p>
      </section>
      <p v-else class="give-handoff-note">{{ request.amount_percent ? `They’re asking for ${request.amount_percent}% of your main usage limit. ` : '' }}Choose an agent and how much to give in the LetAgents app on your Mac.</p>
      <div v-if="error" class="give-error" role="alert"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></svg><div><p>{{ error }}</p><button v-if="!options.length && !handoff" type="button" class="give-secondary" :disabled="Boolean(busy)" @click="emit('retry')">Try again</button></div></div>
    </div>
    <footer class="give-footer">
      <template v-if="done || unavailable || (!request && !loading)"><button v-if="!handoff" type="button" class="give-primary" @click="emit('close')">{{ done ? 'Done' : 'Close' }}</button><slot v-else name="unavailable-footer" /></template>
      <template v-else-if="!loading">
        <p class="give-terms"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></svg>Uses your quota. Once given, it can’t be taken back.</p>
        <slot v-if="handoff" name="handoff" />
        <div v-else class="give-actions"><button type="button" class="give-secondary" :disabled="Boolean(busy)" data-testid="agent-give-cant" @click="emit('decline')">{{ busy === 'decline' ? 'Sending…' : 'Can’t right now' }}</button><button type="button" class="give-primary" :disabled="Boolean(busy) || !current?.canGive || amount === null" data-testid="agent-give-add" @click="submit"><span>{{ busy === 'give' ? (current?.requested ? 'Adding agent…' : 'Sending offer…') : retryGive ? 'Try again' : current?.requested ? 'Give agent' : 'Offer agent' }}</span><svg v-if="!busy" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg><span v-else class="give-spinner" aria-hidden="true" /></button></div>
      </template>
    </footer>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ChatAvatar from '../ChatAvatar.vue';
import FilterDropdown from '../FilterDropdown.vue';
import { AMOUNT_CHOICES, parseCustomAmount, type GiveAgentRequest, type GiveAgentOption } from './types';
import './give-agent.css';
const props = withDefaults(defineProps<{
  request: GiveAgentRequest | null; options?: GiveAgentOption[]; selected?: string | null; initialAmount?: number;
  headingId?: string; loading?: boolean; unavailable?: string | null; error?: string | null;
  busy?: 'give' | 'decline' | null; done?: string | null; offered?: boolean; handoff?: boolean; retryGive?: boolean;
}>(), { options: () => [], selected: null, initialAmount: 10, headingId: 'give-agent-title', busy: null });
const emit = defineEmits<{ 'update:selected': [key: string]; give: [amount: number]; decline: []; close: []; retry: []; }>();
const resultHeading = ref<HTMLElement>();
watch(() => props.done, async done => { if (done) { await nextTick(); resultHeading.value?.focus({ preventScroll: true }); } });
const preset = ref(10), custom = ref(false), customText = ref('10'), customInput = ref<HTMLInputElement>();
const amount = computed(() => custom.value ? parseCustomAmount(customText.value) : preset.value);
const current = computed(() => props.options.find(option => option.key === props.selected));
const dropdownOptions = computed(() => props.options.map(option => ({ id: option.key, label: option.model.label, disabled: !option.canGive })));
watch([() => props.request?.id, () => props.initialAmount], () => {
  preset.value = props.initialAmount; customText.value = String(props.initialAmount);
  custom.value = !(AMOUNT_CHOICES as readonly number[]).includes(props.initialAmount);
}, { immediate: true });
function providerLabel(provider: string) { return ({ 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' } as Record<string, string>)[provider] || provider; }
function select(key: string) { if (!props.busy) emit('update:selected', key); }
async function openCustom() { if (props.busy) return; customText.value = String(amount.value ?? ''); custom.value = true; await nextTick(); customInput.value?.focus(); customInput.value?.select(); }
function submit() { if (!props.busy && current.value?.canGive && amount.value !== null) emit('give', amount.value); }
</script>
