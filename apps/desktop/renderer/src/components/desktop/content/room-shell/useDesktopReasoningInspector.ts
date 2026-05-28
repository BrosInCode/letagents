import { computed, ref, watch, type Ref } from "vue";
import type {
  DesktopReasoningSession,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import { latestReasoningSessionForTarget } from "../../../../domain/reasoning";
import type { AgentModalTarget } from "../DesktopChatMessage.vue";
import {
  buildAgentFallbackReasoningSession,
  sanitizeFallbackId,
} from "./reasoningFallback";

export function useDesktopReasoningInspector(options: {
  roomIdentifier: Readonly<Ref<string>>;
  reasoningSessions: Readonly<Ref<readonly DesktopReasoningSession[]>>;
  roomMessagesForAgentInsight: Readonly<Ref<readonly DesktopRoomMessage[]>>;
}) {
  const selectedReasoningSessionId = ref<string | null>(null);
  const selectedReasoningSessionCache = ref<DesktopReasoningSession | null>(null);
  const selectedReasoningFallbackTarget = ref<AgentModalTarget | null>(null);

  const selectedReasoningSession = computed(() => {
    const directSession = options.reasoningSessions.value.find(
      (session) => session.id === selectedReasoningSessionId.value
    );
    if (directSession) return directSession;
    const target = selectedReasoningFallbackTarget.value;
    return target ? latestReasoningSessionForTarget(target, options.reasoningSessions.value) : null;
  });
  const selectedReasoningSessionForInspector = computed(() =>
    selectedReasoningSession.value
    || (selectedReasoningFallbackTarget.value
      ? buildAgentFallbackReasoningSession(
          selectedReasoningFallbackTarget.value,
          options.roomIdentifier.value,
          options.roomMessagesForAgentInsight.value,
        )
      : null)
    || selectedReasoningSessionCache.value
  );

  watch(
    () => options.roomIdentifier.value,
    () => closeReasoningInspector(),
  );

  watch(selectedReasoningSession, (session) => {
    if (session) {
      selectedReasoningSessionCache.value = session;
    }
  });

  function openReasoningInspector(sessionId: string): void {
    selectedReasoningSessionId.value = sessionId;
    selectedReasoningSessionCache.value =
      options.reasoningSessions.value.find((session) => session.id === sessionId) || null;
    selectedReasoningFallbackTarget.value = null;
  }

  function openAgentReasoningFallback(target: AgentModalTarget): void {
    const actorLabel = target.actorLabel || target.sender || target.displayName;
    selectedReasoningSessionId.value = `pending-agent-reasoning:${sanitizeFallbackId(actorLabel)}`;
    selectedReasoningFallbackTarget.value = target;
    selectedReasoningSessionCache.value = buildAgentFallbackReasoningSession(
      target,
      options.roomIdentifier.value,
      options.roomMessagesForAgentInsight.value,
    );
  }

  function closeReasoningInspector(): void {
    selectedReasoningSessionId.value = null;
    selectedReasoningSessionCache.value = null;
    selectedReasoningFallbackTarget.value = null;
  }

  return {
    selectedReasoningSessionId,
    selectedReasoningSessionForInspector,
    openReasoningInspector,
    openAgentReasoningFallback,
    closeReasoningInspector,
  };
}
