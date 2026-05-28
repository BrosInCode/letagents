/**
 * Antigravity meter adapter (desktop-local).
 *
 * Antigravity exposes its rate-limit state as a `percent_window` value
 * per model-lane plus a reset timestamp. There is no exact per-turn
 * token log available locally, so usage deltas stay at zero and LRT
 * availability is projected from calibrated percent-window snapshots.
 */

import { existsSync } from "node:fs";

import {
  type AdapterCalibrationHistory,
  type AdapterLrtEstimate,
  type AdapterMeterSource,
  type AdapterNativeQuotaSnapshot,
  type AdapterRentalMeterScope,
  type AdapterUsageDelta,
  type DesktopMeterAdapter,
} from "../adapter-types.js";
import {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER,
  DEFAULT_MAX_FILE_BYTES,
} from "./antigravity/constants.js";
import {
  computePercentWindowDelta,
  pickPrimaryLane,
} from "./antigravity/lanes.js";
import { estimateLrtRemainingForWindow } from "./antigravity/lrt.js";
import {
  parseQuotaDocument,
  readAntigravityQuotaFile,
} from "./antigravity/parser.js";
import { defaultAntigravityQuotaPaths } from "./antigravity/paths.js";
import type {
  AntigravityAdapterOptions,
  AntigravityLane,
  AntigravityQuotaDocument,
} from "./antigravity/types.js";
import { emptyDelta } from "./antigravity/usage.js";

export {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER,
} from "./antigravity/constants.js";
export {
  computePercentWindowDelta,
  pickPrimaryLane,
} from "./antigravity/lanes.js";
export { estimateLrtRemainingForWindow } from "./antigravity/lrt.js";
export { parseQuotaDocument } from "./antigravity/parser.js";
export { defaultAntigravityQuotaPaths } from "./antigravity/paths.js";
export type {
  AntigravityAdapterOptions,
  AntigravityLane,
  AntigravityQuotaDocument,
} from "./antigravity/types.js";

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
    // Antigravity does not expose per-turn usage locally. The server
    // reconstructs consumption from successive percent-window snapshots.
    void scope;
    return emptyDelta();
  }

  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate {
    const lrtRemaining = estimateLrtRemainingForWindow(
      snapshot.nativeRemaining,
      history.lrtPerFullWindow,
    );
    const upgraded: AdapterLrtEstimate["confidence"] =
      lrtRemaining !== null && history.sampleCount >= 10
        ? "calibrated"
        : snapshot.confidence;

    return {
      lrtUsed: 0,
      lrtRemaining,
      confidence: upgraded,
    };
  }

  async parseQuotaFile(path: string): Promise<AntigravityQuotaDocument | null> {
    return readAntigravityQuotaFile(path, this.options.maxFileBytes);
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
