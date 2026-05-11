/**
 * Claude Code meter adapter (desktop-local).
 *
 * Reads local Claude Code session logs (JSONL files where each line is
 * an assistant/user turn record with token usage on assistant lines) and
 * produces normalized `AdapterNativeQuotaSnapshot` / `AdapterUsageDelta`
 * / `AdapterLrtEstimate` values for the adapter runtime.
 *
 * Claude Code emits exact input/output/cache/reasoning token counts
 * locally per turn, so this adapter's confidence is `local_exact`.
 *
 * This file is part of p2.3a (PR for task_6) and intentionally does
 * NOT touch IPC types, preload, or main — those wire up in p2.3b once
 * p2.2 (server-side ingest endpoint) is on staging.
 *
 * Spec §17.6 (Claude Code in the launch adapter table) + §17.7
 * (MeterAdapter contract) + §17.8 (rental scope attribution).
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/**
 * Provider key for this adapter. Matches `DesktopRentalIdeKind` ("claude_code")
 * and the `listing.ide_kind` value used elsewhere.
 */
export const CLAUDE_CODE_PROVIDER = "claude_code";

/**
 * Capabilities the Claude Code adapter advertises in the readiness payload.
 *
 * - exact: yes — local JSONL gives per-turn token counts.
 * - lane recovery: no for now — Claude Code does not expose a clean
 *   "lane refreshed" signal in the local log. (Future: the adapter may
 *   infer it from observed quota dropping then rising. Not in p2.3a.)
 * - Tier 2 continuity: yes — we can replay the last N assistant turns
 *   as adapter local capture per spec §8.5. The actual capture function
 *   lands in p4.6.
 */
export const CLAUDE_CODE_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsExact: true,
  supportsLaneRecovery: false,
  supportsTier2Continuity: true,
});

/**
 * Shape of one assistant turn we care about. Many other fields exist
 * on the line; we only require these.
 *
 * Note: real Claude Code JSONL entries put the model identifier on
 * `message.model`, not on the top-level entry. Some local tooling and
 * earlier formats expose it at `turn.model`. We accept either,
 * preferring the top-level value when both are present.
 */
interface ClaudeCodeAssistantTurn {
  type: "assistant";
  timestamp?: string;
  model?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      reasoning_tokens?: number;
    };
  };
}

interface ParsedTurn {
  timestamp: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

/**
 * Discover candidate JSONL session logs. Claude Code writes them to
 * `~/.claude/projects/<project-slug>/<session-id>.jsonl` on macOS/Linux.
 *
 * In p2.3a we keep this lightweight: we return any file the caller
 * passed in via the explicit `additionalPaths` option, plus the default
 * Claude Code directory if it exists. The real recursive discovery
 * (per-project) lands in p2.3b or later as needed.
 */
export interface ClaudeCodeAdapterOptions {
  /** Override the default Claude Code data directory (mainly for tests). */
  homeDirOverride?: string;
  /** Extra absolute paths to consider as sources. */
  additionalPaths?: string[];
  /**
   * Maximum number of bytes to read from any one JSONL file. Caps
   * memory if a runaway session log grows unbounded; default 32 MiB.
   */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

export function defaultClaudeCodeDataDir(homeOverride?: string): string {
  return join(homeOverride ?? homedir(), ".claude", "projects");
}

export class ClaudeCodeAdapter implements DesktopMeterAdapter {
  readonly provider = CLAUDE_CODE_PROVIDER;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;

  private readonly options: Required<ClaudeCodeAdapterOptions>;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.options = {
      homeDirOverride: options.homeDirOverride ?? "",
      additionalPaths: options.additionalPaths ?? [],
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    };
  }

  async discoverSources(): Promise<AdapterMeterSource[]> {
    const sources: AdapterMeterSource[] = [];
    for (const path of this.options.additionalPaths) {
      if (!existsSync(path)) continue;
      sources.push({
        id: `jsonl:${path}`,
        label: `Claude Code session at ${path}`,
        kind: "jsonl",
        pathHint: path,
        lastSeenAt: new Date().toISOString(),
      });
    }
    return sources;
  }

