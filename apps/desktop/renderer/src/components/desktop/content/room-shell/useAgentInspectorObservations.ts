import type { Ref } from "vue";
import type { DesktopSupervisorDaemonStatus, DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import type { SupervisorEntriesResource } from "../../../../domain/agent-inspector-identity";
import type { AgentInspectorProjection } from "../../../../domain/agent-inspector";
import { agentInspectorDetailKey, defaultAgentInspectorWorkSource, type AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";

/** Explicit checks read the service, its exact agent, then the current work detail. */
export function useAgentInspectorObservations(options: {
  selectedProjection: Readonly<Ref<AgentInspectorProjection | null>>;
  requestVersion: Readonly<Ref<number>>;
  daemonStatus: Readonly<Ref<DesktopSupervisorDaemonStatus | null>>;
  workSource: Ref<string | null>;
  workResource: Readonly<Ref<AgentInspectorWorkResource>>;
  observationVersion(): string;
  refreshStatus(): Promise<DesktopSupervisorDaemonStatus | null>;
  readAgents(roomId: string): Promise<DesktopSupervisorManifestEntry[]>;
  loadDetail(source: string | null, followDefaultSource: boolean): Promise<void>;
  upsert(entry: DesktopSupervisorManifestEntry, requestVersion: number): void;
  entriesState: Ref<SupervisorEntriesResource["state"]>;
  entriesError: Ref<string | null>;
}) {
  async function refreshDiagnostics(): Promise<boolean> {
    const selected = options.selectedProjection.value;
    const requestVersion = options.requestVersion.value;
    if (!selected) return false;
    const isCurrent = () => options.requestVersion.value === requestVersion
      && options.selectedProjection.value?.entryId === selected.entryId
      && options.selectedProjection.value?.roomId === selected.roomId;
    let observationVersion = options.observationVersion();
    const markObservationUnavailable = () => {
      // Retain the evidence, but don't present a failed observation as live.
      // A newer push or action owns its own freshness and must win this race.
      if (!isCurrent() || observationVersion !== options.observationVersion()) return;
      options.entriesState.value = "error";
      options.entriesError.value = "Couldn’t refresh this agent from the background service.";
    };
    const status = await options.refreshStatus();
    if (!status) { markObservationUnavailable(); return false; }
    if (!isCurrent()) return false;
    observationVersion = options.observationVersion();
    let entries: DesktopSupervisorManifestEntry[];
    try { entries = await options.readAgents(selected.roomId); }
    catch { markObservationUnavailable(); return false; }
    if (!isCurrent() || options.daemonStatus.value?.generation !== status.generation) return false;
    const entry = entries.find(candidate => candidate.id === selected.entryId && candidate.roomId === selected.roomId);
    if (!entry) { markObservationUnavailable(); return false; }
    // A newer push or user action wins over this read; never roll it back.
    if (observationVersion === options.observationVersion()) options.upsert(entry, requestVersion);
    const source = options.workSource.value;
    const key = agentInspectorDetailKey(options.selectedProjection.value!.entry, source, status.generation);
    await options.loadDetail(source, false);
    const current = options.selectedProjection.value;
    const resource = options.workResource.value;
    return isCurrent() && options.daemonStatus.value?.generation === status.generation
      && current?.resourceFreshness === "fresh"
      && agentInspectorDetailKey(current.entry, options.workSource.value, status.generation) === key
      && resource.sourceMessageId === source
      && (resource.status === "ready" || resource.status === "unavailable");
  }

  function openWork(): void {
    const projection = options.selectedProjection.value;
    const selectedSource = options.workSource.value;
    const source = selectedSource ?? (projection ? defaultAgentInspectorWorkSource(projection.entry, options.workResource.value.detail) : null);
    options.workSource.value = source;
    // Tab navigation refreshes the selected message without replacing its causal record.
    void options.loadDetail(source, selectedSource === null);
  }

  return { refreshDiagnostics, openWork };
}
