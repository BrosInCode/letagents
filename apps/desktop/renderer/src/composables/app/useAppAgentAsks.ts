import { onBeforeUnmount, onMounted, ref } from "vue";
import { desktopIpc } from "../../ipc/index.js";

/** "Ask for an agent": the asker's sheet, and the giver's screen opened from a link. */
export function useAppAgentAsks() {
  const askAgentOpen = ref(false);
  const giveAgentToken = ref<string | null>(null);
  let unsubscribe: (() => void) | null = null;
  onMounted(() => {
    void desktopIpc.asks?.takePendingLink().then(token => { if (token) giveAgentToken.value = token; }).catch(() => undefined);
    unsubscribe = desktopIpc.asks?.onOpenLink(token => { giveAgentToken.value = token; }) ?? null;
  });
  onBeforeUnmount(() => unsubscribe?.());
  return { askAgentOpen, giveAgentToken };
}
