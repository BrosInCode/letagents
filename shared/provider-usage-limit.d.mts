export const PROVIDER_USAGE_LIMIT_SOURCE: "provider_usage_limit";

export type ProviderUsageLimitPhase = "start" | "turn";

export interface ProviderUsageLimitNoticeInput {
  agentName: string;
  provider: string;
  /** ISO time or epoch milliseconds; null when the provider did not say. */
  resetsAt: string | number | null;
  phase: ProviderUsageLimitPhase;
}

export interface ParsedProviderUsageLimitNotice {
  agentName: string;
  phase: ProviderUsageLimitPhase;
  /** "Claude", "Codex", "Cursor", "Antigravity" or "The model provider". */
  owner: string;
  resetsAtMs: number | null;
}

export function providerUsageLimitOwner(provider: string | null | undefined): string;
export function providerUsageLimitSubject(provider: string | null | undefined): string;
export function normalizeUsageLimitResetMs(value: unknown): number | null;
export function providerUsageLimitNoticeText(input: ProviderUsageLimitNoticeInput): string;
export function parseProviderUsageLimitNotice(text: string | null | undefined): ParsedProviderUsageLimitNotice | null;
export function looksLikeProviderUsageLimit(text: string | null | undefined): boolean;
/** Whether a blocked delivery's reason is a usage-limit hold the daemon wrote. */
export function isUsageLimitPauseDetail(text: string | null | undefined): boolean;
