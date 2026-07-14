import type { AgentSessionBearerCapability } from "../../shared/agent-session-bearer.js";

// This is intentionally an allow-list. Adding a room route does not make it
// callable by a worker bearer until it is assigned a semantic capability here.
export function requiredAgentSessionRouteCapability(
  method: string,
  path: string
): AgentSessionBearerCapability | null {
  const normalizedMethod = method.toUpperCase();
  const roomPath = path.replace(/^\/api(?=\/rooms\/)/, "");
  if (!/^\/rooms\/[^/]+(?:\/|$)/.test(roomPath)) return null;

  if (/^\/rooms\/[^/]+\/messages(?:\/|$)/.test(roomPath)) {
    return normalizedMethod === "GET" ? "messages.read" : normalizedMethod === "POST" ? "messages.write" : null;
  }
  if (/^\/rooms\/[^/]+\/(?:presence|participants|activity-history)(?:\/|$)/.test(roomPath)) {
    return normalizedMethod === "GET" ? "coordination.read" : normalizedMethod === "POST" ? "coordination.self_write" : null;
  }
  if (/^\/rooms\/[^/]+\/agent-sessions\/[^/]+\/(?:disconnect|failures|desktop-heartbeat|desktop-pause)$/.test(roomPath)) {
    return normalizedMethod === "POST" ? "coordination.self_write" : null;
  }
  if (/^\/rooms\/[^/]+\/reasoning(?:-sessions)?(?:\/|$)/.test(roomPath)) {
    return normalizedMethod === "GET" ? "coordination.read" : ["POST", "PATCH"].includes(normalizedMethod) ? "coordination.self_write" : null;
  }
  if (/^\/rooms\/[^/]+\/artifacts(?:\/|$)/.test(roomPath)) {
    return normalizedMethod === "GET" ? "artifacts.read" : normalizedMethod === "POST" ? "artifacts.self_write" : null;
  }
  if (/^\/rooms\/[^/]+\/tasks(?:\/|$)/.test(roomPath)) {
    return normalizedMethod === "GET" ? "coordination.read" : ["POST", "PATCH"].includes(normalizedMethod) ? "coordination.self_write" : null;
  }
  if (/^\/rooms\/[^/]+\/(?:board-governance|board-settings|board-intents)$/.test(roomPath)) {
    return normalizedMethod === "GET" ? "coordination.read" : null;
  }
  return null;
}

export function hasRequiredAgentSessionRouteCapability(input: {
  method: string;
  path: string;
  capabilities: readonly AgentSessionBearerCapability[];
}): boolean {
  const required = requiredAgentSessionRouteCapability(input.method, input.path);
  return Boolean(required && input.capabilities.includes(required));
}
