/**
 * Antigravity meter adapter (desktop-local).
 *
 * Antigravity exposes its rate-limit state as a `percent_window` value
 * per model-lane plus a reset timestamp. The local snapshot lives in a
 * JSON sidecar that the IDE keeps up to date as you use it. There is no
 * exact per-turn token log available locally, so this adapter's
 * confidence is `estimated` (upgrading to `calibrated` once the server
 * has enough history to map percent-window → LRT for the user's lane).
 *
 * Capabilities advertised:
 *
 *   • supportsExact         : false  (only percent_window)
 *   • supportsLaneRecovery  : true   (per-lane reset_at + delta-style
 *                                     `percent_remaining` is exactly the
 *                                     signal D4 watches for; the
 *                                     server-side `lane-recovery.ts`
 *                                     service consumes those snapshots).
 *   • supportsTier2Continuity: false (Antigravity does not expose a
 *                                     local conversation transcript in
 *                                     V1; Tier 2 continuity capture
 *                                     can be added later).
 *
 * The adapter is intentionally schema-agnostic at the file boundary:
 * it accepts any JSON document with the shape
 *
 *     {
 *       version: number,
 *       observed_at?: string,
 *       lanes: Array<{
 *         lane_id: string,
 *         model: string | null,
 *         percent_remaining: number,       // 0..1
 *         reset_at?: string | null,        // ISO timestamp
 *         last_event_at?: string | null,
 *       }>
 *     }
 *
 * so the parser does not need to track every Antigravity IDE version.
 *
 * Spec §17.4 (percent-window calibration), §17.6 (launch adapter
 * table), §17.7 (MeterAdapter contract). D4 lane-recovery in
 * `src/api/rental/lane-recovery.ts` (separate slice).
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.5 (adapter side).
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

/** Provider key. Matches the `DesktopRentalIdeKind` "antigravity". */
export const ANTIGRAVITY_PROVIDER = "antigravity";

export const ANTIGRAVITY_CAPABILITIES: AdapterCapabilities = Object.freeze({
  supportsExact: false,
  supportsLaneRecovery: true,
  supportsTier2Continuity: false,
});

/** Lane row inside an Antigravity quota.json file. */
export interface AntigravityLane {
  laneId: string;
  model: string | null;
  displayName: string | null;
  percentRemaining: number;
  resetAt: string | null;
  lastEventAt: string | null;
}

export interface AntigravityQuotaDocument {
  version: number;
  observedAt: string | null;
  lanes: AntigravityLane[];
}

export interface AntigravityAdapterOptions {
  /** Override the home dir for tests. */
  homeDirOverride?: string;
  /** Extra absolute paths to consider as quota documents. */
  additionalPaths?: string[];
  /**
   * Restrict snapshot reads to a subset of lane ids. When empty, all
   * lanes in the source document are eligible; `readNativeQuota`
   * picks the lane with the most recent `last_event_at`. The caller
   * can pre-filter to a single user-selected model lane.
   */
  laneFilter?: string[];
  /** Maximum file size to read (default 1 MiB). */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;

/**
 * Return the default candidate paths for Antigravity's quota.json on
 * the current platform. We probe each and return only those that
 * exist; callers can supplement with {@link AntigravityAdapterOptions.additionalPaths}.
 */
export function defaultAntigravityQuotaPaths(homeOverride?: string): string[] {
  const home = homeOverride ?? homedir();
  const plat = platform();
  if (plat === "darwin") {
    return [
      join(home, "Library", "Application Support", "Antigravity", "quota.json"),
      join(home, ".antigravity", "quota.json"),
    ];
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(appData, "Antigravity", "quota.json"),
      join(home, ".antigravity", "quota.json"),
    ];
  }
  // linux / freebsd / etc.
  return [
    join(home, ".config", "antigravity", "quota.json"),
    join(home, ".antigravity", "quota.json"),
  ];
}

export class AntigravityAdapter implements DesktopMeterAdapter {
  readonly provider = ANTIGRAVITY_PROVIDER;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;

  private readonly options: Required<AntigravityAdapterOptions>;

  constructor(options: AntigravityAdapterOptions = {}) {
    this.options = {
      homeDirOverride: options.homeDirOverride ?? "",
      additionalPaths: options.additionalPaths ?? [],
      laneFilter: options.laneFilter ?? [],
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    };
  }

