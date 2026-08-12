import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  accounts,
  rental_listings,
  rental_provider_hosts,
  rental_sessions,
  type RentalHostRuntime,
} from "../db/schema.js";
import { CAPACITY_CONSUMING_STATUSES } from "./sessions/queries.js";
import { assertRentalHostRuntimeSafe } from "./runtime-policy.js";

export const RENTAL_HOST_FRESHNESS_MS = 90_000;
const MAX_HOST_ID_LENGTH = 160;
const MAX_LRT_LIMIT = 1_000_000_000;
const MAX_TIME_LIMIT_MINUTES = 24 * 60;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface RentalProviderHostInput {
  providerAccountId: string;
  hostId: string;
  installationId: string;
  enabled: boolean;
  maxConcurrentSessions: number;
  defaultLrtLimit?: number;
  defaultTimeLimitMinutes?: number;
  manualAcceptRequired?: boolean;
  runtimes: RentalHostRuntime[];
  daemonGeneration?: number | null;
}

export function canAcceptRentalDaemonGeneration(
  current: number | null,
  incoming: number | null,
): boolean {
  return current === null || (incoming !== null && incoming >= current);
}

function boundedStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error(`invalid_${field}`);
  const normalized = value.map((item) => {
    if (
      typeof item !== "string"
      || !item.trim()
      || item.length > 120
      || CONTROL_CHARACTERS.test(item)
    ) {
      throw new Error(`invalid_${field}`);
    }
    return item.trim();
  });
  return [...new Set(normalized)];
}

function normalizeRuntimes(value: unknown): RentalHostRuntime[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("invalid_runtimes");
  const byKind = new Map<string, RentalHostRuntime>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_runtime");
    const runtime = raw as Record<string, unknown>;
    if (typeof runtime.kind !== "string" || typeof runtime.label !== "string") {
      throw new Error("invalid_runtime");
    }
    const kind = runtime.kind.trim().slice(0, 64);
    const label = runtime.label.trim().slice(0, 96);
    if (
      !kind
      || !label
      || runtime.kind.length > 64
      || runtime.label.length > 96
      || CONTROL_CHARACTERS.test(runtime.kind)
      || CONTROL_CHARACTERS.test(runtime.label)
    ) {
      throw new Error("invalid_runtime");
    }
    const normalized = assertRentalHostRuntimeSafe({
      kind,
      label,
      authenticated: runtime.authenticated === true,
      permissionProfiles: boundedStringList(runtime.permissionProfiles, "permission_profiles"),
      modelLabels: boundedStringList(runtime.modelLabels, "model_labels"),
    });
    byKind.set(normalized.kind, normalized);
  }
  return [...byKind.values()];
}

function normalizeHostInput(input: RentalProviderHostInput): RentalProviderHostInput {
  const hostId = input.hostId.trim();
  const installationId = input.installationId.trim();
  if (
    !hostId
    || !installationId
    || hostId.length > MAX_HOST_ID_LENGTH
    || installationId.length > MAX_HOST_ID_LENGTH
    || CONTROL_CHARACTERS.test(hostId)
    || CONTROL_CHARACTERS.test(installationId)
  ) throw new Error("invalid_host_identity");
  if (!Number.isInteger(input.maxConcurrentSessions) || input.maxConcurrentSessions < 1 || input.maxConcurrentSessions > 32) {
    throw new Error("invalid_host_capacity");
  }
  if (input.defaultLrtLimit !== undefined && (
    !Number.isInteger(input.defaultLrtLimit)
    || input.defaultLrtLimit < 1
    || input.defaultLrtLimit > MAX_LRT_LIMIT
  )) throw new Error("invalid_default_lrt_limit");
  if (input.defaultTimeLimitMinutes !== undefined && (
    !Number.isInteger(input.defaultTimeLimitMinutes)
    || input.defaultTimeLimitMinutes < 1
    || input.defaultTimeLimitMinutes > MAX_TIME_LIMIT_MINUTES
  )) throw new Error("invalid_default_time_limit");
  if (input.daemonGeneration !== undefined && input.daemonGeneration !== null && (
    !Number.isInteger(input.daemonGeneration)
    || input.daemonGeneration < 0
    || input.daemonGeneration > 2_147_483_647
  )) throw new Error("invalid_daemon_generation");
  return {
    ...input,
    hostId,
    installationId,
    runtimes: normalizeRuntimes(input.runtimes),
    defaultLrtLimit: input.defaultLrtLimit ?? 50_000,
    defaultTimeLimitMinutes: input.defaultTimeLimitMinutes ?? 30,
    manualAcceptRequired: input.manualAcceptRequired !== false,
  };
}

