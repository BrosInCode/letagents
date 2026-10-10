/** Host-local measurements of the selected provider account and exact conversation. */
export type ProviderUsage = {
  providerContinuationId: string;
  account: { state: "available" | "stale" | "unavailable"; windows: Array<{
    id: string; label: string; usedPercent: number; resetsAt: string | null; observedAt: string;
  }> };
  context: { usedTokens: number; capacityTokens: number | null; observedAt: string } | null;
  compaction: "compacting" | "compacted" | null;
};
export type InspectorUsage = ProviderUsage & { executionGenerationId: string; daemonGeneration: number };
