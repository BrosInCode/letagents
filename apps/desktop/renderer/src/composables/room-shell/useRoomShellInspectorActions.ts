import { roomAgentRecoveryAction } from "../../domain/room-agent-delivery";
import { nextTick } from "vue";
import type { DesktopSupervisorManifestEntry } from "../../../../electron/ipc-types";
import { roomMentionCandidates } from "../../domain/participants";
import { agentInspectorActionErrorMessage, actionProgressMessage, actionSuccessMessage } from "../../domain/agent-inspector-presentation";
import {
  clearAgentInspectorActionStateIfMatching,
  agentInspectorTurnControlActionId,
  agentInspectorTurnControlActionIdIfCurrent,
  agentInspectorRetryableTurnControlInput,
  agentInspectorTurnControlFenceMatches,
  type AgentInspectorTurnControlFence,
  type AgentInspectorActionIntent,
} from "../../domain/agent-inspector";
import { isStaleDaemonGenerationError } from "../../domain/agent-inspector-settings";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** Running an agent inspector action against the supervisor. */
export function useRoomShellInspectorRunActions(context: unknown) {
  const {
    activeTab, agentInspectorActionState, continuationRepairAvailable, deliveryRetryCoordinator,
    props, roomChatView, roomDeliverySkipAvailable, selectedAgentDetailRequestVersion,
    selectedAgentDetailTarget, supervisorGenerationChangedMessage, supervisorStatus,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<
      "useRoomShellAgentProjections"
    | "useRoomShellInspectorActions"
    | "useRoomShellInspectorObservations"
    | "useRoomShellParticipants"
    | "useRoomShellSupervisorActions"
  >;
  function currentAgentInspectorActionIdentity(
    operationId: string,
    intent: AgentInspectorActionIntent,
    requestVersion: number,
  ): boolean {
    return props.room.identifier === intent.roomId
      && selectedAgentDetailRequestVersion.value === requestVersion
      && selectedAgentDetailTarget.value?.kind === "supervised"
      && selectedAgentDetailTarget.value.supervisorEntryId === intent.entryId
      && agentInspectorActionState.value?.operationId === operationId;
  }

  function currentAgentInspectorAction(
    operationId: string,
    intent: AgentInspectorActionIntent,
    requestVersion: number,
    daemonGeneration: number | null,
  ): boolean {
    return currentAgentInspectorActionIdentity(operationId, intent, requestVersion)
      && (daemonGeneration === null || supervisorStatus.value?.generation === daemonGeneration);
  }

  async function runAgentInspectorAction(intent: AgentInspectorActionIntent): Promise<void> {
    // Recovery options is local navigation; only a chosen runtime action may reach IPC.
    if (intent.kind === "recovery_options") return;
    if (agentInspectorActionState.value?.status === "running" && agentInspectorActionState.value.entryId === intent.entryId) return;
    if (intent.roomId !== props.room.identifier) return;
    const projection = app.agentInspectorProjections.value.find((candidate) => candidate.entryId === intent.entryId);
    if (!projection) return;
    if (intent.kind === "recover" && roomAgentRecoveryAction(projection.entry) !== "recover") return;
    const turnControlIntent = intent.kind === "stop_turn" || intent.kind === "steer_turn" || intent.kind === "retry_turn_control" || intent.kind === "resolve_turn_control";
    const actionAvailable = projection.actions.some((action) => action.kind === intent.kind && action.available);
    const turnControlAvailable = projection.resourceFreshness === "fresh" && (intent.kind === "stop_turn"
      ? projection.turnControl?.canStop === true
      : intent.kind === "steer_turn"
        ? projection.turnControl?.canCorrect === true && Boolean(intent.correction?.trim())
        : intent.kind === "retry_turn_control"
          ? projection.turnControl?.canRetry === true
        : intent.kind === "resolve_turn_control"
          ? projection.turnControl?.canResolve === true && Boolean(intent.turnControlResolution)
          : false);
    if (!actionAvailable && (!turnControlIntent || !turnControlAvailable)) return;
    // The handed-over text is now the person's own correction; never refill it.
    if (intent.kind === "steer_turn") app.releaseAgentCorrectionRequest({ restoreComposerText: false });

    if (intent.kind === "mention") {
      const participant = app.roomParticipants.value.find((candidate) =>
        candidate.kind === "agent"
        && candidate.participantKey === `desktop-supervisor-agent:${projection.entryId}`
        && Boolean(projection.agentKey)
        && candidate.agentKey === projection.agentKey);
      const mention = participant
        ? roomMentionCandidates(
            app.roomParticipants.value,
            participant.displayName,
            app.roomParticipants.value.length + 1,
          ).find((candidate) => (
            candidate.kind === "agent"
            && candidate.participantKey === participant.participantKey
          ))
        : null;
      if (!mention || mention.insertText !== projection.mentionInsertText) {
        agentInspectorActionState.value = {
          operationId: globalThis.crypto.randomUUID(),
          entryId: intent.entryId,
          kind: intent.kind,
          status: "error",
          message: "This agent is not currently available in the room mention list.",
        };
        return;
      }
      if (intent.presentation === "compact") app.closeAgentDetail();
      activeTab.value = "chat";
      await nextTick();
      roomChatView.value?.focusComposerWithMention(mention.insertText);
      return;
    }

    const operationId = globalThis.crypto.randomUUID();
    const requestVersion = selectedAgentDetailRequestVersion.value;
    agentInspectorActionState.value = {
      operationId,
      entryId: intent.entryId,
      kind: intent.kind,
      status: "running",
      message: actionProgressMessage(intent.kind),
    };
    let operationDaemonGeneration: number | null = null;
    let turnControlFence: AgentInspectorTurnControlFence | null = null;
    let refreshedDuringOperation = false;
    try {
      let updated: DesktopSupervisorManifestEntry | null = null;
      if (intent.kind === "pause") {
        updated = await app.agentPauseRequests.run(
          intent.entryId,
          () => desktopIpc.supervisor.setDesiredState(intent.entryId, "paused"),
        );
      } else if (intent.kind === "resume") {
        app.agentPauseRequests.clear(intent.entryId);
        updated = await desktopIpc.supervisor.setDesiredState(intent.entryId, "running");
      } else if (intent.kind === "recover") {
        updated = await desktopIpc.supervisor.recoverAgentRuntime({ entryId: intent.entryId });
      } else if (["reconnect_runtime", "restart_runtime", "fresh_runtime"].includes(intent.kind)) {
        const status = await app.refreshSupervisorStatus();
        if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
        if (!status?.capabilities.agentRuntimeRecoveryV2) throw new Error("Update the background service to use runtime recovery controls.");
        const pending = projection.entry.runtimeRecovery;
        const executionGenerationId = pending?.executionGenerationId ?? projection.entry.executionGenerationId;
        const runtimeGenerationId = pending?.runtimeGenerationId ?? projection.entry.runtimeGenerationId;
        if (!executionGenerationId || !runtimeGenerationId) throw new Error("The runtime changed. Refresh checks before recovering it.");
        updated = await desktopIpc.supervisor.recoverAgentRuntime({ entryId: intent.entryId, recovery: {
          mode: intent.kind === "reconnect_runtime" ? "reconnect" : intent.kind === "restart_runtime" ? "resume" : "fresh",
          operationId: pending?.operationId ?? operationId, roomId: intent.roomId, executionGenerationId, runtimeGenerationId,
        } });
      } else if (intent.kind === "retire_agent") {
        const status = await app.refreshSupervisorStatus();
        if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
        if (!status?.capabilities.agentLifecycle || !desktopIpc.supervisor.retireAgent) throw new Error("This supervisor does not support durable retirement.");
        operationDaemonGeneration = status.generation;
        agentInspectorActionState.value = {
          ...agentInspectorActionState.value!,
          daemonGeneration: operationDaemonGeneration,
        };
        const receipt = await desktopIpc.supervisor.retireAgent({
          operationId,
          entryId: intent.entryId,
          daemonGeneration: operationDaemonGeneration,
        });
        if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
        if (receipt.status !== "accepted" || receipt.operationId !== operationId
          || receipt.entryId !== intent.entryId || receipt.daemonGeneration !== operationDaemonGeneration) {
          throw new Error("The supervisor returned an invalid retirement receipt.");
        }
        if (agentInspectorActionState.value?.status !== "running") return;
        agentInspectorActionState.value = {
          ...agentInspectorActionState.value!,
          message: "Retirement accepted. Finishing credential cleanup…",
        };
        return;
      } else if (intent.kind === "reconnect") {
        updated = await desktopIpc.supervisor.reconnectAgent({ entryId: intent.entryId });
      } else if (intent.kind === "stop_turn" || intent.kind === "steer_turn" || intent.kind === "retry_turn_control" || intent.kind === "resolve_turn_control") {
        const entry = projection.entry;
        const control = projection.turnControl;
        const status = await app.refreshSupervisorStatus();
        if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
        if (!status || !control
          || (intent.kind !== "resolve_turn_control" && (!entry.workAttemptId || !entry.executionGenerationId))) {
          throw new Error("The active turn changed. Refresh and try again.");
        }
        operationDaemonGeneration = status.generation;
        if (intent.kind === "resolve_turn_control") {
          if (!control.actionId || !control.workAttemptId || !control.executionGenerationId
            || !intent.turnControlResolution) {
            throw new Error("The uncertain turn-control record changed. Refresh and try again.");
          }
          const latestControl = app.agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.turnControl ?? null;
          if (latestControl?.status !== "uncertain"
            || latestControl.actionId !== control.actionId
            || latestControl.workAttemptId !== control.workAttemptId
            || latestControl.executionGenerationId !== control.executionGenerationId) {
            throw new Error("The uncertain turn-control record changed. Refresh and try again.");
          }
          updated = await desktopIpc.supervisor.resolveTurnControl({
            entryId: entry.id,
            workAttemptId: control.workAttemptId,
            executionGenerationId: control.executionGenerationId,
            actionId: control.actionId,
            resolution: intent.turnControlResolution,
          });
        } else if (intent.kind === "retry_turn_control") {
          const retryInput = agentInspectorRetryableTurnControlInput(entry, control, status.generation);
          if (!retryInput) {
            throw new Error("The retryable turn-control record changed. Refresh and try again.");
          }
          const latestControl = app.agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.turnControl ?? null;
          if (latestControl?.status !== "retryable"
            || latestControl.actionId !== control.actionId
            || latestControl.workAttemptId !== control.workAttemptId
            || latestControl.executionGenerationId !== control.executionGenerationId) {
            throw new Error("The retryable turn-control record changed. Refresh and try again.");
          }
          await desktopIpc.supervisor.controlTurn(retryInput);
        } else {
          const currentWorkAttemptId = entry.workAttemptId;
          const currentExecutionGenerationId = entry.executionGenerationId;
          if (!currentWorkAttemptId || !currentExecutionGenerationId) {
            throw new Error("The active turn changed. Refresh and try again.");
          }
          const exactTurnControlFence: AgentInspectorTurnControlFence = {
            entryId: entry.id,
            roomId: entry.roomId,
            workAttemptId: currentWorkAttemptId,
            executionGenerationId: currentExecutionGenerationId,
            providerTurnId: control.providerTurnId,
            inboxItemId: entry.roomAgentState?.turn.inboxItemId ?? null,
            sourceMessageId: entry.roomAgentState?.turn.sourceMessageId ?? null,
            daemonGeneration: status.generation,
          };
          turnControlFence = exactTurnControlFence;
          if (!entry.providerContinuationId || !exactTurnControlFence.providerTurnId
            || !exactTurnControlFence.inboxItemId || !exactTurnControlFence.sourceMessageId) {
            throw new Error("The exact room turn is no longer available. Refresh and try again.");
          }
          const currentEntry = app.agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.entry ?? null;
          if (!agentInspectorTurnControlFenceMatches(exactTurnControlFence, currentEntry, supervisorStatus.value?.generation ?? null)) {
            throw new Error("The active turn changed. Refresh and try again.");
          }
          const correction = intent.kind === "steer_turn" ? intent.correction?.trim() || null : null;
          if (intent.kind === "steer_turn" && !correction) throw new Error("Write a correction before applying it.");
          const actionId = await agentInspectorTurnControlActionIdIfCurrent(
              agentInspectorTurnControlActionId({
                entryId: entry.id,
                roomId: entry.roomId,
                workAttemptId: currentWorkAttemptId,
                executionGenerationId: currentExecutionGenerationId,
                actionSequence: entry.lastTurnControlSequence + 1,
                providerTurnId: control.providerTurnId,
                inboxItemId: entry.roomAgentState?.turn.inboxItemId ?? null,
                sourceMessageId: entry.roomAgentState?.turn.sourceMessageId ?? null,
                correction,
              }),
              () => {
                // A supervisor push can arrive while the digest yields. Re-read
                // the projected entry rather than trusting the pre-digest object.
                const currentEntryAfterDigest = app.agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.entry ?? null;
                return currentAgentInspectorAction(operationId, intent, requestVersion, operationDaemonGeneration)
                  && agentInspectorTurnControlFenceMatches(exactTurnControlFence, currentEntryAfterDigest, supervisorStatus.value?.generation ?? null);
              },
          );
          if (!actionId) {
            // The post-digest fence rejected this operation. Clear only this
            // matching action so controls recover, never a newer user action.
            if (currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) {
              agentInspectorActionState.value = clearAgentInspectorActionStateIfMatching(agentInspectorActionState.value, operationId);
            }
            return;
          }
          await desktopIpc.supervisor.controlTurn({
            entryId: entry.id,
            daemonGeneration: exactTurnControlFence.daemonGeneration,
            roomId: exactTurnControlFence.roomId,
            workAttemptId: currentWorkAttemptId,
            executionGenerationId: currentExecutionGenerationId,
            providerContinuationId: entry.providerContinuationId,
            providerTurnId: exactTurnControlFence.providerTurnId,
            inboxItemId: exactTurnControlFence.inboxItemId,
            sourceMessageId: exactTurnControlFence.sourceMessageId,
            actionId,
            actionSequence: entry.lastTurnControlSequence + 1,
            correction,
          });
        }
      } else if (intent.kind === "retry_delivery") {
        const entry = projection.entry;
        if (!intent.sourceMessageId || !entry.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) {
          throw new Error("The delivery binding changed. Refresh and try again.");
        }
        const sourceMessageId = intent.sourceMessageId;
        const workAttemptId = entry.workAttemptId;
        const executionGenerationId = entry.executionGenerationId;
        const agentSessionId = entry.agentSessionId;
        const retryResult = await deliveryRetryCoordinator.run({
          agentId: entry.id,
          sourceMessageId,
        }, async () => {
          await desktopIpc.supervisor.retryRoomDelivery({
            entryId: entry.id,
            roomId: intent.roomId,
            sourceMessageId,
            workAttemptId,
            executionGenerationId,
            agentSessionId,
          });
          await app.refreshSupervisorEntries();
          refreshedDuringOperation = true;
        });
        if (!retryResult.started) {
          if (currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) {
            agentInspectorActionState.value = clearAgentInspectorActionStateIfMatching(
              agentInspectorActionState.value,
              operationId,
            );
          }
          return;
        }
        if (!retryResult.ok) throw retryResult.error;
      } else if (intent.kind === "restore_conversation" || intent.kind === "skip_message") {
        const entry = projection.entry;
        if (!intent.sourceMessageId || !entry.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) {
          throw new Error("The delivery binding changed. Refresh and try again.");
        }
        const input = {
          entryId: entry.id,
          roomId: intent.roomId,
          sourceMessageId: intent.sourceMessageId,
          workAttemptId: entry.workAttemptId,
          executionGenerationId: entry.executionGenerationId,
          agentSessionId: entry.agentSessionId,
        };
        if (intent.kind === "restore_conversation") {
          if (!continuationRepairAvailable.value) throw new Error("Conversation restoration is not available.");
          await desktopIpc.supervisor.restoreAgentConversation(input);
        } else {
          if (!roomDeliverySkipAvailable.value) throw new Error("Safe message skipping is not available.");
          await desktopIpc.supervisor.skipRoomDelivery(input);
        }
      }
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      const currentEntry = app.agentInspectorProjections.value.find((candidate) => candidate.entryId === intent.entryId)?.entry ?? null;
      if (!currentAgentInspectorAction(operationId, intent, requestVersion, operationDaemonGeneration)
        || (turnControlFence && !agentInspectorTurnControlFenceMatches(turnControlFence, currentEntry, supervisorStatus.value?.generation ?? null))) {
        // The request may have completed, but it no longer describes the exact
        // selected room/entry/generation/turn. Do not attach its outcome to the
        // Inspector; a fresh supervisor push owns the visible truth instead.
        if (currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) {
          agentInspectorActionState.value = null;
        }
        return;
      }
      if (updated) {
        app.upsertSupervisorEntry({
          entry: updated,
          roomIdentifier: intent.roomId,
          inspectorRequestVersion: requestVersion,
        });
      } else if (!refreshedDuringOperation) {
        await app.refreshSupervisorEntries();
      }
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      agentInspectorActionState.value = {
        operationId,
        entryId: intent.entryId,
        kind: intent.kind,
        status: "success",
        message: actionSuccessMessage(intent.kind),
      };
    } catch (error) {
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (intent.kind === "reconnect" || intent.kind === "reconnect_runtime") {
        // A failed credential reconnect may reveal a stopped runtime. Read the
        // existing fenced diagnostics so Overview offers the correct recovery.
        await app.refreshAgentInspectorDiagnostics().catch(() => false);
        if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      }
      const refreshed = intent.kind === "retire_agent" ? await app.refreshSupervisorStatus() : supervisorStatus.value;
      agentInspectorActionState.value = {
        operationId,
        entryId: intent.entryId,
        kind: intent.kind,
        status: "error",
        message: intent.kind === "retire_agent"
          && (isStaleDaemonGenerationError(error) || (operationDaemonGeneration !== null && refreshed?.generation !== operationDaemonGeneration))
          ? supervisorGenerationChangedMessage
          : agentInspectorActionErrorMessage(intent.kind, error),
      };
    }
  }
  return {
    currentAgentInspectorActionIdentity, currentAgentInspectorAction, runAgentInspectorAction,
  };
}
