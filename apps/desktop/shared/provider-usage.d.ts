/** Host-local measurements of the selected provider account and exact conversation. */
export type ProviderUsage = {
  providerContinuationId: string;
  account: { state: "available" | "stale" | "unavailable"; windows: Array<{
    id: string; label: string; usedPercent: number; resetsAt: string | null; observedAt: string;
  }> };
  context: { usedTokens: number; capacityTokens: number | null; observedAt: string } | null;
  compaction: "compacting" | "compacted" | null;
};
/**
 * What one usage read may do. `refreshAccount` lets the adapter read the
 * account's limits again, which can cost a call to the provider; without it,
 * the adapter answers with the limits it read last.
 */
export type ProviderUsageReadOptions = { refreshAccount: boolean };
export type InspectorUsage = ProviderUsage & { executionGenerationId: string; daemonGeneration: number };