async function upsertRentalProviderHost(input: RentalProviderHostInput, syncOffers: boolean) {
  const normalized = normalizeHostInput(input);
  const now = new Date();
  const [host] = await db
    .insert(rental_provider_hosts)
    .values({
      id: `rhost_${crypto.randomUUID().replaceAll("-", "")}`,
      provider_account_id: normalized.providerAccountId,
      host_id: normalized.hostId,
      installation_id: normalized.installationId,
      enabled: normalized.enabled,
      max_concurrent_sessions: normalized.maxConcurrentSessions,
      default_lrt_limit: normalized.defaultLrtLimit,
      default_time_limit_minutes: normalized.defaultTimeLimitMinutes,
      manual_accept_required: normalized.manualAcceptRequired,
      runtimes: normalized.runtimes,
      daemon_generation: normalized.daemonGeneration ?? null,
      last_heartbeat_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        rental_provider_hosts.provider_account_id,
        rental_provider_hosts.host_id,
        rental_provider_hosts.installation_id,
      ],
      set: {
        enabled: normalized.enabled,
        max_concurrent_sessions: normalized.maxConcurrentSessions,
        default_lrt_limit: normalized.defaultLrtLimit,
        default_time_limit_minutes: normalized.defaultTimeLimitMinutes,
        manual_accept_required: normalized.manualAcceptRequired,
        runtimes: normalized.runtimes,
        daemon_generation: normalized.daemonGeneration ?? null,
        last_heartbeat_at: now,
        updated_at: now,
      },
      // A replaced Desktop process owns a strictly newer daemon generation.
      // Never let a delayed heartbeat from its predecessor overwrite the live
      // host advertisement or move the generation backwards.
      setWhere: normalized.daemonGeneration === null
        ? sql`${rental_provider_hosts.daemon_generation} IS NULL`
        : sql`${rental_provider_hosts.daemon_generation} IS NULL
          OR ${rental_provider_hosts.daemon_generation} <= ${normalized.daemonGeneration}`,
    })
    .returning();
  if (!host) throw new Error("stale_daemon_generation");
  const superseded = await db.select({ id: rental_provider_hosts.id })
    .from(rental_provider_hosts)
    .where(and(
      eq(rental_provider_hosts.provider_account_id, normalized.providerAccountId),
      eq(rental_provider_hosts.host_id, normalized.hostId),
      ne(rental_provider_hosts.installation_id, normalized.installationId),
    ));
  const supersededIds = superseded.map(({ id }) => id);
  if (supersededIds.length > 0) {
    await db.update(rental_provider_hosts).set({
      enabled: false,
      updated_at: now,
    }).where(inArray(rental_provider_hosts.id, supersededIds));
    await db.update(rental_listings).set({ status: "paused", updated_at: now })
      .where(inArray(rental_listings.provider_host_id, supersededIds));
  }
  if (syncOffers) await syncHostOffers(host, normalized.runtimes);
  return host;
}

export async function registerRentalProviderHost(input: RentalProviderHostInput) {
  return upsertRentalProviderHost(input, true);
}

