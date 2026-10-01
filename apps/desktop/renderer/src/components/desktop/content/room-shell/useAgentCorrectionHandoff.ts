import { computed, ref } from "vue";
import {
  agentCorrectionTargets,
  type AgentInspectorCorrectionRequest,
  type AgentInspectorProjection,
  type ComposerCorrectionHandoff,
} from "../../../../domain/agent-inspector";

/**
 * Steering a busy agent from the room: an Activity row or the composer opens
 * the agent's Inspector on the correction box for its live turn. Nothing is
 * sent from here; applying still goes through the Inspector's fenced
 * steer_turn action. Composer text moved into the box goes back to the
 * composer if the Inspector closes without applying it.
 */
export function useAgentCorrectionHandoff(options: {
  projections(): readonly AgentInspectorProjection[];
  openInspector(projection: AgentInspectorProjection): void;
  restoreComposerDraft(draft: string): void;
}) {
  const correctionRequest = ref<AgentInspectorCorrectionRequest | null>(null);
  const correctableAgents = computed(() => agentCorrectionTargets(options.projections()));
  let sequence = 0;
  let composerHandoff: { requestId: number; draft: string } | null = null;

  function openCorrection(entryId: string, text = ""): boolean {
    const projection = options.projections().find((candidate) => candidate.entryId === entryId);
    const control = projection?.turnControl;
    if (!projection || control?.status !== "ready" || !control.canCorrect) return false;
    options.openInspector(projection);
    correctionRequest.value = { id: ++sequence, entryId, providerTurnId: control.providerTurnId, text: text.trim() };
    return true;
  }

  function openCorrectionFromComposer(handoff: ComposerCorrectionHandoff, opened: (opened: boolean) => void): void {
    const handedOver = openCorrection(handoff.entryId, handoff.text);
    if (handedOver && correctionRequest.value) {
      composerHandoff = { requestId: correctionRequest.value.id, draft: handoff.draft };
    }
    opened(handedOver);
  }

  /** Applying a correction keeps its text out of the composer; abandoning it does not. */
  function releaseCorrection(release: { restoreComposerText: boolean }): void {
    const handoff = composerHandoff;
    composerHandoff = null;
    if (release.restoreComposerText && handoff && handoff.requestId === correctionRequest.value?.id) {
      options.restoreComposerDraft(handoff.draft);
    }
    correctionRequest.value = null;
  }

  return { correctionRequest, correctableAgents, openCorrection, openCorrectionFromComposer, releaseCorrection };
}
