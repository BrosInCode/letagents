import { watch, type Ref } from "vue";
import type { AgentInspectorActionState } from "../../../../domain/agent-inspector";
import {
  agentInspectorRuntimeSignature,
  configurationHasRuntimeLag,
  settleConfigurationRuntimeRefresh,
  type AgentInspectorConfigurationResource,
} from "../../../../domain/agent-inspector-settings";
import type { DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";

/**
 * The daemon applies a saved change by replacing the agent's runtime. While the
 * open Settings panel still shows "Restart needed", re-read the saved
 * configuration once per runtime change so the panel follows the daemon.
 * Only the runtime revision moves: the draft is never touched.
 */
export function useAgentInspectorRuntimeRefresh(options: {
  projection: Readonly<Ref<{ entryId: string; roomId: string; entry: DesktopSupervisorManifestEntry } | null>>;
  resource: Ref<AgentInspectorConfigurationResource>;
  requestState: { agentInspectorSettingsRequestToken: number };
  actionState: Ref<AgentInspectorActionState | null>;
  selectionCurrent(entryId: string, roomId: string): boolean;
}) {
  const actionRunning = () => options.actionState.value?.status === "running";

  async function refresh(): Promise<void> {
    const projection = options.projection.value;
    const shown = options.resource.value;
    const read = desktopIpc.supervisor?.getAgentConfiguration;
    if (!projection || !read || shown.status !== "ready" || !shown.configuration
      || !configurationHasRuntimeLag(shown.configuration) || actionRunning()) return;
    const token = options.requestState.agentInspectorSettingsRequestToken;
    try {
      const fresh = await read({ entryId: projection.entryId, daemonGeneration: shown.configuration.daemonGeneration });
      if (!options.selectionCurrent(projection.entryId, projection.roomId)
        || token !== options.requestState.agentInspectorSettingsRequestToken || actionRunning()) return;
      options.resource.value = settleConfigurationRuntimeRefresh(options.resource.value, fresh);
    } catch {
      // The next runtime change reads again; a stale generation is handled by the status refresh.
    }
  }

  watch(() => {
    const projection = options.projection.value;
    return projection && configurationHasRuntimeLag(options.resource.value.configuration)
      ? agentInspectorRuntimeSignature(projection.entry) : null;
  }, (signature) => { if (signature !== null) void refresh(); });

  return { refresh };
}
