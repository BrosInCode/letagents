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
  status: "idle" | "preparing" | "committing" | "recovering" | "error";
  error: string | null;
};

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

export function isMovableInspectorConfiguration(configuration: DesktopSupervisorAgentConfiguration | null): boolean {
  return Boolean(configuration?.provider && configuration.charter.trim());
}

export const inspectorEffortOptions: Array<{ value: "" | DesktopManagedAgentEffort; label: string }> = [
  { value: "", label: "Provider default" },
  { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
  { value: "high", label: "High" }, { value: "xhigh", label: "Extra high" }, { value: "max", label: "Max" },
];
