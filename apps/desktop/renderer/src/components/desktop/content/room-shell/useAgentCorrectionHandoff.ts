import { computed, onScopeDispose, ref, watch } from "vue";
import {
  agentCorrectionTargets,
  type AgentInspectorCorrectionRequest,
  type AgentInspectorProjection,
  type ComposerCorrectionHandoff,
} from "../../../../domain/agent-inspector";
import { captureDesktopMessageDraftRestore } from "../../../../domain/desktop-message-drafts";

/**
 * Steering a busy agent from the room: an Activity row or the composer opens
 * the agent's Inspector on the correction box for its live turn. Nothing is
 * sent from here; applying still goes through the Inspector's fenced
 * steer_turn action. Composer text moved into the box goes back to its room's
 * draft unless it is applied: when the Inspector closes or switches agent,
 * the room changes, or the room shell unmounts.
 */
export function useAgentCorrectionHandoff(options: {
  roomIdentifier(): string;
  projections(): readonly AgentInspectorProjection[];
  openInspector(projection: AgentInspectorProjection): void;
}) {
  const correctionRequest = ref<AgentInspectorCorrectionRequest | null>(null);
  const correctableAgents = computed(() => agentCorrectionTargets(options.projections()));
  let sequence = 0;
  let composerHandoff: { requestId: number; draft: string; restore: (text: string) => boolean } | null = null;

  function openCorrection(entryId: string, text = ""): boolean {
    const projection = options.projections().find((candidate) => candidate.entryId === entryId);
    const control = projection?.turnControl;
    if (!projection || control?.status !== "ready" || !control.canCorrect) return false;
    options.openInspector(projection);
    correctionRequest.value = { id: ++sequence, entryId, providerTurnId: control.providerTurnId, text: text.trim() };
    return true;
  }

  /** The Activity row: if the turn ended since it rendered, still show the agent. */
  function openCorrectionOrInspector(entryId: string): void {
    if (openCorrection(entryId)) return;
    const projection = options.projections().find((candidate) => candidate.entryId === entryId);
    if (projection) options.openInspector(projection);
  }

  function openCorrectionFromComposer(handoff: ComposerCorrectionHandoff, opened: (opened: boolean) => void): void {
    const handedOver = openCorrection(handoff.entryId, handoff.text);
    if (handedOver && correctionRequest.value) {
      composerHandoff = {
        requestId: correctionRequest.value.id,
        draft: handoff.draft,
        restore: captureDesktopMessageDraftRestore(handoff.draftNamespace),
      };
    }
    opened(handedOver);
  }

  /** Applying a correction keeps its text out of the composer; abandoning it does not. */
  function releaseCorrection(release: { restoreComposerText: boolean }): void {
    const handoff = composerHandoff;
    composerHandoff = null;
    if (release.restoreComposerText && handoff && handoff.requestId === correctionRequest.value?.id) {
      handoff.restore(handoff.draft);
    }
    correctionRequest.value = null;
  }

  watch(options.roomIdentifier, () => releaseCorrection({ restoreComposerText: true }));
  onScopeDispose(() => releaseCorrection({ restoreComposerText: true }));

  return {
    correctionRequest,
    correctableAgents,
    openCorrection,
    openCorrectionOrInspector,
    openCorrectionFromComposer,
    releaseCorrection,
  };
}