  async discoverSources(): Promise<AdapterMeterSource[]> {
    const candidates = [
      ...this.options.additionalPaths,
      ...defaultAntigravityQuotaPaths(this.options.homeDirOverride || undefined),
    ];
    const seen = new Set<string>();
    const sources: AdapterMeterSource[] = [];
    for (const path of candidates) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      sources.push({
        id: `antigravity-quota:${path}`,
        label: `Antigravity quota at ${path}`,
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
    const doc = await this.parseQuotaFile(source.pathHint);
    if (!doc) return null;
    const eligible = this.filterLanes(doc.lanes);
    if (eligible.length === 0) return null;
    const lane = pickPrimaryLane(eligible);
    return {
      provider: this.provider,
      model: lane.model,
      sourceId: source.id,
      nativeUnit: "percent_window",
      nativeRemaining: lane.percentRemaining,
      // The "native total" for a percent_window meter is always 1.0
      // (the full window). Encoding it makes downstream code that
      // computes a fraction trivial.
      nativeTotal: 1,
      nativeResetAt: lane.resetAt,
      confidence: "estimated",
      observedAt: doc.observedAt ?? new Date().toISOString(),
      raw: {
        laneId: lane.laneId,
        displayName: lane.displayName,
        lastEventAt: lane.lastEventAt,
        allLanes: eligible.map((l) => ({
          laneId: l.laneId,
          model: l.model,
          percentRemaining: l.percentRemaining,
          resetAt: l.resetAt,
          lastEventAt: l.lastEventAt,
        })),
      },
    };
  }

  async readUsageDelta(scope: AdapterRentalMeterScope): Promise<AdapterUsageDelta> {
    // Antigravity's percent_window doesn't expose per-turn tokens; the
    // server reconstructs LRT consumption from successive snapshots
    // (delta in percent_remaining × calibrated lrtPerFullWindow). We
    // therefore return a zero delta here. Scope is reserved for the
    // future case where Antigravity ships a richer local log.
    void scope;
    return emptyDelta();
  }

  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate {
    const percentRemaining = snapshot.nativeRemaining;
    const lrtPerFullWindow = history.lrtPerFullWindow;

    // Without calibration, we cannot project LRT remaining. The server
    // will fall back to its own confidence-bucket stop threshold and
    // refuse to admit the listing into the marketplace until a few
    // sessions calibrate the value.
    if (lrtPerFullWindow === null || lrtPerFullWindow <= 0) {
      return {
        lrtUsed: 0,
        lrtRemaining: null,
        confidence: snapshot.confidence,
      };
    }

    if (
      typeof percentRemaining !== "number"
      || !Number.isFinite(percentRemaining)
    ) {
      return {
        lrtUsed: 0,
        lrtRemaining: null,
        confidence: snapshot.confidence,
      };
    }

    const clamped = Math.min(1, Math.max(0, percentRemaining));
    const lrtRemaining = lrtPerFullWindow * clamped;
    const lrtUsed = lrtPerFullWindow * (1 - clamped);

    // Once we have enough calibration samples, we can upgrade the
    // confidence label from "estimated" to "calibrated" per §17.13.
    // The threshold is intentionally conservative (10 samples) so the
    // Budget Sentinel's stop threshold only loosens when the projection
    // is genuinely stable.
    const upgraded: AdapterLrtEstimate["confidence"] =
      history.sampleCount >= 10 ? "calibrated" : snapshot.confidence;

    return {
      lrtUsed,
      lrtRemaining,
      confidence: upgraded,
    };
  }

  /**
   * Parse one Antigravity quota.json. Tolerant: malformed or
   * version-mismatched files return null rather than throwing, so the
   * scheduler can move on without crashing the adapter runtime.
   */
  async parseQuotaFile(path: string): Promise<AntigravityQuotaDocument | null> {
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
    return parseQuotaDocument(raw);
  }

  private filterLanes(lanes: AntigravityLane[]): AntigravityLane[] {
    const filter = this.options.laneFilter;
    if (filter.length === 0) return lanes;
    const allowed = new Set(filter);
    return lanes.filter(
      (l) => allowed.has(l.laneId) || (l.model !== null && allowed.has(l.model)),
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests + the server-side lane-recovery slice)
// ---------------------------------------------------------------------------

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

/**
 * Lift a raw JSON object into the strict {@link AntigravityQuotaDocument}
 * shape. Returns null when the document is unrecognized.
 */
export function parseQuotaDocument(raw: unknown): AntigravityQuotaDocument | null {
  if (!isObject(raw)) return null;
  const versionRaw = (raw as { version?: unknown }).version;
  if (typeof versionRaw !== "number" || !Number.isFinite(versionRaw)) return null;
  const lanesRaw = (raw as { lanes?: unknown }).lanes;
  if (!Array.isArray(lanesRaw)) return null;

  const lanes: AntigravityLane[] = [];
  for (const entry of lanesRaw) {
    const parsed = parseLane(entry);
    if (parsed) lanes.push(parsed);
  }

  const observedRaw = (raw as { observed_at?: unknown }).observed_at;
  return {
    version: versionRaw,
    observedAt: typeof observedRaw === "string" ? observedRaw : null,
    lanes,
  };
}

function parseLane(entry: unknown): AntigravityLane | null {
  if (!isObject(entry)) return null;
  const laneIdRaw = entry.lane_id ?? entry.laneId;
  if (typeof laneIdRaw !== "string" || !laneIdRaw.trim()) return null;
  const percentRaw = entry.percent_remaining ?? entry.percentRemaining;
  if (typeof percentRaw !== "number" || !Number.isFinite(percentRaw)) return null;
  return {
    laneId: laneIdRaw.trim(),
    model:
      typeof entry.model === "string" && entry.model.trim()
        ? entry.model.trim()
        : null,
    displayName:
      typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : typeof entry.displayName === "string" && entry.displayName.trim()
          ? entry.displayName.trim()
          : null,
    percentRemaining: clamp01(percentRaw),
    resetAt: pickOptionalString(entry, "reset_at", "resetAt"),
    lastEventAt: pickOptionalString(entry, "last_event_at", "lastEventAt"),
  };
}

function pickOptionalString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pick the lane the snapshot should report on. Preference order:
 *   1. The lane with the most recent `lastEventAt` (active recently).
 *   2. The lane with the lowest `percentRemaining` (closest to
 *      exhaustion — most relevant for D1 quota-death detection).
 *   3. The first lane in the array.
 *
 * Exported for tests + the server-side projection helpers.
 */
export function pickPrimaryLane(lanes: AntigravityLane[]): AntigravityLane {
  if (lanes.length === 1) return lanes[0]!;
  // Most-recent wins.
  let recent = lanes[0]!;
  let recentAt = parseIsoMillis(recent.lastEventAt);
  for (let i = 1; i < lanes.length; i++) {
    const cur = lanes[i]!;
    const curAt = parseIsoMillis(cur.lastEventAt);
    if (curAt > recentAt) {
      recent = cur;
      recentAt = curAt;
    }
  }
  if (recentAt > 0) return recent;
  // Nobody has an event timestamp; pick the lane closest to exhaustion.
  let lowest = lanes[0]!;
  for (let i = 1; i < lanes.length; i++) {
    if (lanes[i]!.percentRemaining < lowest.percentRemaining) {
      lowest = lanes[i]!;
    }
  }
  return lowest;
}

function parseIsoMillis(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Compute the per-snapshot delta in `percent_remaining` between two
 * successive observations of the same lane. Returns null when the
 * lanes are different or either snapshot lacks a numeric reading.
 *
 * This helper is the building block the server-side `lane-recovery.ts`
 * service uses to detect a lane refresh: a positive delta that crosses
 * a configurable threshold (e.g. 0.5) over a short interval is the
 * D4 "lane recovered" event.
 */
export function computePercentWindowDelta(
  prev: AntigravityLane | null | undefined,
  next: AntigravityLane | null | undefined,
): number | null {
  if (!prev || !next) return null;
  if (prev.laneId !== next.laneId) return null;
  if (
    !Number.isFinite(prev.percentRemaining)
    || !Number.isFinite(next.percentRemaining)
  ) return null;
  return next.percentRemaining - prev.percentRemaining;
}
