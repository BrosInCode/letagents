import type { IpcMain } from "electron";
import { randomUUID } from "node:crypto";

import type {
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
} from "../../ipc-types.js";
import { listDesktopManagedAgentSessions, stopDesktopManagedAgent } from "../agents/codex-supervisor.js";
import { assertManagedAgentPermissionProfileAvailable } from "../agents/managed-agent-permission-profiles.js";
import { removeCursorSupervisedProfile } from "../agents/cursor-managed-profile.js";
import { redactCredentialText } from "../agents/provider-evidence.js";
import {
  classifyLaunchFailure,
  emitLaunchEvent,
  getLaunchEvents,
  LaunchBlockedError,
  onLaunchEvent,
  supervisedLaunchEverReady,
} from "../launch-events.js";
import { refreshInstalledLetAgentsMcpServerAuth } from "../mcp-setup.js";
import { getDesktopRoomStorage } from "../rooms.js";
import {
  desktopSmokeControlTurn,
  desktopSmokeSupervisorEntries,
  isDesktopSmokeCheck,
} from "../smoke.js";
import {
  onSupervisorActivity,
  onSupervisorAgentStream,
  onSupervisorState,
  setFocusedAgentStream,
  supervisorDaemonClient,
} from "../supervisor-daemon.js";
import {
  readDesktopSupervisorGrantAgentKeysForEntries,
} from "../supervisor-grant.js";
import { supervisorGrantCoordinator } from "../supervisor-grant-coordinator.js";
import { transferSupervisorOwnership } from "../supervisor-ownership.js";
import { assertDesktopUpdateMutationAllowed } from "../updates.js";
import { emitToMainWindow } from "../window.js";

let supervisorActivityBridgeRegistered = false;
let supervisorStateBridgeRegistered = false;
let supervisorLaunchBridgeRegistered = false;
let supervisorAgentStreamBridgeRegistered = false;

/** A launch id shared by the durable entry (`supervised_<id>`) and every launch
 * fact. Must satisfy the daemon's creation-request-id shape; fall back to a
 * fresh id when the renderer did not supply a usable one. */
