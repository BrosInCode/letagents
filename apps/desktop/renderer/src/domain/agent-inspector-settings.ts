import type {
  DesktopAgentProvider,
  DesktopManagedAgentEffort,
  DesktopSupervisorAgentConfiguration,
  DesktopSupervisorRoomMove,
} from "../../../electron/ipc-types";

export type AgentInspectorConfigurationDraft = Pick<
  DesktopSupervisorAgentConfiguration,
  "model" | "reasoningEffort" | "charter" | "permissionProfileId" | "providerLaunchPolicy"
>;

export type AgentInspectorConfigurationResource = {
  status: "idle" | "loading" | "ready" | "refreshing" | "error" | "unavailable";
  configuration: DesktopSupervisorAgentConfiguration | null;
  draft: AgentInspectorConfigurationDraft | null;
  error: string | null;
};

export type AgentInspectorRoomMoveResource = {
  move: DesktopSupervisorRoomMove | null;
  status: "idle" | "loading" | "preparing" | "committing" | "recovering" | "error" | "unavailable";
  error: string | null;
};

export interface AgentInspectorConfigurationSaveSnapshot {
  entryId: string;
  daemonGeneration: number;
  expectedRevision: number;
  draft: AgentInspectorConfigurationDraft;
  draftVersion: number;
}

export interface AgentInspectorSettingsFence {
  entryId: string;
  roomId: string;
  daemonGeneration: number;
  requestToken: number;
}

export interface AgentInspectorSettingsCoordinates {
  entryId: string | null;
  roomId: string;
  daemonGeneration: number | null;
  requestToken: number;
}

export const AGENT_INSPECTOR_RETIRE_CONFIRMATION =
  "This retires the saved agent. Its history and worktree stay available.";

export const AGENT_INSPECTOR_ROOM_MOVE_UNAVAILABLE =
  "Room moves are unavailable in this build. The supervisor can read a move only by operation ID, but does not expose the active operation ID needed to recover after this inspector or app reopens.";

export function snapshotConfigurationSave(
  resource: AgentInspectorConfigurationResource,
  draftVersion: number,
  daemonGeneration: number,
): AgentInspectorConfigurationSaveSnapshot | null {
  const configuration = resource.configuration;
  const draft = resource.draft;
  if (resource.status !== "ready" || !configuration || !draft || configuration.daemonGeneration !== daemonGeneration) return null;
  return {
    entryId: configuration.entryId,
    daemonGeneration,
    expectedRevision: configuration.configRevision,
    draft: { ...draft },
    draftVersion,
  };
}

export function settleConfigurationUpdate(
  resource: AgentInspectorConfigurationResource,
  draftVersion: number,
  snapshot: AgentInspectorConfigurationSaveSnapshot,
  configuration: DesktopSupervisorAgentConfiguration,
): { resource: AgentInspectorConfigurationResource; draftVersion: number } {
  const draftChanged = draftVersion !== snapshot.draftVersion;
  return {
    resource: {
      status: "ready",
      configuration,
      draft: draftChanged && resource.draft ? resource.draft : configurationDraft(configuration),
      error: null,
    },
    draftVersion: draftChanged ? draftVersion : draftVersion + 1,
  };
}

export function settleConfigurationConflict(
  resource: AgentInspectorConfigurationResource,
  snapshot: AgentInspectorConfigurationSaveSnapshot,
  configuration: DesktopSupervisorAgentConfiguration,
): AgentInspectorConfigurationResource {
  return {
    status: "ready",
    configuration,
    draft: resource.draft ?? snapshot.draft,
    error: null,
  };
}

export function agentInspectorSettingsFenceCurrent(
  fence: AgentInspectorSettingsFence,
  coordinates: AgentInspectorSettingsCoordinates,
): boolean {
  return fence.entryId === coordinates.entryId
    && fence.roomId === coordinates.roomId
    && fence.daemonGeneration === coordinates.daemonGeneration
    && fence.requestToken === coordinates.requestToken;
}

export function supervisorGenerationIsCurrent(previousGeneration: number | null, nextGeneration: number): boolean {
  return previousGeneration === null || nextGeneration >= previousGeneration;
}

export function isStaleDaemonGenerationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /stale daemon generation|stale or invalid|changed generation/i.test(message);
}

export function configurationDraft(configuration: DesktopSupervisorAgentConfiguration): AgentInspectorConfigurationDraft {
  return {
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    charter: configuration.charter,
    permissionProfileId: configuration.permissionProfileId,
    // The daemon owns provider policy. Preserve unknown policy verbatim.
    providerLaunchPolicy: configuration.providerLaunchPolicy,
  };
}

export function configurationHasRuntimeLag(configuration: DesktopSupervisorAgentConfiguration | null): boolean {
  return Boolean(configuration && configuration.runtimeConfigurationRevision < configuration.configRevision);
}

export function agentInspectorProvider(
  providers: readonly DesktopAgentProvider[],
  configuration: DesktopSupervisorAgentConfiguration | null,
): DesktopAgentProvider | null {
  return providers.find((provider) => provider.id === configuration?.provider) ?? null;
}

export function agentInspectorProviderSupportsEffort(providerId: string | null | undefined): boolean {
  return providerId === "codex" || providerId === "open-model";
}

export function roomMovePresentation(move: DesktopSupervisorRoomMove): { label: string; detail: string; terminal: boolean } {
  switch (move.phase) {
    case "prepared": return { label: "Move saved", detail: "The move is prepared and has not changed room membership.", terminal: false };
    case "waiting_for_current_turn": return { label: "Waiting for current turn", detail: "The move will continue after active room work reaches a safe boundary.", terminal: false };
    case "joining_destination": return { label: "Joining destination", detail: "Destination membership is being joined; the source remains authoritative until commit.", terminal: false };
    case "membership_committed": return { label: "Membership moved", detail: "Destination membership is committed; destination ingress is not active yet.", terminal: false };
    case "rotating_credentials": return { label: "Rotating credentials", detail: "The previous room credential is being retired before destination authority starts.", terminal: false };
    case "bootstrapping_destination_tail": return { label: "Starting destination observation", detail: "The destination tail is being observed before ingress becomes active.", terminal: false };
    case "active": return { label: "Moved", detail: "Destination observation is active.", terminal: true };
    case "failed": return { label: "Move failed", detail: move.error || "The move did not complete. The durable journal has released this move.", terminal: true };
    case "rollback_required": return { label: "Recovery required", detail: move.error || "The daemon is reconciling source and destination membership.", terminal: false };
  }
}

export function recoveredRoomMoveState(move: DesktopSupervisorRoomMove | null): {
  resource: AgentInspectorRoomMoveResource;
  shouldPoll: boolean;
  refreshAgents: boolean;
} {
  if (!move) return {
    resource: { status: "idle", move: null, error: null },
    shouldPoll: false,
    refreshAgents: false,
  };
  const presentation = roomMovePresentation(move);
  if (move.phase === "active") return {
    resource: { status: "idle", move: null, error: null },
    shouldPoll: false,
    refreshAgents: true,
  };
  return {
    resource: {
      status: presentation.terminal || move.phase === "prepared" ? "idle" : "recovering",
      move,
      error: move.phase === "failed" ? presentation.detail : null,
    },
    shouldPoll: !presentation.terminal && move.phase !== "prepared",
    refreshAgents: false,
  };
}

export const inspectorEffortOptions: Array<{ value: "" | DesktopManagedAgentEffort; label: string }> = [
  { value: "", label: "Provider default" },
  { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
  { value: "high", label: "High" }, { value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" },
];
