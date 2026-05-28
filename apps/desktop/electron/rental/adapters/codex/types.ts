export interface CodexAdapterOptions {
  /** Override the default Codex home directory (mainly for tests). */
  homeDirOverride?: string;
  /** Extra absolute files or directories to consider as sources. */
  additionalPaths?: string[];
  /** Maximum bytes to read from any one JSONL file. Default 32 MiB. */
  maxFileBytes?: number;
  /** Maximum JSONL session files to return from discovery. Default 25. */
  maxDiscoveredFiles?: number;
  /** Maximum directory depth to walk when discovering JSONL logs. */
  maxDiscoveryDepth?: number;
}

export interface ParsedCodexUsageEvent {
  timestamp: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  /**
   * True when the event itself was parsed from a cumulative total. Most
   * modern Codex token_count events include `last_token_usage` and
   * `total_token_usage`; in that case the event fields are the delta
   * and this flag is false.
   */
  isCumulative: boolean;
  /** Latest cumulative session total, when the event exposed one. */
  cumulativeTotals: CodexUsageTotals | null;
  rateLimits: Record<string, unknown> | null;
}

export interface CodexUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}
