/**
 * Renter quota state — transient server-side mirror of a renter's
 * own IDE quota signal (p2.6c).
 *
 * The renter's desktop adapter / UI declares quota exhaustion via
 * `POST /api/rental/renter/declare-quota-exhausted`. The declaration
 * is held in this in-memory cache so subsequent reads
 * (`GET /quota-status`) and any auto-prefilled session-create flow
 * can see it.
 *
 * V1 design choices:
 *   • In-memory, per-process. Distributed coherence is not needed
 *     because each renter session is anchored to a single API
 *     process for the duration of their browse + one-shot session
 *     creation. Once the renter creates a rental_session, the D3
 *     fields land on the row and this cache becomes irrelevant.
 *   • TTL'd entries (default 30 min) so a stale declaration cannot
 *     auto-flag a much later session.
 *   • Per-account scoping. The renter is identified by the
 *     authenticated session.
 *   • No DB schema change. If a future spec requires a persistent
 *     renter-level quota history table (§19.x), it lifts cleanly
 *     out of this module.
 *
 * Spec refs:
 *   §1.5 D1 Entry Paths and Rescue Flow
 *   §6.2 step 1 (renter session-create trigger context)
 *   §19.2 rental_sessions D3 trigger fields (set by the next
 *         session-create after a declaration)
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.6c.
 */

import type {
  RentalStartTrigger,
  RentalTriggerConfidence,
} from "../routes/rental/renter/index.js";

/**
 * What the desktop adapter / UI ships to the server. Mirrors the
 * §19.2 D3 column set so the next `POST /api/rental/sessions` can
 * pre-populate from this cache without re-validating.
 */
export interface RenterQuotaDeclaration {
  startTrigger: RentalStartTrigger;
  triggerConfidence: RentalTriggerConfidence;
  provider: string;
  model: string | null;
  exhaustedAt: Date;
  refreshEta: Date | null;
  signal: Record<string, unknown> | null;
  /**
   * Wall-clock ms when this declaration was recorded. The cache
   * TTL is measured from this point, not from `exhaustedAt` (which
   * the renter's clock owns and could be skewed).
   */
  recordedAtMs: number;
}

/**
 * Public, query-friendly shape returned from `GET /quota-status`.
 * Dates serialize as ISO strings; `signal` is opaque jsonb.
 */
export interface RenterQuotaStatus {
  inExhaustedState: boolean;
  declaration: {
    startTrigger: RentalStartTrigger;
    triggerConfidence: RentalTriggerConfidence;
    provider: string;
    model: string | null;
    exhaustedAt: string;
    refreshEta: string | null;
    signal: Record<string, unknown> | null;
    recordedAt: string;
    expiresAt: string;
  } | null;
}

export interface RenterQuotaStateOptions {
  /** Cache TTL in ms. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class RenterQuotaStateStore {
  private readonly cache = new Map<string, RenterQuotaDeclaration>();
  private readonly options: Required<RenterQuotaStateOptions>;

  constructor(options: RenterQuotaStateOptions = {}) {
    this.options = {
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now ?? Date.now,
    };
  }

  /**
   * Record a new declaration for `accountId`. Overwrites any
   * previous declaration for the same account.
   *
   * Returns the stored declaration shape (with `recordedAtMs`
   * stamped) so the caller can return it from the route handler
   * without re-reading.
   */
  declare(
    accountId: string,
    input: Omit<RenterQuotaDeclaration, "recordedAtMs">,
  ): RenterQuotaDeclaration {
    const recordedAtMs = this.options.now();
    const decl: RenterQuotaDeclaration = { ...input, recordedAtMs };
    this.cache.set(accountId, decl);
    return decl;
  }

  /**
   * Read the current declaration for `accountId`. Returns null
   * when no declaration exists OR the existing one has expired.
   * Expired entries are evicted as a side-effect of the read.
   */
  get(accountId: string): RenterQuotaDeclaration | null {
    const decl = this.cache.get(accountId);
    if (!decl) return null;
    if (this.isExpired(decl)) {
      this.cache.delete(accountId);
      return null;
    }
    return decl;
  }

  /**
   * Clear a renter's declaration. Called after a successful
   * session-create so the next browse session does not see a
   * stale declaration.
   */
  clear(accountId: string): void {
    this.cache.delete(accountId);
  }

  /**
   * Total entries in the cache. For tests + telemetry.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Build the public `RenterQuotaStatus` shape from a declaration.
   * Exposed because the route handler needs to serialize Dates to
   * ISO and surface the computed `expiresAt`.
   */
  serialize(decl: RenterQuotaDeclaration | null): RenterQuotaStatus {
    if (!decl) {
      return { inExhaustedState: false, declaration: null };
    }
    const recordedAtMs = decl.recordedAtMs;
    const expiresAtMs = recordedAtMs + this.options.ttlMs;
    return {
      inExhaustedState: true,
      declaration: {
        startTrigger: decl.startTrigger,
        triggerConfidence: decl.triggerConfidence,
        provider: decl.provider,
        model: decl.model,
        exhaustedAt: decl.exhaustedAt.toISOString(),
        refreshEta: decl.refreshEta?.toISOString() ?? null,
        signal: decl.signal,
        recordedAt: new Date(recordedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  private isExpired(decl: RenterQuotaDeclaration): boolean {
    return this.options.now() - decl.recordedAtMs > this.options.ttlMs;
  }
}

/**
 * Default singleton used by the live route handler. Tests pass
 * their own instance.
 */
export const defaultRenterQuotaStateStore = new RenterQuotaStateStore();
