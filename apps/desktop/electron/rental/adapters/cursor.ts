/**
 * Cursor meter adapter (desktop-local).
 *
 * Cursor exposes its premium usage + per-model request counts +
 * dollar spend via a local usage snapshot. The exact on-disk
 * format isn't a stable public contract, so this adapter parses
 * a small superset that covers the shape we know about (premium
 * requests used / total, cents spent / cents limit, per-model
 * breakdown, billing cycle reset).
 *
 * Capabilities:
 *   • supportsExact         : false  (request-based, not token-based)
 *   • supportsLaneRecovery  : true   (billing cycle reset is a clean
 *                                     refresh signal)
 *   • supportsTier2Continuity: false (Cursor does not expose a
 *                                     conversation transcript file
 *                                     in V1)
 *
 * Confidence: `estimated` until session calibration history maps
 * "premium request" → LRT for the active model. Upgrades to
 * `calibrated` after enough samples (mirrors the Antigravity
 * adapter's behaviour).
 *
 * Spec §17.4 (request-based calibration), §17.6 (launch adapter
 * table — Cursor row), §17.7 (MeterAdapter contract).
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.7 (reader slice).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import {
  type AdapterCalibrationHistory,
  type AdapterCapabilities,
  type AdapterLrtEstimate,
  type AdapterMeterSource,
  type AdapterNativeQuotaSnapshot,
  type AdapterRentalMeterScope,
  type AdapterUsageDelta,
  type DesktopMeterAdapter,
} from "../adapter-types.js";

/** Provider key. Matches `DesktopRentalIdeKind` "cursor". */
export const CURSOR_PROVIDER = "cursor";

export const CURSOR_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsExact: false,
  supportsLaneRecovery: true,
  supportsTier2Continuity: false,
});

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

export interface CursorPremiumUsage {
  requestsUsed: number;
  requestsTotal: number | null;
  model: string | null;
}

export interface CursorSpend {
  centsUsed: number;
  centsLimit: number | null;
}

export interface CursorBillingCycle {
  startedAt: string | null;
  resetsAt: string | null;
}

export interface CursorPerModelEntry {
  model: string;
  requestsUsed: number;
  centsUsed: number;
}

export interface CursorUsageDocument {
  version: number;
  observedAt: string | null;
  billingCycle: CursorBillingCycle | null;
  premium: CursorPremiumUsage | null;
  spend: CursorSpend | null;
  byModel: CursorPerModelEntry[];
}

// ---------------------------------------------------------------------------
// Defaults / paths
// ---------------------------------------------------------------------------

export interface CursorAdapterOptions {
  homeDirOverride?: string;
  /** Extra absolute paths to consider as usage snapshots. */
  additionalPaths?: string[];
  /**
   * Restrict snapshots to a subset of model labels. When empty, all
   * models in the by_model breakdown are eligible; readNativeQuota
   * picks the per-model row with the highest `requestsUsed` (the
   * one most likely to be the active lane).
   */
  modelFilter?: string[];
  /** Maximum file size to read (default 512 KiB). */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export function defaultCursorUsagePaths(homeOverride?: string): string[] {
  const home = homeOverride ?? homedir();
  const plat = platform();
  if (plat === "darwin") {
    return [
      join(home, "Library", "Application Support", "Cursor", "usage.json"),
      join(home, ".cursor", "usage.json"),
    ];
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(appData, "Cursor", "usage.json"),
      join(home, ".cursor", "usage.json"),
    ];
  }
  return [
    join(home, ".config", "Cursor", "usage.json"),
    join(home, ".cursor", "usage.json"),
  ];
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parsePremium(raw: unknown): CursorPremiumUsage | null {
  if (!isObject(raw)) return null;
  const requestsUsed = parseFiniteNumber(
    raw.requests_used ?? raw.requestsUsed,
  );
  if (requestsUsed === null || requestsUsed < 0) return null;
  return {
    requestsUsed,
    requestsTotal: parseFiniteNumber(
      raw.requests_total ?? raw.requestsTotal,
    ),
    model: parseNonEmptyString(raw.model),
  };
}

function parseSpend(raw: unknown): CursorSpend | null {
  if (!isObject(raw)) return null;
  const centsUsed = parseFiniteNumber(raw.cents_used ?? raw.centsUsed);
  if (centsUsed === null || centsUsed < 0) return null;
  return {
    centsUsed,
    centsLimit: parseFiniteNumber(raw.cents_limit ?? raw.centsLimit),
  };
}

function parseBillingCycle(raw: unknown): CursorBillingCycle | null {
  if (!isObject(raw)) return null;
  const startedAt = parseNonEmptyString(raw.started_at ?? raw.startedAt);
  const resetsAt = parseNonEmptyString(raw.resets_at ?? raw.resetsAt);
  if (startedAt === null && resetsAt === null) return null;
  return { startedAt, resetsAt };
}

function parseByModel(raw: unknown): CursorPerModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CursorPerModelEntry[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const model = parseNonEmptyString(entry.model);
    if (!model) continue;
    const requestsUsed = parseFiniteNumber(
      entry.requests_used ?? entry.requestsUsed,
    );
    const centsUsed = parseFiniteNumber(entry.cents_used ?? entry.centsUsed);
    out.push({
      model,
      requestsUsed: requestsUsed !== null && requestsUsed >= 0 ? requestsUsed : 0,
      centsUsed: centsUsed !== null && centsUsed >= 0 ? centsUsed : 0,
    });
  }
  return out;
}

