<template>
  <section class="desktop-add-agent-connect" aria-label="Connect an existing agent">
    <h4>Keep working in your agent app</h4>
    <p v-if="localRoom">Connect an agent app on this Mac to share this local room. To collaborate from another device, publish the room to the cloud.</p>
    <template>
      <p>Add the LetAgents MCP connection in {{ provider?.name || 'your agent app' }}, then paste these room instructions into its conversation.</p>
      <button type="button" @click="copyInstructions">{{ copied ? 'Copied' : 'Copy room instructions' }}</button>
      <p v-if="copyFailed" role="status">Copy the instructions below; the clipboard is unavailable.</p>
      <details :open="copyFailed"><summary>Connection and instructions</summary><pre><code>{{ connectionConfig }}</code></pre><pre>{{ instructions }}</pre></details>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopAgentProvider } from "../../../../../../electron/ipc-types";
import { externalMcpProviderJoinPrompt } from "../../../../domain/managed-agents";
import { copyTextToClipboard } from "../../../../domain/clipboard";
const props = defineProps<{ provider: DesktopAgentProvider | null; roomIdentifier: string; repoRootPath: string | null; localRoom: boolean }>();
const copied = ref(false);
const copyFailed = ref(false);
const connectionConfig = JSON.stringify({ mcpServers: { letagents: { command: "npx", args: ["-y", "letagents"], env: { LETAGENTS_API_URL: "https://letagents.chat" } } } }, null, 2);
const instructions = computed(() => externalMcpProviderJoinPrompt(props.provider, props.roomIdentifier, props.repoRootPath));
watch(instructions, () => { copied.value = false; copyFailed.value = false; });
async function copyInstructions() {
  copied.value = await copyTextToClipboard(instructions.value);
  copyFailed.value = !copied.value;
}
</script>
