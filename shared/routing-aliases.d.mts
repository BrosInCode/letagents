export type RoutingIdentityLike = {
  actorLabel?: string | null;
  actor_label?: string | null;
  displayName?: string | null;
  display_name?: string | null;
  agentKey?: string | null;
  agent_key?: string | null;
};

export function normalizeRoutingSender(value: unknown): string;
export function normalizeRoutingHandle(value: unknown): string;
export function routingIdentityAliases(identity: RoutingIdentityLike): Set<string>;
export function routingSenderAliasRows(
  sender: unknown,
  segmentLimit?: number,
): Array<{ alias: string; isFull: boolean }>;
export function routingSenderAliases(sender: unknown, segmentLimit?: number): Set<string>;
export function routingAliasHash(alias: string): string;