async function syncHostOffers(
  host: typeof rental_provider_hosts.$inferSelect,
  runtimes: RentalHostRuntime[],
): Promise<void> {
  const authenticated = runtimes.filter((runtime) => runtime.authenticated);
  const existing = await db.select().from(rental_listings)
    .where(eq(rental_listings.provider_host_id, host.id));
  const existingByKind = new Map(existing.map((listing) => [listing.ide_kind, listing]));
  for (const runtime of authenticated) {
    const listing = existingByKind.get(runtime.kind);
    if (listing) {
      await db.update(rental_listings).set({
        display_name: runtime.label,
        model_label: runtime.modelLabels?.[0] ?? null,
        status: host.enabled ? "active" : "paused",
        supported_modes: ["scoped"],
        default_lrt_limit: host.default_lrt_limit,
        default_time_limit_minutes: host.default_time_limit_minutes,
        manual_accept_required: host.manual_accept_required,
        max_concurrent_sessions: host.max_concurrent_sessions,
        updated_at: new Date(),
      }).where(eq(rental_listings.id, listing.id));
      existingByKind.delete(runtime.kind);
      continue;
    }
    await db.insert(rental_listings).values({
      id: `rlist_${crypto.randomUUID().replaceAll("-", "")}`,
      provider_account_id: host.provider_account_id,
      provider_host_id: host.id,
      display_name: runtime.label,
      status: host.enabled ? "active" : "paused",
      verification_status: "experimental",
      readiness_badges: ["desktop_host", "authenticated_runtime"],
      ide_kind: runtime.kind,
      model_label: runtime.modelLabels?.[0] ?? null,
      supported_modes: ["scoped"],
      max_concurrent_sessions: host.max_concurrent_sessions,
      default_lrt_limit: host.default_lrt_limit,
      default_time_limit_minutes: host.default_time_limit_minutes,
      manual_accept_required: host.manual_accept_required,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
  const staleIds = [...existingByKind.values()].map((listing) => listing.id);
  if (staleIds.length > 0) {
    await db.update(rental_listings).set({ status: "paused", updated_at: new Date() })
      .where(inArray(rental_listings.id, staleIds));
  }
}

export async function heartbeatRentalProviderHost(input: RentalProviderHostInput) {
  const normalized = normalizeHostInput(input);
  const [existing] = await db.select().from(rental_provider_hosts).where(and(
    eq(rental_provider_hosts.provider_account_id, normalized.providerAccountId),
    eq(rental_provider_hosts.host_id, normalized.hostId),
    eq(rental_provider_hosts.installation_id, normalized.installationId),
  )).limit(1);
  if (existing && !canAcceptRentalDaemonGeneration(
    existing.daemon_generation,
    normalized.daemonGeneration ?? null,
  )) {
    throw new Error("stale_daemon_generation");
  }
  const settingsChanged = !existing
    || existing.enabled !== normalized.enabled
    || existing.max_concurrent_sessions !== normalized.maxConcurrentSessions
    || existing.default_lrt_limit !== normalized.defaultLrtLimit
    || existing.default_time_limit_minutes !== normalized.defaultTimeLimitMinutes
    || existing.manual_accept_required !== normalized.manualAcceptRequired
    || JSON.stringify(existing.runtimes ?? []) !== JSON.stringify(normalized.runtimes);
  return upsertRentalProviderHost(normalized, settingsChanged);
}

export async function listRentalProviderHosts(providerAccountId: string) {
  return db.select().from(rental_provider_hosts)
    .where(eq(rental_provider_hosts.provider_account_id, providerAccountId))
    .orderBy(desc(rental_provider_hosts.updated_at));
}

export function isRentalHostFresh(lastHeartbeatAt: Date, now = Date.now()): boolean {
  return now - lastHeartbeatAt.getTime() <= RENTAL_HOST_FRESHNESS_MS;
}

export function safePublicRentalAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname.toLowerCase() === "avatars.githubusercontent.com"
      && !parsed.username
      && !parsed.password
      && !parsed.port
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export interface PublicRentalProvider {
  providerKey: string;
  /** Safe public alias used by existing Desktop DTOs; never a database account id. */
  accountId: string;
  displayName: string;
  login: string;
  avatarUrl: string | null;
  availability: "available";
  availableSlots: number;
  maxConcurrentSessions: number;
  supportsRepository: false;
  maxDurationMinutes: number | null;
  runtimes: Array<Pick<RentalHostRuntime, "kind" | "label">>;
  offers: Array<{
    id: string;
    listingId: string;
    displayName: string;
    providerDisplayName: string;
    status: "active";
    verificationStatus: string;
    readinessBadges: string[];
    ideKind: string;
    modelLabel: string | null;
    quotaLaneLabel: string | null;
    meterConfidence: string;
    nativeQuotaUnit: string;
    lastLrtEstimate: number | null;
    lastQuotaResetAt: string | null;
    supportedModes: string[];
    maxConcurrentSessions: number;
    activeSessionCount: number;
    defaultLrtLimit: number | null;
    defaultTimeLimitMinutes: number | null;
    manualAcceptRequired: boolean;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
}

export function projectPublicRentalOffer(
  listing: typeof rental_listings.$inferSelect,
  providerDisplayName: string,
  activeSessionCount: number,
): PublicRentalProvider["offers"][number] {
  return {
    id: listing.id,
    listingId: listing.id,
    displayName: listing.display_name,
    providerDisplayName,
    status: "active",
    verificationStatus: listing.verification_status,
    readinessBadges: listing.readiness_badges ?? [],
    ideKind: listing.ide_kind,
    modelLabel: listing.model_label,
    quotaLaneLabel: listing.quota_lane_label,
    meterConfidence: listing.meter_confidence,
    nativeQuotaUnit: listing.native_quota_unit,
    lastLrtEstimate: listing.last_lrt_estimate,
    lastQuotaResetAt: listing.last_quota_reset_at?.toISOString() ?? null,
    supportedModes: listing.supported_modes ?? [],
    maxConcurrentSessions: listing.max_concurrent_sessions,
    activeSessionCount,
    defaultLrtLimit: listing.default_lrt_limit,
    defaultTimeLimitMinutes: listing.default_time_limit_minutes,
    manualAcceptRequired: listing.manual_accept_required,
    createdAt: listing.created_at?.toISOString() ?? null,
    updatedAt: listing.updated_at?.toISOString() ?? null,
  };
}

/** Online provider-as-person discovery. Internal account and installation ids stay redacted. */
export async function publicRentalProviders(viewerAccountId?: string): Promise<PublicRentalProvider[]> {
  const cutoff = new Date(Date.now() - RENTAL_HOST_FRESHNESS_MS);
  const hostRows = await db
    .select({ host: rental_provider_hosts, account: accounts })
    .from(rental_provider_hosts)
    .innerJoin(accounts, eq(accounts.id, rental_provider_hosts.provider_account_id))
    .where(and(
      eq(rental_provider_hosts.enabled, true),
      gte(rental_provider_hosts.last_heartbeat_at, cutoff),
      ...(viewerAccountId ? [ne(accounts.id, viewerAccountId)] : []),
    ));
  // Historical installation rows can coexist during a desktop replacement.
  // Only the freshest exact installation represents one physical host.
  const latestByHost = new Map<string, (typeof hostRows)[number]>();
  for (const row of hostRows) {
    const key = `${row.host.provider_account_id}\0${row.host.host_id}`;
    const current = latestByHost.get(key);
    if (!current || row.host.last_heartbeat_at.getTime() > current.host.last_heartbeat_at.getTime()) {
      latestByHost.set(key, row);
    }
  }
  const hosts = [...latestByHost.values()];
  if (hosts.length === 0) return [];

  const hostIds = hosts.map(({ host }) => host.id);
  const [listings, occupied] = await Promise.all([
    db.select().from(rental_listings).where(and(
      inArray(rental_listings.provider_host_id, hostIds),
      eq(rental_listings.status, "active"),
    )),
    db.select({
      hostId: rental_sessions.provider_host_id,
      count: sql<number>`count(*)::int`,
    }).from(rental_sessions).where(and(
      inArray(rental_sessions.provider_host_id, hostIds),
      inArray(rental_sessions.status, [...CAPACITY_CONSUMING_STATUSES]),
    )).groupBy(rental_sessions.provider_host_id),
  ]);
  const occupiedByHost = new Map(occupied.map((row) => [row.hostId, row.count]));
  const listingsByHost = new Map<string, typeof listings>();
  for (const listing of listings) {
    if (!listing.provider_host_id) continue;
    const current = listingsByHost.get(listing.provider_host_id) ?? [];
    current.push(listing);
    listingsByHost.set(listing.provider_host_id, current);
  }

  const providers = new Map<string, PublicRentalProvider>();
  for (const { host, account } of hosts) {
    const offers = listingsByHost.get(host.id) ?? [];
    const available = Math.max(0, host.max_concurrent_sessions - (occupiedByHost.get(host.id) ?? 0));
    if (available === 0 || offers.length === 0) continue;
    const current = providers.get(account.id) ?? {
      providerKey: account.login.toLowerCase(),
      accountId: account.login.toLowerCase(),
      displayName: account.display_name || account.login,
      login: account.login,
      avatarUrl: safePublicRentalAvatarUrl(account.avatar_url),
      availability: "available" as const,
      availableSlots: 0,
      maxConcurrentSessions: 0,
      supportsRepository: false as const,
      maxDurationMinutes: null,
      runtimes: [],
      offers: [],
    };
    current.availableSlots += available;
    current.maxConcurrentSessions += host.max_concurrent_sessions;
    const hostMaxDuration = Math.max(
      0,
      ...offers.map((listing) => listing.default_time_limit_minutes ?? 0),
    );
    current.maxDurationMinutes = Math.max(current.maxDurationMinutes ?? 0, hostMaxDuration) || null;
    current.runtimes = [...new Map([
      ...current.runtimes,
      ...(host.runtimes ?? [])
        .filter((runtime) => runtime.authenticated)
        .map((runtime) => ({ kind: runtime.kind, label: runtime.label })),
    ].map((r) => [r.kind, r])).values()];
    current.offers.push(...offers.map((listing) => projectPublicRentalOffer(
      listing,
      account.display_name || account.login,
      occupiedByHost.get(host.id) ?? 0,
    )));
    providers.set(account.id, current);
  }
  return [...providers.values()];
}
