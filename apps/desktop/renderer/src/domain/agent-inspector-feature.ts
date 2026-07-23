/**
 * PR2 ships the complete foundation dark. The final inspector cutover flips
 * this constant and removes the legacy modal; there is never a hidden second
 * surface or listener.
 */
export const AGENT_INSPECTOR_FOUNDATION_ENABLED = false;

/**
 * Keeps the dark launch genuinely inert: while disabled, neither the new
 * projection nor any of its task/activity grouping work is evaluated.
 */
export function projectAgentInspectorsWhenEnabled(
  enabled: boolean,
  entries: readonly DesktopSupervisorManifestEntry[],
  options: AgentInspectorProjectionOptions,
): AgentInspectorProjection[] {
  return enabled ? projectAgentInspectors(entries, options) : [];
}
import type { DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import {
  projectAgentInspectors,
  type AgentInspectorProjection,
  type AgentInspectorProjectionOptions,
} from "./agent-inspector";