export function parseCursorUsageDocument(
  raw: unknown,
): CursorUsageDocument | null {
  if (!isObject(raw)) return null;
  const versionRaw = parseFiniteNumber(raw.version);
  if (versionRaw === null) return null;
  return {
    version: versionRaw,
    observedAt: parseNonEmptyString(raw.observed_at ?? raw.observedAt),
    billingCycle: parseBillingCycle(raw.billing_cycle ?? raw.billingCycle),
    premium: parsePremium(raw.premium),
    spend: parseSpend(raw.spend),
    byModel: parseByModel(raw.by_model ?? raw.byModel),
  };
}

/**
 * Pick the per-model row most likely to represent the active lane.
 * Tie-breaker: lexicographic model name for determinism.
 *
 * Exported for tests + future per-session lane selection.
 */
export function pickPrimaryModel(
  byModel: CursorPerModelEntry[],
): CursorPerModelEntry | null {
  if (byModel.length === 0) return null;
  let best = byModel[0]!;
  for (let i = 1; i < byModel.length; i++) {
    const cur = byModel[i]!;
    if (
      cur.requestsUsed > best.requestsUsed
      || (cur.requestsUsed === best.requestsUsed && cur.model < best.model)
    ) {
      best = cur;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CursorAdapter implements DesktopMeterAdapter {
  readonly provider = CURSOR_PROVIDER;
  readonly capabilities = CURSOR_CAPABILITIES;

  private readonly options: Required<CursorAdapterOptions>;

  constructor(options: CursorAdapterOptions = {}) {
    this.options = {
      homeDirOverride: options.homeDirOverride ?? "",
      additionalPaths: options.additionalPaths ?? [],
      modelFilter: options.modelFilter ?? [],
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    };
  }

  async discoverSources(): Promise<AdapterMeterSource[]> {
    const candidates = [
      ...this.options.additionalPaths,
      ...defaultCursorUsagePaths(this.options.homeDirOverride || undefined),
    ];
    const seen = new Set<string>();
    const sources: AdapterMeterSource[] = [];
    for (const path of candidates) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      sources.push({
        id: `cursor-usage:${path}`,
        label: `Cursor usage at ${path}`,
        kind: "json",
        pathHint: path,
        lastSeenAt: new Date().toISOString(),
      });
    }
    return sources;
  }

  async readNativeQuota(
    source: AdapterMeterSource,
  ): Promise<AdapterNativeQuotaSnapshot | null> {
    if (source.kind !== "json" || !source.pathHint) return null;
    const doc = await this.parseUsageFile(source.pathHint);
    if (!doc) return null;
    const eligibleByModel = this.filterByModel(doc.byModel);
    const primary = pickPrimaryModel(eligibleByModel);

    // Prefer the per-model row as the "active lane" model when
    // we have one; fall back to the top-level premium model.
    const model = primary?.model ?? doc.premium?.model ?? null;

    // Use premium request counts as the native unit when present.
    // Cursor's UI exposes it as the user's primary budget signal.
    const premium = doc.premium;
    const nativeRemaining = premium && premium.requestsTotal !== null
      ? Math.max(0, premium.requestsTotal - premium.requestsUsed)
      : null;
    const nativeTotal = premium?.requestsTotal ?? null;
    return {
      provider: this.provider,
      model,
      sourceId: source.id,
      nativeUnit: "requests",
      nativeRemaining,
      nativeTotal,
      nativeResetAt: doc.billingCycle?.resetsAt ?? null,
      confidence: "estimated",
      observedAt: doc.observedAt ?? new Date().toISOString(),
      raw: {
        primaryModel: primary,
        premium,
        spend: doc.spend,
        billingCycle: doc.billingCycle,
        allModels: eligibleByModel.map((m) => ({ ...m })),
      },
    };
  }

  async readUsageDelta(scope: AdapterRentalMeterScope): Promise<AdapterUsageDelta> {
    // Like Antigravity, Cursor does not expose per-turn token logs
    // we can attribute to a rental scope. The server reconstructs
    // request consumption from successive snapshots (delta in
    // requests_used) × calibrated lrt-per-request.
    void scope;
    return emptyDelta();
  }

  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate {
    const remaining = snapshot.nativeRemaining;
    const total = snapshot.nativeTotal;
    const lrtPerFullWindow = history.lrtPerFullWindow;

    // Same overcharge concern as the Antigravity adapter — `lrtUsed`
    // is summed server-side as a delta, so report 0 here until a
    // server-side reconciler (planned alongside p2.6c finishing the
    // bridge) converts successive snapshots into real deltas.
    if (
      lrtPerFullWindow === null
      || lrtPerFullWindow <= 0
      || total === null
      || total <= 0
      || remaining === null
      || !Number.isFinite(remaining)
    ) {
      return {
        lrtUsed: 0,
        lrtRemaining: null,
        confidence: snapshot.confidence,
      };
    }

    const fractionRemaining = Math.min(1, Math.max(0, remaining / total));
    const lrtRemaining = lrtPerFullWindow * fractionRemaining;

    const upgraded: AdapterLrtEstimate["confidence"] =
      history.sampleCount >= 10 ? "calibrated" : snapshot.confidence;

    return {
      lrtUsed: 0,
      lrtRemaining,
      confidence: upgraded,
    };
  }

  async parseUsageFile(path: string): Promise<CursorUsageDocument | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    if (text.length > this.options.maxFileBytes) {
      text = text.slice(0, this.options.maxFileBytes);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    return parseCursorUsageDocument(raw);
  }

  private filterByModel(byModel: CursorPerModelEntry[]): CursorPerModelEntry[] {
    if (this.options.modelFilter.length === 0) return byModel;
    const allowed = new Set(this.options.modelFilter);
    return byModel.filter((m) => allowed.has(m.model));
  }
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
