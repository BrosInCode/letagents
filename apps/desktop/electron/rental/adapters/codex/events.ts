import type { CodexUsageTotals, ParsedCodexUsageEvent } from "./types.js";

interface UsageCandidate {
  totals: CodexUsageTotals;
  cumulative: boolean;
}

export function parseUsageEvents(text: string): ParsedCodexUsageEvent[] {
  const events: ParsedCodexUsageEvent[] = [];
  let latestModel: string | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const model = readModel(entry);
    if (model) latestModel = model;
    const event = parseTokenCountEvent(entry, latestModel);
    if (event) events.push(event);
  }

  return events;
}

function parseTokenCountEvent(entry: unknown, latestModel: string | null): ParsedCodexUsageEvent | null {
  if (!isObject(entry)) return null;
  const payload = isObject(entry.payload) ? entry.payload : null;
  const info = payload && isObject(payload.info) ? payload.info : null;
  const eventType = stringValue(payload?.type) ?? stringValue(entry.type);
  const candidates = collectUsageCandidates(entry, payload, info);
  if (candidates.length === 0) return null;
  if (
    eventType
    && eventType !== "token_count"
    && eventType !== "token_usage"
    && candidates.every((candidate) => candidate.cumulative)
  ) {
    return null;
  }

  const delta = candidates.find((candidate) => !candidate.cumulative) ?? null;
  const cumulative = candidates.find((candidate) => candidate.cumulative) ?? null;
  const selected = delta ?? cumulative;
  if (!selected) return null;

  return {
    timestamp: readTimestamp(entry),
    model: readModel(entry) ?? latestModel,
    ...selected.totals,
    isCumulative: selected.cumulative && !delta,
    cumulativeTotals: cumulative?.totals ?? null,
    rateLimits: readRateLimits(entry),
  };
}

function collectUsageCandidates(
  entry: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  info: Record<string, unknown> | null,
): UsageCandidate[] {
  const candidates: UsageCandidate[] = [];
  for (const container of [info, payload, entry]) {
    if (!container) continue;
    pushNestedUsage(
      candidates,
      container,
      ["last_token_usage", "lastTokenUsage", "delta", "usage_delta", "usageDelta"],
      false,
    );
    pushNestedUsage(candidates, container, ["total_token_usage", "totalTokenUsage"], true);
    pushNestedUsage(candidates, container, ["usage", "token_usage", "tokenUsage"], false);
    const direct = parseTotals(container);
    if (direct) candidates.push({ totals: direct, cumulative: false });
  }
  return candidates;
}

function pushNestedUsage(
  out: UsageCandidate[],
  container: Record<string, unknown>,
  keys: string[],
  cumulative: boolean,
): void {
  for (const key of keys) {
    const nested = container[key];
    if (!isObject(nested)) continue;
    const totals = parseTotals(nested);
    if (totals) out.push({ totals, cumulative });
  }
}

function parseTotals(value: Record<string, unknown>): CodexUsageTotals | null {
  const totals = {
    inputTokens: numberFromNames(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"]),
    outputTokens: numberFromNames(value, [
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "completionTokens",
      "output",
    ]),
    cacheCreationTokens: numberFromNames(value, [
      "cache_creation_input_tokens",
      "cache_creation_tokens",
      "cacheCreationInputTokens",
      "cacheCreationTokens",
    ]),
    cacheReadTokens: numberFromNames(value, [
      "cache_read_input_tokens",
      "cached_input_tokens",
      "cacheReadInputTokens",
      "cacheReadTokens",
      "cachedInputTokens",
      "cachedTokens",
    ]),
    reasoningTokens: numberFromNames(value, [
      "reasoning_tokens",
      "reasoningTokens",
      "reasoning_output_tokens",
      "reasoningOutputTokens",
    ]),
  };
  return Object.values(totals).some((count) => count > 0) ? totals : null;
}

function readModel(entry: unknown): string | null {
  if (!isObject(entry)) return null;
  const payload = isObject(entry.payload) ? entry.payload : null;
  const info = payload && isObject(payload.info) ? payload.info : null;
  return stringValue(entry.model)
    ?? stringValue(payload?.model)
    ?? stringValue(info?.model);
}

function readTimestamp(entry: Record<string, unknown>): string | null {
  const payload = isObject(entry.payload) ? entry.payload : null;
  return stringValue(entry.timestamp) ?? stringValue(payload?.timestamp);
}

function readRateLimits(entry: Record<string, unknown>): Record<string, unknown> | null {
  const payload = isObject(entry.payload) ? entry.payload : null;
  const raw = payload?.rate_limits ?? payload?.rateLimits ?? entry.rate_limits ?? entry.rateLimits;
  return isObject(raw) ? raw : null;
}

function numberFromNames(value: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const raw = value[name];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
  }
  return 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
