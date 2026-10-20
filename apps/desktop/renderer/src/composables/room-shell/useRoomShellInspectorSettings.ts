import type { DesktopSupervisorRoomMove } from "../../../../electron/ipc-types";
import type { AgentInspectorActionState } from "../../domain/agent-inspector";
import {
  agentInspectorSettingsFenceCurrent,
  configurationDraft,
  isStaleDaemonGenerationError,
  recoveredRoomMoveState,
  settleConfigurationConflict,
  settleConfigurationUpdate,
  snapshotConfigurationSave,
  type AgentInspectorConfigurationDraft,
  type AgentInspectorSettingsFence,
} from "../../domain/agent-inspector-settings";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** The agent inspector's settings and room move: load, save, recovery, retirement, and purge. */
export function useRoomShellInspectorSettings(context: unknown) {
  const {
    agentInspectorActionState, agentInspectorConfigurationResource, agentInspectorProviders,
    agentInspectorRequestState, agentInspectorRoomMoveResource, agentInspectorSettingsConflict,
    props, selectedAgentDetailRequestVersion, selectedAgentDetailTarget,
    supervisorGenerationChangedMessage, supervisorSettingsGenerationChangedMessage,
    supervisorStatus,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<
      "useRoomShellAgentProjections"
    | "useRoomShellInspectorActions"
    | "useRoomShellSupervisorActions"
    | "pending"
  >;
  let agentInspectorSettingsDraftVersion = 0;

  function resetAgentInspectorSettings(): void {
    agentInspectorRequestState.agentInspectorSettingsRequestToken += 1;
    agentInspectorSettingsDraftVersion = 0;
    agentInspectorRequestState.agentInspectorRoomMoveRequestToken += 1;
    if (agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer);
    agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = null;
    agentInspectorConfigurationResource.value = { status: "idle", configuration: null, draft: null, error: null };
    agentInspectorRoomMoveResource.value = { status: "idle", move: null, error: null };
    agentInspectorProviders.value = [];
    agentInspectorSettingsConflict.value = false;
  }

  function agentInspectorSettingsSelectionCurrent(entryId: string, roomId: string): boolean {
    return props.room.identifier === roomId
      && selectedAgentDetailTarget.value?.kind === "supervised"
      && selectedAgentDetailTarget.value.supervisorEntryId === entryId;
  }

  function agentInspectorSettingsCurrent(fence: AgentInspectorSettingsFence): boolean {
    return agentInspectorSettingsFenceCurrent(fence, {
      entryId: selectedAgentDetailTarget.value?.kind === "supervised"
        ? selectedAgentDetailTarget.value.supervisorEntryId
        : null,
      roomId: props.room.identifier,
      daemonGeneration: supervisorStatus.value?.generation ?? null,
      requestToken: agentInspectorRequestState.agentInspectorSettingsRequestToken,
    });
  }

  function agentInspectorActionRunning(): boolean {
    return agentInspectorActionState.value?.status === "running";
  }

  async function loadAgentInspectorSettings(force = false, retryOnStaleGeneration = true): Promise<void> {
    if (agentInspectorActionRunning()) return;
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection || !desktopIpc.supervisor?.getAgentConfiguration) {
      agentInspectorConfigurationResource.value = { status: "unavailable", configuration: null, draft: null, error: "Inspector settings require a current desktop supervisor." };
      return;
    }
    if (!force && agentInspectorConfigurationResource.value.status === "ready") return;
    const status = await app.refreshSupervisorStatus();
    if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
    if (agentInspectorActionRunning()) return;
    if (!status) {
      agentInspectorConfigurationResource.value = {
        status: "error",
        configuration: null,
        draft: null,
        error: "Background agent management is unavailable. Retry when it reconnects.",
      };
      return;
    }
    if (!status.capabilities.agentInspectorSettings) {
      agentInspectorConfigurationResource.value = { status: "unavailable", configuration: null, draft: null, error: "Inspector settings require a current desktop supervisor." };
      return;
    }
    const token = ++agentInspectorRequestState.agentInspectorSettingsRequestToken;
    const fence: AgentInspectorSettingsFence = {
      entryId: projection.entryId,
      roomId: projection.roomId,
      daemonGeneration: status.generation,
      requestToken: token,
    };
    const previous = agentInspectorConfigurationResource.value;
    agentInspectorConfigurationResource.value = { ...previous, status: previous.configuration ? "refreshing" : "loading", error: null };
    try {
      const [configuration, providers] = await Promise.all([
        desktopIpc.supervisor.getAgentConfiguration({ entryId: projection.entryId, daemonGeneration: status.generation }),
        desktopIpc.workers.listAgentProviders(),
      ]);
      if (!agentInspectorSettingsCurrent(fence)) return;
      agentInspectorProviders.value = providers;
      agentInspectorConfigurationResource.value = { status: "ready", configuration, draft: configurationDraft(configuration), error: null };
      agentInspectorSettingsDraftVersion += 1;
      agentInspectorSettingsConflict.value = false;
    } catch (error) {
      if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId) || token !== agentInspectorRequestState.agentInspectorSettingsRequestToken) return;
      if (retryOnStaleGeneration && isStaleDaemonGenerationError(error)) {
        const refreshed = await app.refreshSupervisorStatus();
        if (refreshed && refreshed.generation !== fence.daemonGeneration && agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) {
          await loadAgentInspectorSettings(true, false);
          return;
        }
      }
      agentInspectorConfigurationResource.value = {
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : "Could not load saved configuration.",
      };
    }
  }

  async function reloadAgentInspectorSettings(): Promise<void> {
    const action = agentInspectorActionState.value;
    if (action?.kind === "apply_settings" && action.status === "success"
      && app.selectedAgentDetailProjection.value?.entryId === action.entryId) {
      agentInspectorActionState.value = null;
    }
    await loadAgentInspectorSettings(true);
  }

  function openAgentInspectorSettings(): void {
    void loadAgentInspectorSettings();
    void loadAgentInspectorRoomMove();
  }

  function agentInspectorRoomMoveCurrent(fence: AgentInspectorSettingsFence): boolean {
    return agentInspectorSettingsFenceCurrent(fence, {
      entryId: selectedAgentDetailTarget.value?.kind === "supervised"
        ? selectedAgentDetailTarget.value.supervisorEntryId
        : null,
      roomId: props.room.identifier,
      daemonGeneration: supervisorStatus.value?.generation ?? null,
      requestToken: agentInspectorRequestState.agentInspectorRoomMoveRequestToken,
    });
  }

  async function applyDiscoveredAgentInspectorRoomMove(move: DesktopSupervisorRoomMove | null): Promise<void> {
    const recovered = recoveredRoomMoveState(move);
    agentInspectorRoomMoveResource.value = recovered.resource;
    if (recovered.refreshAgents) await app.refreshSupervisorEntries();
    if (recovered.shouldPoll) scheduleAgentInspectorMoveRecovery();
  }

  async function loadAgentInspectorRoomMove(retryOnStaleGeneration = true): Promise<void> {
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    const status = await app.refreshSupervisorStatus();
    if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
    if (!status?.capabilities.agentRoomMove) {
      agentInspectorRoomMoveResource.value = {
        status: "unavailable",
        move: null,
        error: "Durable room-move discovery requires supervisor implementation 2.0.48 or newer.",
      };
      return;
    }
    const requestToken = ++agentInspectorRequestState.agentInspectorRoomMoveRequestToken;
    const fence: AgentInspectorSettingsFence = {
      entryId: projection.entryId,
      roomId: projection.roomId,
      daemonGeneration: status.generation,
      requestToken,
    };
    agentInspectorRoomMoveResource.value = {
      ...agentInspectorRoomMoveResource.value,
      status: agentInspectorRoomMoveResource.value.move ? "recovering" : "loading",
      error: null,
    };
    try {
      const move = await desktopIpc.supervisor.getCurrentRoomMove({
        entryId: projection.entryId,
        daemonGeneration: status.generation,
      });
      if (!agentInspectorRoomMoveCurrent(fence)) return;
      await applyDiscoveredAgentInspectorRoomMove(move);
    } catch (error) {
      if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId) || requestToken !== agentInspectorRequestState.agentInspectorRoomMoveRequestToken) return;
      if (retryOnStaleGeneration && isStaleDaemonGenerationError(error)) {
        const refreshed = await app.refreshSupervisorStatus();
        if (refreshed && refreshed.generation !== fence.daemonGeneration) {
          await loadAgentInspectorRoomMove(false);
          return;
        }
      }
      agentInspectorRoomMoveResource.value = {
        ...agentInspectorRoomMoveResource.value,
        status: "error",
        error: error instanceof Error ? error.message : "Could not discover the current room move.",
      };
    }
  }

  function scheduleAgentInspectorMoveRecovery(): void {
    if (agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer);
    agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = window.setTimeout(() => {
      agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = null;
      void loadAgentInspectorRoomMove();
    }, 1_200);
  }

  function patchAgentInspectorSettings(patch: Partial<AgentInspectorConfigurationDraft>): void {
    const current = agentInspectorConfigurationResource.value;
    if (current.status !== "ready" || !current.draft || agentInspectorActionState.value?.status === "running") return;
    agentInspectorSettingsDraftVersion += 1;
    agentInspectorConfigurationResource.value = { ...current, draft: { ...current.draft, ...patch } };
  }

  interface AgentInspectorOperationFence {
    operationId: string;
    entryId: string;
    roomId: string;
    requestVersion: number;
    daemonGeneration: number;
    kind: AgentInspectorActionState["kind"];
  }

  function beginAgentInspectorOperation(kind: AgentInspectorActionState["kind"], message: string, daemonGeneration: number): AgentInspectorOperationFence | null {
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection || agentInspectorActionState.value?.status === "running") return null;
    const operationId = globalThis.crypto.randomUUID();
    const requestVersion = selectedAgentDetailRequestVersion.value;
    agentInspectorActionState.value = { operationId, entryId: projection.entryId, kind, status: "running", message };
    return { operationId, entryId: projection.entryId, roomId: projection.roomId, requestVersion, daemonGeneration, kind };
  }

  function agentInspectorOperationIdentityCurrent(operation: AgentInspectorOperationFence): boolean {
    return props.room.identifier === operation.roomId && selectedAgentDetailRequestVersion.value === operation.requestVersion
      && selectedAgentDetailTarget.value?.kind === "supervised" && selectedAgentDetailTarget.value.supervisorEntryId === operation.entryId
      && agentInspectorActionState.value?.operationId === operation.operationId;
  }

  function agentInspectorOperationCurrent(operation: AgentInspectorOperationFence): boolean {
    return agentInspectorOperationIdentityCurrent(operation)
      && supervisorStatus.value?.generation === operation.daemonGeneration;
  }

  async function recoverAgentInspectorSettingsGeneration(
    operation: AgentInspectorOperationFence,
    preservedDraft: AgentInspectorConfigurationDraft,
  ): Promise<void> {
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    agentInspectorActionState.value = {
      operationId: operation.operationId,
      entryId: operation.entryId,
      kind: operation.kind,
      status: "error",
      message: supervisorSettingsGenerationChangedMessage,
    };
    const status = await app.refreshSupervisorStatus();
    if (!status || !agentInspectorOperationIdentityCurrent(operation) || !desktopIpc.supervisor?.getAgentConfiguration) return;
    const token = ++agentInspectorRequestState.agentInspectorSettingsRequestToken;
    const fence: AgentInspectorSettingsFence = {
      entryId: operation.entryId,
      roomId: operation.roomId,
      daemonGeneration: status.generation,
      requestToken: token,
    };
    try {
      const [configuration, providers] = await Promise.all([
        desktopIpc.supervisor.getAgentConfiguration({ entryId: operation.entryId, daemonGeneration: status.generation }),
        desktopIpc.workers.listAgentProviders(),
      ]);
      if (!agentInspectorSettingsCurrent(fence) || !agentInspectorOperationIdentityCurrent(operation)) return;
      agentInspectorProviders.value = providers;
      agentInspectorConfigurationResource.value = { status: "ready", configuration, draft: preservedDraft, error: null };
      agentInspectorSettingsDraftVersion += 1;
      agentInspectorSettingsConflict.value = true;
    } catch (error) {
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      agentInspectorConfigurationResource.value = {
        ...agentInspectorConfigurationResource.value,
        status: "error",
        draft: preservedDraft,
        error: error instanceof Error ? error.message : "Could not refresh configuration after the supervisor restarted.",
      };
    }
  }

  async function saveAgentInspectorSettings(overwrite: boolean): Promise<void> {
    if (!desktopIpc.supervisor?.updateAgentConfiguration) return;
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    const status = await app.refreshSupervisorStatus();
    if (!status || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
    if (agentInspectorConfigurationResource.value.status !== "ready") return;
    const snapshot = snapshotConfigurationSave(
      agentInspectorConfigurationResource.value,
      agentInspectorSettingsDraftVersion,
      status.generation,
    );
    if (!snapshot) {
      const draft = agentInspectorConfigurationResource.value.draft;
      if (draft) {
        const operation = beginAgentInspectorOperation("save_settings", "Refreshing configuration after supervisor restart…", status.generation);
        if (operation) await recoverAgentInspectorSettingsGeneration(operation, draft);
      }
      return;
    }
    const operation = beginAgentInspectorOperation("save_settings", overwrite ? "Overwriting saved configuration…" : "Saving settings…", status.generation);
    if (!operation) return;
    agentInspectorRequestState.agentInspectorSettingsRequestToken += 1;
    try {
      const result = await desktopIpc.supervisor.updateAgentConfiguration({
        entryId: operation.entryId,
        daemonGeneration: snapshot.daemonGeneration,
        expectedRevision: snapshot.expectedRevision,
        configuration: snapshot.draft,
      });
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      if (!agentInspectorOperationCurrent(operation)) {
        await recoverAgentInspectorSettingsGeneration(operation, snapshot.draft);
        return;
      }
      if (result.outcome === "conflict") {
        agentInspectorConfigurationResource.value = settleConfigurationConflict(
          agentInspectorConfigurationResource.value,
          snapshot,
          result.configuration,
        );
        agentInspectorSettingsConflict.value = true;
        agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "save_settings", status: "error", message: "Saved configuration changed elsewhere. Your draft is preserved." };
        return;
      }
      if (result.outcome === "invalid") throw new Error(result.error);
      const settled = settleConfigurationUpdate(
        agentInspectorConfigurationResource.value,
        agentInspectorSettingsDraftVersion,
        snapshot,
        result.configuration,
      );
      agentInspectorConfigurationResource.value = settled.resource;
      agentInspectorSettingsDraftVersion = settled.draftVersion;
      agentInspectorSettingsConflict.value = false;
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "save_settings", status: "success", message: "Settings saved." };
    } catch (error) {
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      const refreshed = await app.refreshSupervisorStatus();
      if (isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration) {
        await recoverAgentInspectorSettingsGeneration(operation, snapshot.draft);
        return;
      }
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "save_settings", status: "error", message: error instanceof Error ? error.message : "Configuration could not be saved." };
    }
  }

  async function prepareAgentInspectorRoomMove(destinationRoomId: string): Promise<void> {
    if (!destinationRoomId.trim()) return;
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    const status = await app.refreshSupervisorStatus();
    if (!status?.capabilities.agentRoomMove || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
    const operation = beginAgentInspectorOperation("move_room", "Preparing durable room move…", status.generation);
    if (!operation) return;
    agentInspectorRequestState.agentInspectorRoomMoveRequestToken += 1;
    if (agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer);
    agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = null;
    agentInspectorRoomMoveResource.value = { status: "preparing", move: null, error: null };
    try {
      const move = await desktopIpc.supervisor.prepareRoomMove({
        entryId: operation.entryId,
        destinationRoomId,
        requestId: globalThis.crypto.randomUUID(),
        daemonGeneration: operation.daemonGeneration,
      });
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      if (!agentInspectorOperationCurrent(operation)) {
        agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "move_room", status: "error", message: supervisorGenerationChangedMessage };
        await loadAgentInspectorRoomMove();
        return;
      }
      agentInspectorRoomMoveResource.value = { status: "idle", move, error: null };
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "move_room", status: "success", message: "Move prepared. Continue when ready." };
    } catch (error) {
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      const refreshed = await app.refreshSupervisorStatus();
      const stale = isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration;
      agentInspectorActionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "move_room",
        status: "error",
        message: stale ? supervisorGenerationChangedMessage : error instanceof Error ? error.message : "Room move could not be prepared.",
      };
      if (stale) await loadAgentInspectorRoomMove();
      else agentInspectorRoomMoveResource.value = { status: "error", move: null, error: agentInspectorActionState.value.message };
    }
  }

  async function commitAgentInspectorRoomMove(): Promise<void> {
    const currentMove = agentInspectorRoomMoveResource.value.move;
    if (!currentMove) return;
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    const status = await app.refreshSupervisorStatus();
    if (!status?.capabilities.agentRoomMove || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
    const operation = beginAgentInspectorOperation("move_room", "Continuing durable room move…", status.generation);
    if (!operation) return;
    agentInspectorRequestState.agentInspectorRoomMoveRequestToken += 1;
    agentInspectorRoomMoveResource.value = { status: "committing", move: currentMove, error: null };
    try {
      const move = await desktopIpc.supervisor.commitRoomMove({
        operationId: currentMove.operationId,
        entryId: operation.entryId,
        daemonGeneration: operation.daemonGeneration,
      });
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      if (!agentInspectorOperationCurrent(operation)) {
        agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "move_room", status: "error", message: supervisorGenerationChangedMessage };
        await loadAgentInspectorRoomMove();
        return;
      }
      agentInspectorActionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "move_room",
        status: "success",
        message: move.phase === "active" ? "Room move completed." : "Room move is continuing in the daemon.",
      };
      await applyDiscoveredAgentInspectorRoomMove(move);
    } catch (error) {
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      const refreshed = await app.refreshSupervisorStatus();
      const stale = isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration;
      agentInspectorActionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "move_room",
        status: "error",
        message: stale ? supervisorGenerationChangedMessage : error instanceof Error ? error.message : "Room move could not continue.",
      };
      if (stale) await loadAgentInspectorRoomMove();
      else agentInspectorRoomMoveResource.value = { status: "error", move: currentMove, error: agentInspectorActionState.value.message };
    }
  }

  async function retireAgentInspectorAgent(): Promise<void> {
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    await app.runAgentInspectorAction({
      entryId: projection.entryId,
      roomId: projection.roomId,
      kind: "retire_agent",
    });
  }

  async function purgeAgentInspectorAgent(): Promise<void> {
    if (!desktopIpc.supervisor?.purgeAgent) return;
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    const status = await app.refreshSupervisorStatus();
    if (!status || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
    const operation = beginAgentInspectorOperation("purge_agent", "Removing access, history, and settings…", status.generation);
    if (!operation) return;
    try {
      const result = await desktopIpc.supervisor.purgeAgent({ entryId: operation.entryId, daemonGeneration: operation.daemonGeneration });
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      if (!agentInspectorOperationCurrent(operation)) {
        agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "purge_agent", status: "error", message: supervisorGenerationChangedMessage };
        return;
      }
      if (result.outcome !== "purged") throw new Error(result.error || "Purge could not be completed.");
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "purge_agent", status: "success", message: "Durable agent records purged. The worktree was preserved." };
      await app.refreshSupervisorEntries();
      if (agentInspectorOperationIdentityCurrent(operation)) app.closeAgentDetail();
    } catch (error) {
      if (!agentInspectorOperationIdentityCurrent(operation)) return;
      const refreshed = await app.refreshSupervisorStatus();
      agentInspectorActionState.value = {
        operationId: operation.operationId,
        entryId: operation.entryId,
        kind: "purge_agent",
        status: "error",
        message: isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration
          ? supervisorGenerationChangedMessage
          : error instanceof Error ? error.message : "Purge could not be completed.",
      };
    }
  }
  return {
    resetAgentInspectorSettings, agentInspectorSettingsSelectionCurrent,
    agentInspectorSettingsCurrent, agentInspectorActionRunning, loadAgentInspectorSettings,
    reloadAgentInspectorSettings, openAgentInspectorSettings, agentInspectorRoomMoveCurrent,
    applyDiscoveredAgentInspectorRoomMove, loadAgentInspectorRoomMove,
    scheduleAgentInspectorMoveRecovery, patchAgentInspectorSettings, beginAgentInspectorOperation,
    agentInspectorOperationIdentityCurrent, agentInspectorOperationCurrent,
    recoverAgentInspectorSettingsGeneration, saveAgentInspectorSettings,
    prepareAgentInspectorRoomMove, commitAgentInspectorRoomMove, retireAgentInspectorAgent,
    purgeAgentInspectorAgent,
  };
}
