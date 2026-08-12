export const AGENT_SESSION_BEARER_CAPABILITIES = [
  "messages.read",
  "messages.write",
  "coordination.read",
  "coordination.self_write",
  "coordination.propose",
  "artifacts.read",
  "artifacts.self_write",
] as const;

export type AgentSessionBearerCapability = (typeof AGENT_SESSION_BEARER_CAPABILITIES)[number];

export const DEFAULT_AGENT_SESSION_BEARER_CAPABILITIES: AgentSessionBearerCapability[] = [
  ...AGENT_SESSION_BEARER_CAPABILITIES,
];

export function isAgentSessionBearerCapability(value: string): value is AgentSessionBearerCapability {
  return (AGENT_SESSION_BEARER_CAPABILITIES as readonly string[]).includes(value);
}

// The new direct worker principal is deliberately opt-in until F2 uses it.
export function isAgentSessionBearerFeatureEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED ?? "");
}

export function isSupervisorHostGrantFeatureEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED ?? "");
}

export function getAgentSessionBearerTtlMs(): number {
  const configured = Number.parseInt(process.env.LETAGENTS_AGENT_SESSION_BEARER_TTL_MS ?? "", 10);
  if (!Number.isFinite(configured)) return 30 * 60 * 1000;
  return Math.min(Math.max(configured, 60_000), 24 * 60 * 60 * 1000);
}
