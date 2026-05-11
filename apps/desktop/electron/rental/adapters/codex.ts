/**
 * Codex meter adapter (desktop-local).
 *
 * Reads local Codex session JSONL logs from `~/.codex/sessions` and
 * produces normalized quota snapshots / usage deltas for the shared
 * adapter runtime. Codex emits token-count events locally, so the
 * adapter can report `local_exact` token usage when those events are
 * present.
 *
 * This slice intentionally mirrors the Claude Code adapter shape and
 * does not wire IPC/main registration yet. Runtime wiring lands in the
 * later desktop integration slice.
 */

import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  computeAdapterLrt,
  type AdapterCalibrationHistory,
  type AdapterCapabilities,
  type AdapterLrtEstimate,
  type AdapterMeterSource,
  type AdapterNativeQuotaSnapshot,
  type AdapterRentalMeterScope,
  type AdapterUsageDelta,
  type DesktopMeterAdapter,
} from "../adapter-types.js";

/** Provider key matching `DesktopRentalIdeKind`. */
export const CODEX_PROVIDER = "codex";

export const CODEX_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsExact: true,
  supportsLaneRecovery: false,
  supportsTier2Continuity: true,
});

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

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DISCOVERED_FILES = 25;
const DEFAULT_MAX_DISCOVERY_DEPTH = 5;

export function defaultCodexSessionsDir(homeOverride?: string): string {
  return join(homeOverride ?? homedir(), ".codex", "sessions");
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

interface DiscoveredCodexFile {
  path: string;
  mtimeMs: number;
}

interface UsageCandidate {
  totals: CodexUsageTotals;
  cumulative: boolean;
}

export class CodexAdapter implements DesktopMeterAdapter {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly options: Required<CodexAdapterOptions>;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      homeDirOverride: options.homeDirOverride ?? "",
      additionalPaths: options.additionalPaths ?? [],
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxDiscoveredFiles: options.maxDiscoveredFiles ?? DEFAULT_MAX_DISCOVERED_FILES,
      maxDiscoveryDepth: options.maxDiscoveryDepth ?? DEFAULT_MAX_DISCOVERY_DEPTH,
    };
  }

  async discoverSources(): Promise<AdapterMeterSource[]> {
    const roots = [
      ...this.options.additionalPaths,
      defaultCodexSessionsDir(this.options.homeDirOverride || undefined),
    ];
    const byPath = new Map<string, DiscoveredCodexFile>();

    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const file of await discoverJsonlFiles(root, this.options.maxDiscoveryDepth)) {
        byPath.set(file.path, file);
      }
    }

    return Array.from(byPath.values())
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
      .slice(0, this.options.maxDiscoveredFiles)
      .map((file) => ({
        id: `jsonl:${file.path}`,
        label: `Codex session ${basename(file.path)}`,
        kind: "jsonl" as const,
        pathHint: file.path,
        lastSeenAt: new Date(file.mtimeMs).toISOString(),
      }));
  }

  async readNativeQuota(source: AdapterMeterSource): Promise<AdapterNativeQuotaSnapshot | null> {
    if (source.kind !== "jsonl" || !source.pathHint) return null;
    const events = await this.parseSessionFile(source.pathHint);
    if (events.length === 0) return null;
    const totals = sumUsageEvents(events);
    const last = events[events.length - 1];
    return {
      provider: this.provider,
      model: last.model,
      sourceId: source.id,
      nativeUnit: "tokens",
      nativeRemaining: null,
      nativeTotal: null,
      nativeResetAt: null,
      confidence: "local_exact",
      observedAt: new Date().toISOString(),
      raw: {
        eventCount: events.length,
        totals,
        lastEventAt: last.timestamp,
        lastRateLimits: latestRateLimits(events),
      },
    };
  }

  async readUsageDelta(scope: AdapterRentalMeterScope): Promise<AdapterUsageDelta> {
    // Per-rental scope attribution needs a persisted cursor keyed by
    // `scope.sessionId` / `scope.workspaceMarker`. This p2.4 slice only
    // exposes the parser and quota snapshot reader; the scheduler should
    // treat scoped deltas as zero until cursor persistence lands.
    void scope;
    return emptyDelta();
  }

  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate {
    const totals = (snapshot.raw as { totals?: CodexUsageTotals }).totals;
    if (!totals) {
      return { lrtUsed: 0, lrtRemaining: null, confidence: snapshot.confidence };
    }
    const lrtUsed = computeAdapterLrt({
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
    });
    const remaining = history.lrtPerFullWindow !== null
      ? Math.max(0, history.lrtPerFullWindow - lrtUsed)
      : null;
    return {
      lrtUsed,
      lrtRemaining: remaining,
      confidence: snapshot.confidence,
    };
  }

  async parseSessionFile(path: string): Promise<ParsedCodexUsageEvent[]> {
    return parseUsageEvents(await readSessionTail(path, this.options.maxFileBytes));
  }
}

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

function emptyDelta(): AdapterUsageDelta {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    credits: 0,
    usd: 0,
    toolCalls: 0,
    commandRuns: 0,
    filesExposed: 0,
    heartbeats: 0,
  };
}

function latestRateLimits(events: ParsedCodexUsageEvent[]): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const rateLimits = events[index]?.rateLimits;
    if (rateLimits) return rateLimits;
  }
  return null;
}

function parseUsageEvents(text: string): ParsedCodexUsageEvent[] {
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
  if (eventType && eventType !== "token_count" && eventType !== "token_usage" && candidates.every((c) => c.cumulative)) {
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
    pushNestedUsage(candidates, container, ["last_token_usage", "lastTokenUsage", "delta", "usage_delta", "usageDelta"], false);
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
    outputTokens: numberFromNames(value, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output"]),
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

async function readSessionTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  if (fileStat.size <= maxBytes) return readFile(path, "utf8");

  const handle = await open(path, "r");
  try {
    const start = Math.max(0, fileStat.size - maxBytes);
    const buffer = Buffer.alloc(fileStat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function discoverJsonlFiles(path: string, depth: number): Promise<DiscoveredCodexFile[]> {
  const pathStat = await stat(path);
  if (pathStat.isFile()) {
    return path.endsWith(".jsonl") ? [{ path, mtimeMs: pathStat.mtimeMs }] : [];
  }
  if (!pathStat.isDirectory()) return [];
  const files: DiscoveredCodexFile[] = [];
  await walkJsonlFiles(path, depth, files);
  return files;
}

async function walkJsonlFiles(
  dir: string,
  depth: number,
  out: DiscoveredCodexFile[],
): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonlFiles(path, depth - 1, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const fileStat = await stat(path);
      out.push({ path, mtimeMs: fileStat.mtimeMs });
    } catch {
      // Source discovery is best-effort. A live Codex process can rotate
      // or remove a file between readdir and stat.
    }
  }
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
