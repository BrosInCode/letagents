<template>
  <form class="inbox-response" @submit.prevent="submit">
    <label :for="id">Your response</label>
    <div class="inbox-response-box">
      <textarea :id="id" ref="input" :value="modelValue || ''" rows="3" maxlength="8000" :placeholder="showSuggestion ? suggestedReply : placeholder" :aria-describedby="showSuggestion ? `${id}-suggestion` : undefined" :disabled="disabled" required @input="updateDraft" @keydown="keydown" />
      <div class="inbox-response-controls">
        <span class="inbox-response-hint"><button v-if="showSuggestion" type="button" class="inbox-accept-suggestion" :disabled="disabled" aria-label="Accept suggested response" @click="acceptSuggestion"><kbd>Tab</kbd> to accept</button><span v-else-if="recipient">To {{ recipient }}</span><span v-if="showSuggestion" :id="`${id}-suggestion`" class="inbox-sr-only">Suggested response. Press Tab to accept, or type your own.</span></span>
        <button type="submit" class="inbox-button inbox-primary" :disabled="disabled || !modelValue?.trim()">{{ disabled ? 'Sending…' : 'Send response' }}<svg v-if="!disabled" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></button>
      </div>
    </div>
    <div class="inbox-response-bottom"><button ref="closeButton" type="button" class="inbox-text-button" :disabled="disabled" @click="askToClose">Close without answering</button></div>
    <div v-if="confirmClose" class="inbox-close-confirm" role="group" aria-label="Confirm closing this request"><p>Close this request without a decision? The agent will be told that it was closed, not approved.</p><div class="inbox-actions"><button type="button" class="inbox-button" :disabled="disabled" @click="close">Close request</button><button ref="keepButton" type="button" class="inbox-text-button" :disabled="disabled" @click="keepOpen">Keep open</button></div></div>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { attentionRecommendationReply } from '../../room-knowledge.mjs';
import './inbox.css';
const props = withDefaults(defineProps<{ id: string; modelValue: string | undefined; suggestion?: string; disabled?: boolean; recipient?: string }>(), { suggestion: '', disabled: false, recipient: '' });
const emit = defineEmits<{ 'update:modelValue': [draft: string]; submit: []; close: [] }>();
const input = ref<HTMLTextAreaElement>(), closeButton = ref<HTMLButtonElement>(), keepButton = ref<HTMLButtonElement>();
const confirmClose = ref(false);
const suggestedReply = computed(() => attentionRecommendationReply(props.suggestion));
const showSuggestion = computed(() => props.modelValue === undefined && Boolean(suggestedReply.value) && suggestedReply.value.length <= 8000);
const placeholder = computed(() => props.recipient ? `Give ${props.recipient} a decision or next step…` : 'Give the agent a decision or next step…');
watch(() => props.id, () => { confirmClose.value = false; });
function updateDraft(event: Event) { if (!props.disabled) emit('update:modelValue', (event.target as HTMLTextAreaElement).value); }
async function acceptSuggestion() {
  if (props.disabled || !showSuggestion.value || input.value?.value) return;
  emit('update:modelValue', suggestedReply.value); await nextTick();
  input.value?.focus(); input.value?.setSelectionRange(suggestedReply.value.length, suggestedReply.value.length);
}
function keydown(event: KeyboardEvent) {
  if (props.disabled || event.isComposing) return;
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && showSuggestion.value && !(event.target as HTMLTextAreaElement).value) {
    event.preventDefault(); void acceptSuggestion();
  } else if (event.key === 'Escape' && showSuggestion.value) {
    event.preventDefault(); event.stopPropagation(); emit('update:modelValue', '');
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); submit();
  }
}
function submit() { if (!props.disabled && props.modelValue?.trim()) emit('submit'); }
async function askToClose() { if (props.disabled) return; confirmClose.value = true; await nextTick(); keepButton.value?.focus(); }
async function keepOpen() { confirmClose.value = false; await nextTick(); closeButton.value?.focus(); }
function close() { if (!props.disabled) emit('close'); }
</script>
