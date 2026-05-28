import type { AdapterUsageDelta } from "../../adapter-types.js";
import type { CodexUsageTotals, ParsedCodexUsageEvent } from "./types.js";

export function sumUsageEvents(events: ParsedCodexUsageEvent[]): CodexUsageTotals {
  const totals = emptyTotals();
  for (const event of events) {
    const cumulative = event.cumulativeTotals ?? (event.isCumulative ? eventTotals(event) : null);
    if (cumulative) {
      totals.inputTokens = cumulative.inputTokens;
      totals.outputTokens = cumulative.outputTokens;
      totals.cacheCreationTokens = cumulative.cacheCreationTokens;
      totals.cacheReadTokens = cumulative.cacheReadTokens;
      totals.reasoningTokens = cumulative.reasoningTokens;
      continue;
    }
    totals.inputTokens += event.inputTokens;
    totals.outputTokens += event.outputTokens;
    totals.cacheCreationTokens += event.cacheCreationTokens;
    totals.cacheReadTokens += event.cacheReadTokens;
    totals.reasoningTokens += event.reasoningTokens;
  }
  return totals;
}

export function readUsageDeltaFromEvents(events: ParsedCodexUsageEvent[]): AdapterUsageDelta {
  const totals = sumUsageDeltas(events);
  return usageDeltaFromTotals(totals);
}

export function emptyDelta(): AdapterUsageDelta {
  return usageDeltaFromTotals(emptyTotals());
}

export function latestRateLimits(events: ParsedCodexUsageEvent[]): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const rateLimits = events[index]?.rateLimits;
    if (rateLimits) return rateLimits;
  }
  return null;
}

function sumUsageDeltas(events: ParsedCodexUsageEvent[]): CodexUsageTotals {
  const totals = emptyTotals();
  let sawDelta = false;
  for (const event of events) {
    if (event.isCumulative) continue;
    sawDelta = true;
    totals.inputTokens += event.inputTokens;
    totals.outputTokens += event.outputTokens;
    totals.cacheCreationTokens += event.cacheCreationTokens;
    totals.cacheReadTokens += event.cacheReadTokens;
    totals.reasoningTokens += event.reasoningTokens;
  }
  return sawDelta ? totals : sumUsageEvents(events);
}

function usageDeltaFromTotals(totals: CodexUsageTotals): AdapterUsageDelta {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheReadTokens: totals.cacheReadTokens,
    reasoningTokens: totals.reasoningTokens,
    requests: 0,
    credits: 0,
    usd: 0,
    toolCalls: 0,
    commandRuns: 0,
    filesExposed: 0,
    heartbeats: 0,
  };
}

function eventTotals(event: ParsedCodexUsageEvent): CodexUsageTotals {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    cacheReadTokens: event.cacheReadTokens,
    reasoningTokens: event.reasoningTokens,
  };
}

function emptyTotals(): CodexUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
}
