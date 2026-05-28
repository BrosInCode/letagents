import { randomUUID } from "crypto";

import {
  readLocalState,
  updateLocalState,
} from "../../../local-state.js";
import {
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
} from "./config.js";
import { AGENT_INSTANCE_UUID } from "./state.js";

function getOrCreateLocalHostId(): string {
  const state = readLocalState();
  if (typeof state.local_host_id === "string" && state.local_host_id.trim()) {
    return state.local_host_id;
  }

  const hostId = `host_${randomUUID().replace(/-/g, "")}`;
  updateLocalState((nextState) => {
    nextState.local_host_id = typeof nextState.local_host_id === "string" && nextState.local_host_id.trim()
      ? nextState.local_host_id
      : hostId;
    return nextState;
  });
  return readLocalState().local_host_id || hostId;
}

export function getSessionLivenessRegistration(runtime = detectAgentRuntimeLabel()) {
  const hostId = getOrCreateLocalHostId();
  const ideLabel = detectAgentIdeLabel();
  const normalizedRuntime = runtime.trim().toLowerCase() || ideLabel.toLowerCase();
  return {
    host_id: hostId,
    host_kind: process.platform === "darwin" ? "macos" : process.platform,
    host_label: null,
    liveness_capability: normalizedRuntime === "codex"
      ? "codex_app_server_runtime_stream"
      : "session_activity",
    tool_bridge_id: `${hostId}:${normalizedRuntime}:${AGENT_INSTANCE_UUID}`,
  };
}
