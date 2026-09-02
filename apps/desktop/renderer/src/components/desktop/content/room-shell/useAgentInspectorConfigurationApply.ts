import type { Ref } from "vue";
import type { AgentInspectorActionState } from "../../../../domain/agent-inspector";
import {
  isStaleDaemonGenerationError,
  settleConfigurationAlreadyApplied,
  snapshotConfigurationApply,
  type AgentInspectorConfigurationDraft,
  type AgentInspectorConfigurationResource,
} from "../../../../domain/agent-inspector-settings";
import { desktopIpc } from "../../../../ipc/index.js";

interface ConfigurationApplyProjection {
  entryId: string;
  roomId: string;
}

interface ConfigurationApplyOperation {
  operationId: string;
  entryId: string;
  daemonGeneration: number;
}

export function useAgentInspectorConfigurationApply<Operation extends ConfigurationApplyOperation>(options: {
  selectedProjection: Readonly<Ref<ConfigurationApplyProjection | null>>;
  configurationResource: Ref<AgentInspectorConfigurationResource>;
  actionState: Ref<AgentInspectorActionState | null>;
  refreshSupervisorStatus(): Promise<{ generation: number } | null>;
  selectionCurrent(entryId: string, roomId: string): boolean;
  beginOperation(message: string, daemonGeneration: number): Operation | null;
  operationIdentityCurrent(operation: Operation): boolean;
  operationCurrent(operation: Operation): boolean;
  recoverGeneration(operation: Operation, draft: AgentInspectorConfigurationDraft): Promise<void>;
}) {
  async function applyAgentInspectorSettings(): Promise<void> {
    if (!desktopIpc.supervisor?.applyAgentConfiguration) return;
    const projection = options.selectedProjection.value;
    if (!projection) return;
    const status = await options.refreshSupervisorStatus();
    if (!status || !options.selectionCurrent(projection.entryId, projection.roomId)) return;
    const snapshot = snapshotConfigurationApply(options.configurationResource.value, projection.entryId);
    if (!snapshot) return;
    if (snapshot.daemonGeneration !== status.generation) {
      const operation = options.beginOperation("Refreshing configuration after supervisor restart…", status.generation);
      if (operation) await options.recoverGeneration(operation, snapshot.preservedDraft);
      return;
    }
    const operation = options.beginOperation("Restarting the idle agent with its saved configuration…", status.generation);
    if (!operation) return;
    try {
      const result = await desktopIpc.supervisor.applyAgentConfiguration({
        entryId: snapshot.entryId,
        daemonGeneration: snapshot.daemonGeneration,
        expectedConfigurationRevision: snapshot.expectedConfigurationRevision,
      });
      if (!options.operationIdentityCurrent(operation)) return;
      if (!options.operationCurrent(operation)) {
        await options.recoverGeneration(operation, snapshot.preservedDraft);
        return;
      }
      if (result.outcome === "already_applied") {
        options.configurationResource.value = settleConfigurationAlreadyApplied(
          options.configurationResource.value,
          snapshot.expectedConfigurationRevision,
        );
        options.actionState.value = {
          operationId: operation.operationId,
          entryId: operation.entryId,
          kind: "apply_settings",
          status: "success",
          message: "The saved configuration is already active.",
        };
        return;
      }
      const message = result.outcome === "restarting"
        ? "Restart started. Reload after the agent is ready to confirm the saved revision."
        : result.outcome === "busy_active_turn"
          ? "This agent is working. Apply the saved revision after its current turn finishes."
          : result.outcome === "unsupported"
            ? "This agent cannot apply saved configuration in place."
            : "The saved configuration or runtime changed. Reload Settings, then try again.";
      options.actionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "apply_settings",
        status: result.outcome === "restarting" ? "success" : "error",
        message,
      };
    } catch (error) {
      if (!options.operationIdentityCurrent(operation)) return;
      const refreshed = await options.refreshSupervisorStatus();
      if (isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration) {
        await options.recoverGeneration(operation, snapshot.preservedDraft);
        return;
      }
      options.actionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "apply_settings",
        status: "error",
        message: error instanceof Error ? error.message : "The saved configuration could not be applied.",
      };
    }
  }

  return { applyAgentInspectorSettings };
}
