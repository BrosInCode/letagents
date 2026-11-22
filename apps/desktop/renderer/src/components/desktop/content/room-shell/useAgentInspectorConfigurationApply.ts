import { onScopeDispose, type Ref } from "vue";
import type { DesktopSupervisorAgentConfiguration } from "../../../../../../electron/ipc-types";
import type { AgentInspectorActionState } from "../../../../domain/agent-inspector";
import {
  configurationHasRuntimeLag,
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
  onApplied?(configuration: DesktopSupervisorAgentConfiguration): void;
}) {
  let restartCheck: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onScopeDispose(() => { disposed = true; clearTimeout(restartCheck); });

  function checkRestart(operation: Operation, expectedRevision: number, until = Date.now() + 45_000): void {
    const read = desktopIpc.supervisor?.getAgentConfiguration;
    if (disposed || !read) return;
    clearTimeout(restartCheck);
    restartCheck = setTimeout(async () => {
      if (disposed || !options.operationIdentityCurrent(operation)) return;
      const configuration = await read({ entryId: operation.entryId, daemonGeneration: operation.daemonGeneration }).catch(() => null);
      if (disposed || !options.operationIdentityCurrent(operation)) return;
      if (configuration?.entryId === operation.entryId && configuration.daemonGeneration === operation.daemonGeneration
        && configuration.configRevision === expectedRevision && !configurationHasRuntimeLag(configuration)
        && options.operationCurrent(operation)) {
        options.configurationResource.value = { ...options.configurationResource.value, configuration };
        options.actionState.value = { ...options.actionState.value!, message: "The agent is using your saved settings." };
        options.onApplied?.(configuration);
        return;
      }
      if (Date.now() < until && options.operationCurrent(operation)) {
        checkRestart(operation, expectedRevision, until);
        return;
      }
      options.actionState.value = {
        ...options.actionState.value!, status: "error",
        message: "The new settings haven’t been confirmed yet. Check Live or reload Settings.",
      };
    }, 1_500);
  }

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
          message: "The agent is already using your saved settings.",
        };
        const confirmed = options.configurationResource.value.configuration;
        if (confirmed?.entryId === operation.entryId && confirmed.daemonGeneration === operation.daemonGeneration
          && confirmed.configRevision === snapshot.expectedConfigurationRevision && !configurationHasRuntimeLag(confirmed)) {
          options.onApplied?.(confirmed);
        }
        return;
      }
      const message = result.outcome === "restarting"
        ? "Restarting with your saved settings…"
        : result.outcome === "busy_active_turn"
          ? "This agent is working. Wait for it to finish, then restart it to apply your settings."
          : result.outcome === "unsupported"
            ? "This agent cannot restart to apply settings from here."
            : "The agent or its settings changed. Reload Settings, then try again.";
      options.actionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "apply_settings",
        status: result.outcome === "restarting" ? "success" : "error",
        message,
      };
      if (result.outcome === "restarting") checkRestart(operation, snapshot.expectedConfigurationRevision);
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
        message: error instanceof Error ? error.message : "Could not apply your saved settings.",
      };
    }
  }

  return { applyAgentInspectorSettings };
}