  async readNativeQuota(source: AdapterMeterSource): Promise<AdapterNativeQuotaSnapshot | null> {
    if (source.kind !== "jsonl" || !source.pathHint) return null;
    const turns = await this.parseSessionFile(source.pathHint);
    if (turns.length === 0) return null;
    const totals = sumTurns(turns);
    const last = turns[turns.length - 1];
    return {
      provider: this.provider,
      model: last.model,
      sourceId: source.id,
      nativeUnit: "tokens",
      // Claude Code's local JSONL records *consumption*, not a remaining
      // window. The server side computes remaining from this snapshot
      // plus calibration history. For the snapshot itself we encode the
      // totals consumed in this session in `raw`.
      nativeRemaining: null,
      nativeTotal: null,
      nativeResetAt: null,
      confidence: "local_exact",
      observedAt: new Date().toISOString(),
      raw: {
        turnCount: turns.length,
        totals,
        lastTurnAt: last.timestamp,
      },
    };
  }

  async readUsageDelta(scope: AdapterRentalMeterScope): Promise<AdapterUsageDelta> {
    // p2.3a does not implement per-rental scope attribution. The
    // intended flow (lands in p2.3b alongside p2.2 ingest) is:
    // the adapter persists a cursor offset per rental session and only
    // reports turns appended since the cursor advanced. Until then,
    // callers should treat this as zero-delta and rely on
    // {@link readUsageDeltaFromTurns} for tests.
    void scope;
    return emptyDelta();
  }

  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate {
    const totals = (snapshot.raw as { totals?: ReturnType<typeof sumTurns> }).totals;
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

  /**
   * Helper for tests and Tier 2 continuity capture (p4.6): parse the
   * session file into an in-memory list of turns.
   */
  async parseSessionFile(path: string): Promise<ParsedTurn[]> {
    const text = await readFile(path, "utf8");
    if (text.length > this.options.maxFileBytes) {
      // We only read up to the configured cap; truncate from the start
      // so the most recent turns are kept (they're at the end).
      const truncated = text.slice(text.length - this.options.maxFileBytes);
      return parseTurns(truncated);
    }
    return parseTurns(text);
  }
}

/** Sum token totals across parsed turns. Exported for tests. */
export function sumTurns(turns: ParsedTurn[]): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
} {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
  for (const turn of turns) {
    totals.inputTokens += turn.inputTokens;
    totals.outputTokens += turn.outputTokens;
    totals.cacheCreationTokens += turn.cacheCreationTokens;
    totals.cacheReadTokens += turn.cacheReadTokens;
    totals.reasoningTokens += turn.reasoningTokens;
  }
  return totals;
}

/** Produce a {@link AdapterUsageDelta} from a contiguous slice of turns. */
export function readUsageDeltaFromTurns(turns: ParsedTurn[]): AdapterUsageDelta {
  const totals = sumTurns(turns);
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

function parseTurns(text: string): ParsedTurn[] {
  const out: ParsedTurn[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines rather than throwing — Claude Code session
      // logs can have a partial trailing line during an active session.
      continue;
    }
    const parsed = parseAssistantTurn(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseAssistantTurn(entry: unknown): ParsedTurn | null {
  if (!isObject(entry)) return null;
  if (entry.type !== "assistant") return null;
  const turn = entry as unknown as ClaudeCodeAssistantTurn;
  const usage = turn.message?.usage;
  if (!usage) return null;
  // Prefer top-level `turn.model` (legacy / our test fixture) but fall
  // back to `turn.message.model` which is where real Claude Code JSONL
  // entries put it. Either way, end up with `string | null`.
  const topLevelModel = typeof turn.model === "string" ? turn.model : null;
  const messageModel = typeof turn.message?.model === "string" ? turn.message.model : null;
  return {
    timestamp: typeof turn.timestamp === "string" ? turn.timestamp : null,
    model: topLevelModel ?? messageModel,
    inputTokens: numberOr(usage.input_tokens, 0),
    outputTokens: numberOr(usage.output_tokens, 0),
    cacheCreationTokens: numberOr(usage.cache_creation_input_tokens, 0),
    cacheReadTokens: numberOr(usage.cache_read_input_tokens, 0),
    reasoningTokens: numberOr(usage.reasoning_tokens, 0),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