function normalizeLaunchId(creationRequestId?: string | null): string {
  const candidate = creationRequestId?.trim();
  if (candidate && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

export function registerDesktopSupervisorIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle(
    "desktop:supervisor:get-status",
    async (): Promise<DesktopSupervisorDaemonStatus> => supervisorDaemonClient.ensureRunning(),
  );
  targetIpcMain.handle(
    "desktop:supervisor:list-agents",
    async (_event, roomIdentifier?: string | null): Promise<DesktopSupervisorManifestEntry[]> => {
      const entries = isDesktopSmokeCheck()
        ? desktopSmokeSupervisorEntries().filter((entry) => !roomIdentifier || entry.roomId === roomIdentifier)
        : await supervisorDaemonClient.list(roomIdentifier ?? null);
      const agentKeys = await readDesktopSupervisorGrantAgentKeysForEntries(
        entries.map((entry) => entry.id),
      ).catch(() => new Map<string, string>());
      return entries.map((entry) => ({
        ...entry,
        agentKey: entry.agentKey ?? agentKeys.get(entry.id) ?? null,
      }));
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:create-agent",
    async (_event, rawInput: DesktopSupervisorCreateInput): Promise<DesktopSupervisorManifestEntry> => {
      assertDesktopUpdateMutationAllowed();
      // Pin the launch id up front so every launch fact — and the durable entry
      // id (`supervised_<launchId>`) — shares one stable key across retries and
      // reopen. The renderer normally supplies it; fall back defensively.
      const launchId = normalizeLaunchId(rawInput.creationRequestId);
      const input: DesktopSupervisorCreateInput = { ...rawInput, creationRequestId: launchId };
      const entryId = `supervised_${launchId}`;
      const provider = input.providerId;
      const roomIdentifier = input.roomIdentifier;
      const launchFact = (
        type: Parameters<typeof emitLaunchEvent>[0]["type"],
        extra: { entryId?: string | null; detail?: string | null; diagnostic?: string | null; recovery?: import("../launch-events.js").EmitLaunchEventInput["recovery"]; durable?: boolean } = {},
      ): void => {
        emitLaunchEvent({ launchId, roomIdentifier, provider, type, ...extra });
      };
      // The user clicked Start: the first server-side fact of this launch.
      launchFact("launch.requested", { entryId, detail: "You asked LetAgents to add this agent." });
      try {
        const storage = await getDesktopRoomStorage(roomIdentifier);
        if (storage.effectiveMode !== "cloud") {
          throw new LaunchBlockedError("Supervised agents need a cloud room. Publish or join a cloud room, or use the existing local agent path.", "choose_project");
        }
        if (provider !== "codex" && provider !== "claude-code" && provider !== "cursor" && provider !== "open-model") {
          throw new LaunchBlockedError(`Supervised ${provider} is not available yet: no background lifecycle is supported for this provider.`, "retry");
        }
        if (provider === "claude-code" && input.permissionProfileId === "ask_before_write") {
          throw new LaunchBlockedError("Supervised Claude Code cannot use Ask before writes yet: native permission prompts are not bridged. Choose Read-only or Full access.", "retry");
        }
        try {
          assertManagedAgentPermissionProfileAvailable(provider, input.permissionProfileId);
        } catch (error) {
          throw new LaunchBlockedError(
            error instanceof Error ? error.message : "The selected permission profile is unavailable.",
            "retry",
          );
        }
        // Contact the background supervisor first so its (un)availability is an
        // honest, owner-visible fact rather than a hidden part of the claim.
        try {
          await supervisorDaemonClient.ensureRunning();
        } catch (error) {
          throw new LaunchBlockedError("LetAgents could not reach background agent management. Make sure the app can start its background service, then try again.", "reconnect");
        }
        launchFact("supervisor.connected", { entryId, detail: "Background agent management is available." });
        // Claim the lane durably first. Every legacy start consults this daemon
        // fence, so no new legacy owner may appear while transfer is in flight.
        return await transferSupervisorOwnership({
          claim: async () => {
            const { entry: manifest } = await supervisorGrantCoordinator.createPausedAndInstall(input);
            // The paused ownership claim is now persisted: setup survives an app
            // restart from here on.
            launchFact("agent.saved", { entryId: manifest.id, detail: "Your request is recorded and will survive an app restart.", durable: true });
            return manifest;
          },
          listLegacy: () => listDesktopManagedAgentSessions(roomIdentifier)
            .filter((session) => session.providerId === provider && !session.supervisorEntryId),
          stopLegacy: (session) => stopDesktopManagedAgent({ sessionId: session.id, stopMode: "worker" }).then(() => undefined),
          // Activation is the second durable CAS. The daemon, not Electron,
          // launches the native provider and remains authoritative after quit.
          activate: async (manifest) => {
            const activated = await supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "running");
            if (!activated) throw new Error("The supervised launch changed while ownership was being transferred; it was not restarted.");
            launchFact("launch.activated", { entryId: manifest.id, detail: "LetAgents is now responsible for starting this agent.", durable: true });
            return activated;
          },
          rollback: (manifest) => supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "stopped").then(() => undefined),
        });
      } catch (error) {
        const diagnostic = redactCredentialText(error instanceof Error ? error.message : String(error));
        console.error(`[supervised-launch:${entryId}] ${diagnostic.value}`);
        const failure = classifyLaunchFailure(error);
        launchFact(failure.type, { entryId, detail: failure.detail, diagnostic: failure.diagnostic, recovery: failure.recovery });
        throw error;
      }
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:get-launch-events",
    async (_event, launchId: string, afterSequence?: number | null) =>
      getLaunchEvents(launchId, afterSequence ?? null),
  );
  targetIpcMain.handle(
    "desktop:supervisor:resume-ownership-transfer",
    async (_event, id: string): Promise<DesktopSupervisorManifestEntry> => {
      assertDesktopUpdateMutationAllowed();
      const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown supervised agent: ${id}`);
      if (entry.desiredState !== "paused") return entry;
      const launchId = id.startsWith("supervised_") ? id.slice("supervised_".length) : id;
      const launchFact = (
        type: Parameters<typeof emitLaunchEvent>[0]["type"],
        detail: string,
      ): void => {
        emitLaunchEvent({
          launchId,
          entryId: entry.id,
          roomIdentifier: entry.roomId,
          provider: entry.provider,
          type,
          detail,
          durable: true,
        });
      };
      launchFact("launch.requested", "You asked LetAgents to resume this saved launch.");
      try {
        return await supervisorGrantCoordinator.activateEntry(entry, async () => {
          launchFact("supervisor.connected", "Background agent management is available.");
          launchFact("agent.saved", "Your saved launch is ready to resume.");
          return transferSupervisorOwnership({
            claim: async () => entry,
            listLegacy: () => listDesktopManagedAgentSessions(entry.roomId)
              .filter((session) => session.providerId === entry.provider && !session.supervisorEntryId),
            stopLegacy: (session) => stopDesktopManagedAgent({ sessionId: session.id, stopMode: "worker" }).then(() => undefined),
            activate: async (manifest) => {
              const activated = await supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "running");
              if (!activated) throw new Error("The saved launch changed while ownership was being resumed; it was not restarted.");
              launchFact("launch.activated", "LetAgents resumed ownership of this agent.");
              return activated;
            },
            rollback: (manifest) => supervisorDaemonClient.compareAndSetDesiredState(manifest.id, "paused", "stopped").then(() => undefined),
          });
        });
      } catch (error) {
        const failure = classifyLaunchFailure(error);
        emitLaunchEvent({
          launchId,
          entryId: entry.id,
          roomIdentifier: entry.roomId,
          provider: entry.provider,
          type: failure.type,
          detail: failure.detail,
          recovery: failure.recovery,
          durable: true,
        });
        throw error;
      }
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:set-desired-state",
    async (_event, id: string, desiredState: DesktopSupervisorDesiredState): Promise<DesktopSupervisorManifestEntry> => {
      assertDesktopUpdateMutationAllowed();
      if (desiredState === "running") {
        const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown supervised agent: ${id}`);
        // Claude receives a private managed MCP config at launch. Other
        // providers retain their existing external-config refresh behavior.
        if (entry.provider !== "claude-code") {
          await refreshInstalledLetAgentsMcpServerAuth();
        }
        return supervisorGrantCoordinator.activateEntry(
          entry,
          () => supervisorDaemonClient.setDesiredState(id, desiredState),
        );
      }
      const updated = await supervisorDaemonClient.setDesiredState(id, desiredState);
      // Cancelling belongs to launch history only when the launch never reached
      // ready. "Ever ready" is durable/monotonic (readyReachedAt), so a launch
      // that reached ready and later degraded before Stop is still a lifecycle
      // stop (an agent event), while a bound-but-never-reachable pre-ready
      // attempt correctly records as a cancelled launch.
      if (desiredState === "stopped" && id.startsWith("supervised_")) {
        if (!supervisedLaunchEverReady(updated)) {
          emitLaunchEvent({
            launchId: id.slice("supervised_".length),
            entryId: id,
            roomIdentifier: updated.roomId,
            provider: updated.provider,
            type: "launch.cancelled",
            detail: "You stopped this launch.",
            durable: true,
          });
        }
      }
      return updated;
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:retry-room-delivery",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorRoomDeliveryRetryInput): Promise<void> => {
      assertDesktopUpdateMutationAllowed();
      if (isDesktopSmokeCheck()) throw new Error("Room delivery retry is unavailable in the desktop smoke environment.");
      await supervisorDaemonClient.retryRoomDelivery(input);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:restore-agent-conversation",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorConversationRestoreInput): Promise<void> => {
      assertDesktopUpdateMutationAllowed();
      if (isDesktopSmokeCheck()) throw new Error("Conversation restoration is unavailable in the desktop smoke environment.");
      await supervisorDaemonClient.restoreAgentConversation(input);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:skip-room-delivery",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorRoomDeliverySkipInput): Promise<void> => {
      assertDesktopUpdateMutationAllowed();
      if (isDesktopSmokeCheck()) throw new Error("Room delivery skipping is unavailable in the desktop smoke environment.");
      await supervisorDaemonClient.skipRoomDelivery(input);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:reconnect-agent",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorReconnectInput): Promise<DesktopSupervisorManifestEntry> => {
      assertDesktopUpdateMutationAllowed();
      if (isDesktopSmokeCheck()) throw new Error("Agent reconnection is unavailable in the desktop smoke environment.");
      const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === input.entryId);
      if (!entry) throw new Error(`Unknown supervised agent: ${input.entryId}`);
      await supervisorGrantCoordinator.reconnectEntry(entry);
      return (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === input.entryId) || entry;
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:recover-agent-runtime",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorRuntimeRecoveryInput): Promise<DesktopSupervisorManifestEntry> => {
      assertDesktopUpdateMutationAllowed();
      if (isDesktopSmokeCheck()) throw new Error("Agent runtime recovery is unavailable in the desktop smoke environment.");
      const entry = (await supervisorDaemonClient.list(null)).find((candidate) => candidate.id === input.entryId);
      if (!entry) throw new Error(`Unknown supervised agent: ${input.entryId}`);
      // Electron restores secret custody first. The daemon then proves the
      // saved provider absent, retires the exact old worker session, and only
      // afterwards permits convergence to create a successor runtime.
      await supervisorGrantCoordinator.prepareEntryForRuntimeRecovery(entry);
      return supervisorDaemonClient.recoverAgentRuntime(entry.id);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:control-turn",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorTurnControlInput) => {
      assertDesktopUpdateMutationAllowed();
      return isDesktopSmokeCheck() ? desktopSmokeControlTurn(input) : supervisorDaemonClient.controlTurn(input);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:resolve-turn-control",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorTurnControlResolutionInput) => {
      assertDesktopUpdateMutationAllowed();
      return supervisorDaemonClient.resolveTurnControl(input);
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor:read-attempt",
    async (_event, id: string): Promise<DesktopSupervisorAttemptDetail> => supervisorDaemonClient.readAttempt(id),
  );
  targetIpcMain.handle(
    "desktop:supervisor:get-agent-inspector-detail",
    async (_event, input: import("../../ipc-types.js").DesktopSupervisorAgentInspectorDetailInput): Promise<import("../../ipc-types.js").DesktopSupervisorAgentInspectorDetail> => {
      if (isDesktopSmokeCheck()) throw new Error("Agent inspector detail history is unavailable in the desktop smoke environment.");
      return supervisorDaemonClient.getAgentInspectorDetail(input);
    },
  );
  targetIpcMain.handle("desktop:supervisor:get-agent-configuration", async (_event, input: { entryId: string; daemonGeneration: number }) =>
    supervisorDaemonClient.getAgentConfiguration(input.entryId, input.daemonGeneration));
  targetIpcMain.handle("desktop:supervisor:update-agent-configuration", async (_event, input: import("../../ipc-types.js").DesktopSupervisorAgentConfigurationUpdateInput) => {
    assertDesktopUpdateMutationAllowed();
    return supervisorDaemonClient.updateAgentConfiguration(input);
  });
  targetIpcMain.handle("desktop:supervisor:prepare-room-move", async (_event, input: import("../../ipc-types.js").DesktopSupervisorRoomMovePrepareInput) => {
    assertDesktopUpdateMutationAllowed();
    return supervisorDaemonClient.prepareRoomMove(input);
  });
  targetIpcMain.handle("desktop:supervisor:commit-room-move", async (_event, input: import("../../ipc-types.js").DesktopSupervisorRoomMoveOperationInput) => {
    assertDesktopUpdateMutationAllowed();
    let move = await supervisorDaemonClient.commitRoomMove(input);
    for (let step = 0; step < 4; step += 1) {
      if (move.phase === "rotating_credentials") {
        try {
          await supervisorGrantCoordinator.prepareRoomMoveDestination(move);
          move = await supervisorDaemonClient.commitRoomMove(input);
          continue;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          move = await supervisorDaemonClient.rollbackRoomMove({ ...input, error: detail });
          try {
            await supervisorGrantCoordinator.prepareRoomMoveSourceRollback(move);
            return await supervisorDaemonClient.commitRoomMove(input);
          } catch (rollbackError) {
            throw new Error(`Destination credential preparation failed (${detail}); source authority rollback is pending: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
      }
      if (move.phase === "rollback_required") {
        move = await supervisorDaemonClient.rollbackRoomMove({
          ...input, error: move.error ?? "Resuming durable room-move rollback.",
        });
        await supervisorGrantCoordinator.prepareRoomMoveSourceRollback(move);
        move = await supervisorDaemonClient.commitRoomMove(input);
        continue;
      }
      return move;
    }
    return move;
  });
  targetIpcMain.handle("desktop:supervisor:get-room-move", async (_event, input: import("../../ipc-types.js").DesktopSupervisorRoomMoveOperationInput) =>
    supervisorDaemonClient.getRoomMove(input));
  targetIpcMain.handle("desktop:supervisor:get-current-room-move", async (_event, input: import("../../ipc-types.js").DesktopSupervisorCurrentRoomMoveInput) =>
    supervisorDaemonClient.getCurrentRoomMove(input));
  targetIpcMain.handle("desktop:supervisor:retire-agent", async (_event, input: { entryId: string; daemonGeneration: number }) => {
    assertDesktopUpdateMutationAllowed();
    return supervisorGrantCoordinator.retireEntry(input.entryId, input.daemonGeneration);
  });
  targetIpcMain.handle("desktop:supervisor:purge-agent", async (_event, input: { entryId: string; daemonGeneration: number }) => {
    assertDesktopUpdateMutationAllowed();
    const finishPurge = <T extends { outcome: string; purgedWorkAttemptId?: string }>(result: T): T => {
      // Cursor profiles are keyed only by the exact attempt id. Applying this
      // cleanup to another provider is a harmless no-op, while keeping the
      // purge retry replayable after the identity row has already committed.
      if (result.outcome === "purged" && result.purgedWorkAttemptId) {
        removeCursorSupervisedProfile(result.purgedWorkAttemptId);
      }
      return result;
    };
    const prepared = await supervisorDaemonClient.purgeAgent(input.entryId, input.daemonGeneration, null, false, true);
    if (prepared.outcome !== "revocation_required") return finishPurge(prepared);
    if (prepared.revocationKind === "grant_only") {
      await supervisorGrantCoordinator.revokeEntryForPurgeWithoutWorkerSession(input.entryId);
      const committed = await supervisorDaemonClient.purgeAgent(input.entryId, input.daemonGeneration, null, true, true);
      return finishPurge(committed.outcome === "revocation_required"
        ? { outcome: "invalid" as const, error: "Purge grant revocation was not durably acknowledged." }
        : committed);
    }
    if (prepared.revocationKind !== "worker_session" || !prepared.agentSessionId) {
      return { outcome: "invalid" as const, error: "Purge did not identify an exact revocation mode." };
    }
    await supervisorGrantCoordinator.revokeEntryForPurge(input.entryId, prepared.agentSessionId);
    const committed = await supervisorDaemonClient.purgeAgent(input.entryId, input.daemonGeneration, prepared.agentSessionId, false, true);
    return finishPurge(committed.outcome === "revocation_required" ? { outcome: "invalid" as const, error: "Purge credential revocation was not durably acknowledged." } : committed);
  });
  if (!supervisorActivityBridgeRegistered) {
    supervisorActivityBridgeRegistered = true;
    onSupervisorActivity((payload) => emitToMainWindow("desktop:supervisor:activity", payload));
  }
  if (!supervisorStateBridgeRegistered) {
    supervisorStateBridgeRegistered = true;
    onSupervisorState((snapshot) => emitToMainWindow("desktop:supervisor:state", snapshot));
  }
  if (!supervisorLaunchBridgeRegistered) {
    supervisorLaunchBridgeRegistered = true;
    onLaunchEvent((event) => emitToMainWindow("desktop:supervisor:launch-event", event));
  }
  if (!supervisorAgentStreamBridgeRegistered) {
    supervisorAgentStreamBridgeRegistered = true;
    onSupervisorAgentStream((batch) => emitToMainWindow("desktop:supervisor:agent-stream", batch));
  }
  targetIpcMain.handle(
    "desktop:supervisor:watch-agent-stream",
    // The renderer focuses the live feed on the inspected agent, or clears it
    // (null) when the inspector closes. Only one agent streams at a time.
    async (_event, entryId?: string | null): Promise<void> => {
      setFocusedAgentStream(typeof entryId === "string" && entryId.trim() ? entryId : null);
    },
  );
}
