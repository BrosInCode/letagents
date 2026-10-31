import { createHash, randomUUID } from "crypto";
import { hostname, userInfo } from "os";

import {
  readLocalState,
  updateLocalState,
} from "../../../local-state.js";
import {
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
} from "./config.js";
import { agentInstanceUuid } from "./state.js";
import { currentSessionScope } from "../session-scope.js";

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

/**
 * Names this machine for the room's same-machine reasoning. The stored host
 * id alone cannot: it lives in a file, and a file that is copied to another
 * machine, or shared with one, carries it along. This adds what the machine
 * says of itself, so two machines never report the same value.
 */
export function getProcessHostId(): string {
  // A remote session is its own host; the API server's names stay private.
  if (currentSessionScope()) {
    return `phost_${createHash("sha256").update(`remote_mcp\n${getOrCreateLocalHostId()}`).digest("hex").slice(0, 32)}`;
  }
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // Some systems have no entry for the current user.
  }
  const parts = [getOrCreateLocalHostId(), hostname(), user, process.platform, process.arch];
  return `phost_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)}`;
}

export function getSessionLivenessRegistration(runtime = detectAgentRuntimeLabel()) {
  const hostId = getOrCreateLocalHostId();
  const ideLabel = detectAgentIdeLabel();
  const normalizedRuntime = runtime.trim().toLowerCase() || ideLabel.toLowerCase();
  return {
    host_id: hostId,
    host_kind: currentSessionScope() ? "remote_mcp" : process.platform === "darwin" ? "macos" : process.platform,
    host_label: null,
    // The package streamed Codex app-server activity only for a local Codex live
    // session, which letagents 0.12.46 removed; every session reports its own activity.
    liveness_capability: "session_activity",
    tool_bridge_id: `${hostId}:${normalizedRuntime}:${agentInstanceUuid()}`,
  };
}
