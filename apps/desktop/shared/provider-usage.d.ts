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
 * account's limits again, which can cost a call to the provider. An adapter
 * whose limit read is costly (Antigravity's `agy -p /quota`) answers with the
 * limits it read last without it; the others keep their own schedule.
 */
export type ProviderUsageReadOptions = { refreshAccount: boolean };
export type InspectorUsage = ProviderUsage & { executionGenerationId: string; daemonGeneration: number };
