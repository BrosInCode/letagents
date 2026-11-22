import { computed, onScopeDispose, ref, watch } from "vue";
import {
  agentCorrectionTargets,
  type AgentInspectorCorrectionRequest,
  type AgentInspectorProjection,
} from "../../../../domain/agent-inspector";

/** Open the Inspector's correction box from the Activity tab. */
export function useAgentCorrectionHandoff(options: {
  roomIdentifier(): string;
  projections(): readonly AgentInspectorProjection[];
  openInspector(projection: AgentInspectorProjection): void;
}) {
  const correctionRequest = ref<AgentInspectorCorrectionRequest | null>(null);
  const correctableAgents = computed(() => agentCorrectionTargets(options.projections()));
  let sequence = 0;

  function openCorrection(entryId: string): boolean {
    const projection = options.projections().find((candidate) => candidate.entryId === entryId);
    const control = projection?.turnControl;
    if (!projection || control?.status !== "ready" || !control.canCorrect) return false;
    options.openInspector(projection);
    correctionRequest.value = { id: ++sequence, entryId, providerTurnId: control.providerTurnId, text: "" };
    return true;
  }

  /** The Activity row: if the turn ended since it rendered, still show the agent. */
  function openCorrectionOrInspector(entryId: string): void {
    if (openCorrection(entryId)) return;
    const projection = options.projections().find((candidate) => candidate.entryId === entryId);
    if (projection) options.openInspector(projection);
  }

  function releaseCorrection(): void {
    correctionRequest.value = null;
  }

  watch(options.roomIdentifier, releaseCorrection);
  onScopeDispose(releaseCorrection);

  return {
    correctionRequest,
    correctableAgents,
    openCorrectionOrInspector,
    releaseCorrection,
  };
}
