/**
 * Renter-side quota trigger runtime (p2.6b).
 *
 * This is the small stateful bridge between the pure D1 classifier and
 * Electron IPC / stream events. The adapter scheduler can feed native
 * quota snapshots here, tool hooks can feed quota-failure pulses, and
 * the renderer can use the manual declaration path.
 */

import type {
  DesktopRentalManualDeclareInput,
  DesktopRentalOwnQuotaStatus,
  DesktopRentalQuotaFailureInput,
  DesktopRentalQuotaSnapshot,
  DesktopRentalRenterTriggerSignal,
  DesktopRoomStreamEvent,
} from "../ipc-types.js";
import type { AdapterNativeQuotaSnapshot } from "./adapter-types.js";
import type { AdapterTickResult } from "./adapter-runtime.js";
import {
  isAffirmativelyHealthy,
  RenterTriggerClassifier,
  type RenterTriggerClassifierOptions,
  type RenterTriggerSignal,
} from "./trigger-classifier.js";

export interface RenterTriggerRuntimeOptions {
  classifier?: RenterTriggerClassifier;
  classifierOptions?: RenterTriggerClassifierOptions;
  now?: () => Date;
  getRoomIdentifier?: () => string | null;
  emitRoomStreamEvent?: (event: DesktopRoomStreamEvent) => void;
}

function defaultNow(): Date {
  return new Date();
}

function observedMs(value: string | null | undefined, fallback: Date): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback.getTime();
}

function laneKey(provider: string | null, model: string | null): string {
  return `${provider ?? ""}::${model ?? ""}`;
}

function signalToDesktop(signal: RenterTriggerSignal): DesktopRentalRenterTriggerSignal {
  return {
    triggered: signal.triggered,
    confidence: signal.confidence,
    reason: signal.reason,
    provider: signal.provider,
    model: signal.model,
    observedAt: signal.observedAt,
    laneResetAt: signal.laneResetAt,
    rawSignal: signal.rawSignal,
  };
}

export function quotaSnapshotToDesktop(
  snapshot: AdapterNativeQuotaSnapshot,
): DesktopRentalQuotaSnapshot {
  const nativeUsed =
    typeof snapshot.nativeTotal === "number" && typeof snapshot.nativeRemaining === "number"
      ? Math.max(0, snapshot.nativeTotal - snapshot.nativeRemaining)
      : null;
  return {
    id: `${snapshot.provider}:${snapshot.sourceId}:${snapshot.observedAt}`,
    provider: snapshot.provider,
    modelLabel: snapshot.model,
    quotaLaneId: snapshot.sourceId,
    quotaLaneLabel: snapshot.model ?? snapshot.provider,
    nativeUnit: snapshot.nativeUnit,
    nativeUsed,
    nativeRemaining: snapshot.nativeRemaining,
    nativeLimit: snapshot.nativeTotal,
    nativeResetAt: snapshot.nativeResetAt,
    nativeExpiresAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    reasoningTokens: null,
    lrtEstimate: null,
    lrtRemaining: null,
    confidence: snapshot.confidence,
    source: snapshot.sourceId,
    observedAt: snapshot.observedAt,
    stale: false,
    raw: snapshot.raw,
  };
}

export class RenterTriggerRuntime {
  private readonly classifier: RenterTriggerClassifier;
  private readonly now: () => Date;
  private readonly getRoomIdentifier: () => string | null;
  private readonly emitRoomStreamEvent: ((event: DesktopRoomStreamEvent) => void) | null;
  private readonly activeTriggeredLanes = new Set<string>();
  private status: DesktopRentalOwnQuotaStatus = {
    triggered: false,
    lastSignal: null,
    lastSnapshot: null,
    provider: null,
    model: null,
    failureCount: 0,
    updatedAt: null,
  };

  constructor(options: RenterTriggerRuntimeOptions = {}) {
    this.classifier =
      options.classifier ?? new RenterTriggerClassifier(options.classifierOptions);
    this.now = options.now ?? defaultNow;
    this.getRoomIdentifier = options.getRoomIdentifier ?? (() => null);
    this.emitRoomStreamEvent = options.emitRoomStreamEvent ?? null;
  }

  getOwnQuotaStatus(): DesktopRentalOwnQuotaStatus {
    return {
      ...this.status,
      lastSignal: this.status.lastSignal ? { ...this.status.lastSignal } : null,
      lastSnapshot: this.status.lastSnapshot ? { ...this.status.lastSnapshot } : null,
    };
  }

