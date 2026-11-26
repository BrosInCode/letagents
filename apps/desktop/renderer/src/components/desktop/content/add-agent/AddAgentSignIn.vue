<template>
  <section
    v-if="needsSignIn || update"
    class="desktop-add-agent-sign-in"
    data-testid="desktop-add-agent-sign-in"
    aria-label="Agent sign-in"
    :data-state="update?.state ?? 'idle'"
  >
    <template v-if="update && controller.active.value">
      <div class="desktop-add-agent-sign-in-header">
        <strong role="status" aria-live="polite">{{ heading }}</strong>
        <button type="button" class="desktop-add-agent-sign-in-quiet" @click="controller.cancel()">Cancel</button>
      </div>
      <p>{{ update.message || description }}</p>
      <button
        v-if="update.url"
        type="button"
        class="desktop-add-agent-sign-in-link"
        :title="update.url"
        @click="controller.openLink()"
      >Open {{ linkLabel }}</button>
      <div v-if="update.code" class="desktop-add-agent-sign-in-code">
        <code aria-label="One-time code">{{ update.code }}</code>
        <button type="button" class="desktop-add-agent-sign-in-quiet" @click="controller.copyCode()">
          {{ controller.codeCopied.value ? "Copied" : "Copy code" }}
        </button>
      </div>
      <form v-if="update.acceptsCode" class="desktop-add-agent-sign-in-paste" @submit.prevent="controller.submitCode()">
        <input
          :value="controller.pastedCode.value"
          @input="controller.setPastedCode(($event.target as HTMLInputElement).value)"
          type="text"
          aria-label="Code from the browser"
          placeholder="Paste the code from the browser"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit" :disabled="!controller.pastedCode.value.trim() || controller.submittingCode.value">
          {{ controller.submittingCode.value ? "Sending..." : "Submit" }}
        </button>
      </form>
    </template>
    <AddAgentFeedback v-else-if="update?.state === 'failed' && update.message" :message="update.message" tone="error" />
    <AddAgentFeedback v-if="controller.error.value" :message="controller.error.value" tone="error" />
    <button
      v-if="needsSignIn && !controller.active.value && authCommand"
      type="button"
      class="desktop-add-agent-sign-in-quiet"
      :disabled="copying"
      @click="emit('copy-command')"
    >{{ copying ? "Copying..." : "Copy the sign-in command instead" }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import AddAgentFeedback from "./AddAgentFeedback.vue";
import type { ProviderSignInController } from "./useProviderSignIn";

const props = defineProps<{
  controller: ProviderSignInController;
  needsSignIn: boolean;
  authCommand: string | null;
  copying: boolean;
}>();
const emit = defineEmits<{ "copy-command": [] }>();

const update = computed(() => props.controller.update.value);
const heading = computed(() => {
  const state = update.value?.state;
  if (state === "starting") return "Starting sign-in...";
  if (state === "verifying") return "Checking the sign-in...";
  return update.value?.inTerminal ? "Finish in Terminal" : "Finish in your browser";
});
/** The sign-in page as a short label: a device page keeps its path, a long OAuth link shows its host. */
const linkLabel = computed(() => {
  try {
    const url = new URL(update.value?.url ?? "");
    const path = url.pathname.replace(/\/$/, "");
    return !url.search && path.length <= 24 ? `${url.host}${path}` : url.host;
  } catch {
    return "the sign-in page";
  }
});
const description = computed(() => {
  if (update.value?.state === "starting") return "Waiting for the sign-in page.";
  if (update.value?.state === "verifying") return "This takes a few seconds.";
  if (update.value?.code) return "Open the sign-in page, then enter this one-time code.";
  if (update.value?.acceptsCode) return "If the browser shows a code, paste it here.";
  return "The sign-in page opens in your browser. Use the link if it did not open.";
});
</script>

<style scoped>
.desktop-add-agent-sign-in {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-subtle);
  font-size: 0.78rem;
}

.desktop-add-agent-sign-in[data-state="idle"],
.desktop-add-agent-sign-in[data-state="failed"] {
  padding: 0;
  border: 0;
  background: transparent;
}

.desktop-add-agent-sign-in-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.desktop-add-agent-sign-in-header strong {
  color: var(--text);
  font-size: 0.84rem;
  font-weight: 600;
}

.desktop-add-agent-sign-in p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.45;
}

.desktop-add-agent-sign-in-link {
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  text-align: left;
  text-decoration: underline;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-add-agent-sign-in-code,
.desktop-add-agent-sign-in-paste {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.desktop-add-agent-sign-in-code code {
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.24);
  color: var(--text);
  font-size: 0.95rem;
  letter-spacing: 0.08em;
}

.desktop-add-agent-sign-in-paste input {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.24);
  color: var(--text);
  font: inherit;
}

.desktop-add-agent-sign-in-paste button {
  min-height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: var(--text);
  color: var(--bg);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}

.desktop-add-agent-sign-in-paste button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.desktop-add-agent-sign-in-quiet {
  justify-self: start;
  min-height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
}

.desktop-add-agent-sign-in-quiet:hover:not(:disabled) {
  color: var(--text);
}

.desktop-add-agent-sign-in button:focus-visible,
.desktop-add-agent-sign-in input:focus-visible {
  outline: 2px solid var(--text-secondary);
  outline-offset: 2px;
}
</style>
