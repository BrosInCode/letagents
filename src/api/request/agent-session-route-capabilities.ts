import type { AgentSessionBearerCapability } from "../../shared/agent-session-bearer.js";

// Exact, anchored templates only. New subroutes receive no worker authority.
const ROUTES: ReadonlyArray<{ method: string; path: RegExp; capability: AgentSessionBearerCapability }> = [
  { method: "GET", path: /^\/rooms\/[^/]+\/messages$/, capability: "messages.read" },
  { method: "GET", path: /^\/rooms\/[^/]+\/messages\/(?:poll|stream|threads|msg_\d+|msg_\d+\/thread)$/, capability: "messages.read" },
  { method: "POST", path: /^\/rooms\/[^/]+\/messages$/, capability: "messages.write" },
  { method: "GET", path: /^\/rooms\/[^/]+\/artifacts$/, capability: "artifacts.read" },
  { method: "GET", path: /^\/rooms\/[^/]+\/(?:presence|participants|activity-history|reasoning|reasoning-sessions|reasoning-sessions\/[^/]+|tasks|tasks\/github-status|tasks\/[^/]+|board-governance|board-settings|board-intents|artifacts)$/, capability: "coordination.read" },
  { method: "POST", path: /^\/rooms\/[^/]+\/(?:presence|reasoning-sessions|reasoning-sessions\/[^/]+\/updates|agent-sessions\/[^/]+\/(?:disconnect|failures|desktop-heartbeat|desktop-pause)|tasks\/[^/]+\/(?:lease-action|review-lease-action))$/, capability: "coordination.self_write" },
  { method: "PATCH", path: /^\/rooms\/[^/]+\/(?:reasoning-sessions\/[^/]+|tasks\/[^/]+)$/, capability: "coordination.self_write" },
  { method: "POST", path: /^\/rooms\/[^/]+\/tasks$/, capability: "coordination.propose" },
  { method: "POST", path: /^\/rooms\/[^/]+\/artifacts$/, capability: "artifacts.self_write" },
];

export function requiredAgentSessionRouteCapability(method: string, path: string): AgentSessionBearerCapability | null {
  const normalized = path.replace(/^\/api(?=\/rooms\/)/, "");
  return ROUTES.find((route) => route.method === method.toUpperCase() && route.path.test(normalized))?.capability ?? null;
}

export function hasRequiredAgentSessionRouteCapability(input: { method: string; path: string; capabilities: readonly AgentSessionBearerCapability[] }): boolean {
  const required = requiredAgentSessionRouteCapability(input.method, input.path);
  return Boolean(required && input.capabilities.includes(required));
}