  observeAdapterTick(result: AdapterTickResult): DesktopRentalRenterTriggerSignal | null {
    if (!result.snapshot) return null;
    return this.observeSnapshot(result.snapshot);
  }

  observeSnapshot(snapshot: AdapterNativeQuotaSnapshot): DesktopRentalRenterTriggerSignal {
    const now = this.now();
    const signal = this.classifier.observe(
      { kind: "snapshot", snapshot },
      observedMs(snapshot.observedAt, now),
    );
    const desktop = signalToDesktop(signal);
    const snapshotDto = quotaSnapshotToDesktop(snapshot);
    const key = laneKey(snapshot.provider, snapshot.model);
    const healthy = isAffirmativelyHealthy(snapshot);
    if (healthy) {
      this.activeTriggeredLanes.delete(key);
    }
    this.updateStatus(desktop, {
      snapshot: snapshotDto,
      provider: snapshot.provider,
      model: snapshot.model,
      now,
      clearTrigger: healthy,
    });
    this.emitIfNewTrigger(desktop);
    return desktop;
  }

  recordQuotaFailure(input: DesktopRentalQuotaFailureInput): DesktopRentalRenterTriggerSignal {
    const now = this.now();
    const provider = input.provider.trim();
    if (!provider) {
      throw new Error("provider is required for quota failure observations");
    }
    const occurredAt = input.occurredAt?.trim() || now.toISOString();
    const model = input.model ?? null;
    const signal = this.classifier.observe(
      {
        kind: "quota_failure",
        provider,
        model,
        occurredAt,
        detail: input.detail,
      },
      observedMs(occurredAt, now),
    );
    const desktop = signalToDesktop(signal);
    this.updateStatus(desktop, { provider, model, now });
    this.emitIfNewTrigger(desktop);
    return desktop;
  }

  declareManual(
    input: DesktopRentalManualDeclareInput = {},
  ): DesktopRentalRenterTriggerSignal {
    const now = this.now();
    const signal = this.classifier.declareManual({
      provider: input.provider ?? null,
      model: input.model ?? null,
      note: input.note ?? null,
      occurredAt: input.occurredAt?.trim() || now.toISOString(),
    });
    const desktop = signalToDesktop(signal);
    this.updateStatus(desktop, {
      provider: desktop.provider,
      model: desktop.model,
      now,
    });
    this.emitIfNewTrigger(desktop);
    return desktop;
  }

  reset(): void {
    this.classifier.reset();
    this.activeTriggeredLanes.clear();
    this.status = {
      triggered: false,
      lastSignal: null,
      lastSnapshot: null,
      provider: null,
      model: null,
      failureCount: 0,
      updatedAt: this.now().toISOString(),
    };
  }

  private updateStatus(
    signal: DesktopRentalRenterTriggerSignal,
    context: {
      snapshot?: DesktopRentalQuotaSnapshot;
      provider: string | null;
      model: string | null;
      now: Date;
      clearTrigger?: boolean;
    },
  ): void {
    const preserveTrigger =
      !signal.triggered && !context.clearTrigger && this.status.triggered;
    const provider = preserveTrigger
      ? this.status.provider
      : signal.provider ?? context.provider;
    const model = preserveTrigger
      ? this.status.model
      : signal.model ?? context.model;
    this.status = {
      triggered: signal.triggered || preserveTrigger,
      lastSignal: preserveTrigger ? this.status.lastSignal : signal,
      lastSnapshot: context.snapshot ?? this.status.lastSnapshot,
      provider,
      model,
      failureCount:
        typeof provider === "string"
          ? this.classifier.failureCount(context.now.getTime(), provider, model)
          : this.classifier.failureCount(context.now.getTime()),
      updatedAt: context.now.toISOString(),
    };
  }

  private emitIfNewTrigger(signal: DesktopRentalRenterTriggerSignal): void {
    if (!signal.triggered || !this.emitRoomStreamEvent) return;
    const key = laneKey(signal.provider, signal.model);
    if (this.activeTriggeredLanes.has(key)) return;
    this.activeTriggeredLanes.add(key);
    this.emitRoomStreamEvent({
      type: "rental_quota_exhausted",
      roomIdentifier: this.getRoomIdentifier() ?? "",
      signal,
      status: this.getOwnQuotaStatus(),
    });
  }
}
