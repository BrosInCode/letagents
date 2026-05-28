/**
 * Codex meter adapter (desktop-local).
 *
 * Reads local Codex session JSONL logs from `~/.codex/sessions` and
 * produces normalized quota snapshots / usage deltas for the shared
 * adapter runtime. Codex emits token-count events locally, so the
 * adapter can report `local_exact` token usage when those events are
 * present.
 */

import { basename } from "node:path";

import {
  computeAdapterLrt,
  type AdapterCalibrationHistory,
  type AdapterLrtEstimate,
  type AdapterMeterSource,
  type AdapterNativeQuotaSnapshot,
  type AdapterRentalMeterScope,
  type AdapterUsageDelta,
  type DesktopMeterAdapter,
} from "../adapter-types.js";
import {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER,
  DEFAULT_MAX_DISCOVERED_FILES,
  DEFAULT_MAX_DISCOVERY_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
} from "./codex/constants.js";
import {
  defaultCodexSessionsDir,
  discoverCodexJsonlFiles,
  readSessionTail,
} from "./codex/files.js";
import { parseUsageEvents } from "./codex/events.js";
import {
  emptyDelta,
  latestRateLimits,
  sumUsageEvents,
} from "./codex/totals.js";
import type {
  CodexAdapterOptions,
  CodexUsageTotals,
  ParsedCodexUsageEvent,
} from "./codex/types.js";

export {
  CODEX_CAPABILITIES,
  CODEX_PROVIDER,
} from "./codex/constants.js";
export { defaultCodexSessionsDir } from "./codex/files.js";
export {
  readUsageDeltaFromEvents,
  sumUsageEvents,
} from "./codex/totals.js";
export type {
  CodexAdapterOptions,
  CodexUsageTotals,
  ParsedCodexUsageEvent,
} from "./codex/types.js";

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
    const files = await discoverCodexJsonlFiles(roots, this.options.maxDiscoveryDepth);

    return files
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
    // `scope.sessionId` / `scope.workspaceMarker`. This slice only
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
