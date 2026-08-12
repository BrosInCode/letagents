import { buildAgentRoomParticipantKey } from "../../shared/room-participant.js";
import type { RoomAgentDeliveryTransport } from "../../shared/agent-presence.js";
import { ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS } from "../../shared/agent-presence.js";
import { isRoomAgentDeliveryCredentialExpired } from "../../shared/agent-presence.js";
import {
  forceDisconnectRoomAgentDeliverySession,
  markRoomAgentDeliveryConnected,
  markRoomAgentDeliveryDisconnected,
  markRoomAgentDeliveryHeartbeat,
  upsertRoomParticipant,
} from "../db.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { resolveRequestAgentIdentity, type ResolvedRequestAgentIdentity } from "../request/agent-identity.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../shared/request-headers.js";
import { InactiveRoomAgentDeliverySessionError } from "../db/presence/delivery.js";
import {
  roomAgentCredentialInvalidationEvents,
  roomAgentDeliveryCredentialFingerprint,
} from "./agent-credential-events.js";

interface SharedDeliveryLease {
  identity: ResolvedRequestAgentIdentity;
  refs: number;
  heartbeat: ReturnType<typeof setInterval>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  disconnectHandlers: Set<() => void>;
}

interface SharedDeliveryFence {
  generation: number;
  activeSetups: number;
  activeCredentialFingerprints: Map<string, number>;
  retiredCredentialFingerprints: Set<string>;
  disconnecting: Promise<unknown> | null;
}

// One process-local DB lease/heartbeat per durable delivery key. Individual
// SSE and long-poll requests are refs on it, rather than independent timers
// and global EventEmitter listeners.
const sharedDeliveryLeases = new Map<string, SharedDeliveryLease>();
const sharedDeliveryLeaseCreations = new Map<string, Promise<SharedDeliveryLease>>();
const sharedDeliveryFences = new Map<string, SharedDeliveryFence>();

function sharedDeliveryCreationKey(leaseKey: string, credentialFingerprint: string | null): string {
  return `${leaseKey}\n${credentialFingerprint ?? "unfenced"}`;
}

function hasSharedDeliveryCreation(leaseKey: string): boolean {
  const prefix = `${leaseKey}\n`;
  return Array.from(sharedDeliveryLeaseCreations.keys()).some((key) => key.startsWith(prefix));
}

function retireSharedDeliveryLease(
  leaseKey: string,
  lease: SharedDeliveryLease,
  reason: string,
): void {
  if (sharedDeliveryLeases.get(leaseKey) === lease) sharedDeliveryLeases.delete(leaseKey);
  clearInterval(lease.heartbeat);
  if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
  for (const handler of lease.disconnectHandlers) {
    try {
      handler();
    } catch (error) {
      console.error(`[room agent delivery] ${reason} handler failed`, error);
    }
  }
}

roomAgentCredentialInvalidationEvents.on("invalidate", (payload: unknown) => {
  const invalidation = payload && typeof payload === "object"
    ? payload as {
        room_id?: unknown;
        agent_session_id?: unknown;
        credential_fingerprints?: unknown;
      }
    : {};
  if (
    typeof invalidation.room_id !== "string"
    || typeof invalidation.agent_session_id !== "string"
  ) return;
  const retiredFingerprints = new Set(
    Array.isArray(invalidation.credential_fingerprints)
      ? invalidation.credential_fingerprints.filter(
          (value): value is string => typeof value === "string" && Boolean(value),
        )
      : [],
  );
  if (retiredFingerprints.size === 0) return;
  const leaseKey = `${invalidation.room_id}\n${invalidation.agent_session_id}`;
  const fence = getSharedDeliveryFence(leaseKey);
  const lease = sharedDeliveryLeases.get(leaseKey);
  const leaseFingerprint = roomAgentDeliveryCredentialFingerprint(lease?.identity.credential_fence);
  const retiresLease = Boolean(leaseFingerprint && retiredFingerprints.has(leaseFingerprint));
  const retiresSetup = Array.from(retiredFingerprints).some(
    (fingerprint) => (fence.activeCredentialFingerprints.get(fingerprint) ?? 0) > 0,
  );
  if (!retiresLease && !retiresSetup) {
    cleanupSharedDeliveryFence(leaseKey, fence);
    return;
  }
  // Fence an already-resolved identity/connected setup even if it has not
  // published its local lease yet. Keep this fence credential-specific so a
  // delayed v1 marker cannot interrupt a legitimate v2 setup.
  if (retiresSetup) {
    for (const fingerprint of retiredFingerprints) {
      if (fence.activeCredentialFingerprints.has(fingerprint)) {
        fence.retiredCredentialFingerprints.add(fingerprint);
      }
    }
  }
  if (!retiresLease || !lease) return;
  retireSharedDeliveryLease(leaseKey, lease, "credential retirement");
  cleanupSharedDeliveryFence(leaseKey, fence);
});

export interface RoomAgentDeliveryDeps {
  resolveRequestAgentIdentity: typeof resolveRequestAgentIdentity;
  markRoomAgentDeliveryConnected: typeof markRoomAgentDeliveryConnected;
  forceDisconnectRoomAgentDeliverySession: typeof forceDisconnectRoomAgentDeliverySession;
  markRoomAgentDeliveryDisconnected: typeof markRoomAgentDeliveryDisconnected;
  markRoomAgentDeliveryHeartbeat: typeof markRoomAgentDeliveryHeartbeat;
  upsertRoomParticipant: typeof upsertRoomParticipant;
  heartbeatIntervalMs: number;
}

const defaultRoomAgentDeliveryDeps: RoomAgentDeliveryDeps = {
  resolveRequestAgentIdentity,
  markRoomAgentDeliveryConnected,
  forceDisconnectRoomAgentDeliverySession,
  markRoomAgentDeliveryDisconnected,
  markRoomAgentDeliveryHeartbeat,
  upsertRoomParticipant,
  heartbeatIntervalMs: ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS,
};

export class InvalidRoomAgentDeliverySessionError extends Error {
  constructor(message = "Invalid agent session credentials.") {
    super(message);
    this.name = "InvalidRoomAgentDeliverySessionError";
  }
}

export interface RoomAgentDeliverySession {
  identity: ResolvedRequestAgentIdentity;
  /** Revalidate the exact delivery credential against durable state. */
  checkCredential: () => Promise<boolean>;
  end: () => Promise<void>;
}

function getOptionalQueryString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }

  if (Array.isArray(value)) {
    return getOptionalQueryString(value[0]);
  }

  return null;
}

function getOptionalHeaderString(req: AuthenticatedRequest, headerName: string): string | null {
  const normalized = String(req.get(headerName) ?? "").trim();
  return normalized || null;
}

function sharedDeliveryLeaseKey(roomId: string, identity: ResolvedRequestAgentIdentity): string {
  return `${roomId}\n${identity.agent_session_id || identity.agent_key || identity.actor_label}`;
}

function getSharedDeliveryFence(leaseKey: string): SharedDeliveryFence {
  let fence = sharedDeliveryFences.get(leaseKey);
  if (!fence) {
    fence = {
      generation: 0,
      activeSetups: 0,
      activeCredentialFingerprints: new Map(),
      retiredCredentialFingerprints: new Set(),
      disconnecting: null,
    };
    sharedDeliveryFences.set(leaseKey, fence);
  }
  return fence;
}

function cleanupSharedDeliveryFence(leaseKey: string, fence: SharedDeliveryFence): void {
  if (
    sharedDeliveryFences.get(leaseKey) === fence
    && fence.activeSetups === 0
    && !fence.disconnecting
    && !hasSharedDeliveryCreation(leaseKey)
    && !sharedDeliveryLeases.has(leaseKey)
  ) {
    sharedDeliveryFences.delete(leaseKey);
  }
}

function assertDeliverySetupCurrent(
  fence: SharedDeliveryFence,
  generation: number,
  credentialFingerprint?: string | null,
): void {
  if (
    fence.generation !== generation
    || (credentialFingerprint && fence.retiredCredentialFingerprints.has(credentialFingerprint))
  ) {
    throw new InvalidRoomAgentDeliverySessionError("Agent delivery session was disconnected during setup.");
  }
}

export async function disconnectRoomAgentDeliverySession(input: {
  room_id: string;
  agent_session_id: string;
}, deps: RoomAgentDeliveryDeps = defaultRoomAgentDeliveryDeps): Promise<Awaited<ReturnType<typeof forceDisconnectRoomAgentDeliverySession>>> {
  const leaseKey = `${input.room_id}\n${input.agent_session_id}`;
  const fence = getSharedDeliveryFence(leaseKey);
  fence.generation += 1;
  const previousDisconnect = fence.disconnecting;
  const disconnecting = (async () => {
    await previousDisconnect?.catch(() => undefined);
    // A setup that already crossed its connected write compensates back to
    // disconnected when it sees the generation change. Waiting here makes the
    // explicit force operation the final durable transition before it returns.
    const creationPrefix = `${leaseKey}\n`;
    await Promise.allSettled(
      Array.from(sharedDeliveryLeaseCreations)
        .filter(([key]) => key.startsWith(creationPrefix))
        .map(([, creation]) => creation),
    );
    const deliverySession = await deps.forceDisconnectRoomAgentDeliverySession(input);
    const lease = sharedDeliveryLeases.get(leaseKey);
    if (lease) {
      sharedDeliveryLeases.delete(leaseKey);
      clearInterval(lease.heartbeat);
    }
    for (const handler of lease?.disconnectHandlers ?? []) {
      try {
        handler();
      } catch (error) {
        console.error("[room agent delivery] disconnect handler failed", error);
      }
    }
    return deliverySession;
  })();
  fence.disconnecting = disconnecting;
  try {
    return await disconnecting;
  } finally {
    if (fence.disconnecting === disconnecting) fence.disconnecting = null;
    cleanupSharedDeliveryFence(leaseKey, fence);
  }
}

export async function beginRoomAgentDelivery(input: {
  req: AuthenticatedRequest;
  roomId: string;
  transport: RoomAgentDeliveryTransport;
  onSessionDisconnected?: () => void;
}, deps: RoomAgentDeliveryDeps = defaultRoomAgentDeliveryDeps): Promise<RoomAgentDeliverySession | null> {
  const agentSessionId = getOptionalHeaderString(input.req, LETAGENTS_AGENT_SESSION_ID_HEADER);
  const agentSessionToken = getOptionalHeaderString(input.req, LETAGENTS_AGENT_SESSION_TOKEN_HEADER);
  const hasAgentSessionCredentials = Boolean(agentSessionId || agentSessionToken);
  if (hasAgentSessionCredentials && (!agentSessionId || !agentSessionToken)) {
    throw new InvalidRoomAgentDeliverySessionError();
  }
  let leaseKey = agentSessionId ? `${input.roomId}\n${agentSessionId}` : null;
  let fence = leaseKey ? getSharedDeliveryFence(leaseKey) : null;
  let setupGeneration = 0;
  let setupCredentialFingerprint: string | null = null;
  if (fence) {
    // Count the identity-resolution window too. Otherwise a force operation
    // can complete before this request appears in the creation map and the
    // stale request can later resurrect the session.
    fence.activeSetups += 1;
    await fence.disconnecting?.catch(() => undefined);
    setupGeneration = fence.generation;
  }
  try {
    const identity = await deps.resolveRequestAgentIdentity({
      req: input.req,
      actor_label: getOptionalQueryString(input.req.query.actor_label),
      actor_key: getOptionalQueryString(input.req.query.actor_key),
      actor_instance_id: getOptionalQueryString(input.req.query.actor_instance_id),
      agent_session_id: agentSessionId,
      agent_session_token: agentSessionToken,
      room_id: input.roomId,
    });
    if (!identity) {
      if (hasAgentSessionCredentials) {
        throw new InvalidRoomAgentDeliverySessionError();
      }
      return null;
    }
    if (hasAgentSessionCredentials && !identity.agent_session_id) {
      throw new InvalidRoomAgentDeliverySessionError();
    }

    const resolvedLeaseKey = sharedDeliveryLeaseKey(input.roomId, identity);
    if (!fence) {
      leaseKey = resolvedLeaseKey;
      fence = getSharedDeliveryFence(leaseKey);
      fence.activeSetups += 1;
      await fence.disconnecting?.catch(() => undefined);
      setupGeneration = fence.generation;
    } else if (resolvedLeaseKey !== leaseKey) {
      throw new InvalidRoomAgentDeliverySessionError();
    }
    setupCredentialFingerprint = roomAgentDeliveryCredentialFingerprint(identity.credential_fence);
    if (setupCredentialFingerprint) {
      fence.activeCredentialFingerprints.set(
        setupCredentialFingerprint,
        (fence.activeCredentialFingerprints.get(setupCredentialFingerprint) ?? 0) + 1,
      );
    }
    assertDeliverySetupCurrent(fence, setupGeneration, setupCredentialFingerprint);

    let lease = sharedDeliveryLeases.get(leaseKey);
    if (
      lease
      && roomAgentDeliveryCredentialFingerprint(lease.identity.credential_fence)
        !== setupCredentialFingerprint
    ) {
      // Stable session ids intentionally survive rotation, but process-local
      // leases do not. A valid v2 request must never inherit v1's heartbeat,
      // refs, identity, or disconnect callbacks while the bridged retirement
      // marker is still in flight.
      retireSharedDeliveryLease(leaseKey, lease, "credential replacement");
      lease = undefined;
    }
    if (!lease) {
      const creationKey = sharedDeliveryCreationKey(leaseKey, setupCredentialFingerprint);
      let creation = sharedDeliveryLeaseCreations.get(creationKey);
      if (!creation) {
        creation = createSharedDeliveryLease(
          input,
          identity,
          leaseKey,
          creationKey,
          fence,
          setupGeneration,
          deps,
        );
        sharedDeliveryLeaseCreations.set(creationKey, creation);
      }
      lease = await creation;
    }
    assertDeliverySetupCurrent(fence, setupGeneration, setupCredentialFingerprint);
    if (sharedDeliveryLeases.get(leaseKey) !== lease) {
      throw new InvalidRoomAgentDeliverySessionError("Agent delivery session was disconnected during setup.");
    }
    lease.refs += 1;
    if (input.onSessionDisconnected) {
      lease.disconnectHandlers.add(input.onSessionDisconnected);
    }

    const activeLeaseKey = leaseKey;
    const activeFence = fence;
    let ended = false;
    return {
      identity,
      checkCredential: async () => {
        if (ended || sharedDeliveryLeases.get(activeLeaseKey) !== lease) return false;
        const active = await deps.markRoomAgentDeliveryHeartbeat({
          room_id: input.roomId,
          actor_label: identity.actor_label,
          agent_session_id: identity.agent_session_id,
          credential_fence: identity.credential_fence,
        });
        if (active !== false) return true;
        if (sharedDeliveryLeases.get(activeLeaseKey) === lease) {
          retireSharedDeliveryLease(activeLeaseKey, lease, "inactive credential");
          cleanupSharedDeliveryFence(activeLeaseKey, activeFence);
        }
        return false;
      },
      end: async () => {
        if (ended) {
          return;
        }

        ended = true;
        if (input.onSessionDisconnected) {
          lease.disconnectHandlers.delete(input.onSessionDisconnected);
        }
        lease.refs = Math.max(0, lease.refs - 1);
        if (lease.refs > 0 || sharedDeliveryLeases.get(activeLeaseKey) !== lease) return;
        sharedDeliveryLeases.delete(activeLeaseKey);
        clearInterval(lease.heartbeat);
        if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
        await deps.markRoomAgentDeliveryDisconnected({
          room_id: input.roomId,
          actor_label: identity.actor_label,
          agent_session_id: identity.agent_session_id,
          credential_fence: identity.credential_fence,
        });
        cleanupSharedDeliveryFence(activeLeaseKey, activeFence);
      },
    };
  } finally {
    if (fence && leaseKey) {
      if (setupCredentialFingerprint) {
        const refs = (fence.activeCredentialFingerprints.get(setupCredentialFingerprint) ?? 1) - 1;
        if (refs > 0) fence.activeCredentialFingerprints.set(setupCredentialFingerprint, refs);
        else {
          fence.activeCredentialFingerprints.delete(setupCredentialFingerprint);
          fence.retiredCredentialFingerprints.delete(setupCredentialFingerprint);
        }
      }
      fence.activeSetups = Math.max(0, fence.activeSetups - 1);
      cleanupSharedDeliveryFence(leaseKey, fence);
    }
  }
}

async function createSharedDeliveryLease(
  input: {
    roomId: string;
    transport: RoomAgentDeliveryTransport;
  },
  identity: ResolvedRequestAgentIdentity,
  leaseKey: string,
  creationKey: string,
  fence: SharedDeliveryFence,
  setupGeneration: number,
  deps: RoomAgentDeliveryDeps,
): Promise<SharedDeliveryLease> {
  let connected = false;
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(identity.credential_fence);
  try {
    assertDeliverySetupCurrent(fence, setupGeneration, credentialFingerprint);
    await deps.markRoomAgentDeliveryConnected({
      room_id: input.roomId,
      actor_label: identity.actor_label,
      agent_key: identity.agent_key,
      agent_instance_id: identity.agent_instance_id,
      agent_session_id: identity.agent_session_id,
      session_kind: identity.session_kind,
      runtime: identity.runtime,
      display_name: identity.display_name,
      owner_label: identity.owner_label,
      ide_label: identity.ide_label,
      repo_branch: identity.repo_branch,
      credential_fence: identity.credential_fence,
      transport: input.transport,
    });
    connected = true;
    assertDeliverySetupCurrent(fence, setupGeneration, credentialFingerprint);

    const participantKey = identity.session_kind === "worker"
      ? buildAgentRoomParticipantKey(identity.actor_label)
      : null;
    if (participantKey) {
      await deps.upsertRoomParticipant({
        room_id: input.roomId,
        participant_key: participantKey,
        kind: "agent",
        actor_label: identity.actor_label,
        agent_key: identity.agent_key,
        display_name: identity.display_name,
        owner_label: identity.owner_label,
        ide_label: identity.ide_label,
        last_seen_at: new Date().toISOString(),
        preserve_last_seen_at_on_conflict: true,
      });
      assertDeliverySetupCurrent(fence, setupGeneration, credentialFingerprint);
    }

    let heartbeatInFlight = false;
    let lease!: SharedDeliveryLease;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void deps.markRoomAgentDeliveryHeartbeat({
        room_id: input.roomId,
        actor_label: identity.actor_label,
        agent_session_id: identity.agent_session_id,
        credential_fence: identity.credential_fence,
      }).then((active) => {
        if (active !== false || sharedDeliveryLeases.get(leaseKey) !== lease) return;
        retireSharedDeliveryLease(leaseKey, lease, "inactive credential");
        cleanupSharedDeliveryFence(leaseKey, fence);
      }).catch((error: unknown) => {
        console.error(`[room agent delivery] failed to refresh delivery heartbeat for ${input.roomId}`, error);
      }).finally(() => {
        heartbeatInFlight = false;
      });
    }, deps.heartbeatIntervalMs);
    heartbeat.unref?.();
    lease = {
      identity,
      refs: 0,
      heartbeat,
      expiryTimer: null,
      disconnectHandlers: new Set(),
    };
    if (identity.credential_fence?.kind === "bearer" && identity.credential_fence.expires_at) {
      const delay = Math.max(0, Date.parse(identity.credential_fence.expires_at) - Date.now());
      if (Number.isFinite(delay) && delay <= 0x7fffffff) {
        lease.expiryTimer = setTimeout(() => {
          void deps.markRoomAgentDeliveryHeartbeat({
            room_id: input.roomId,
            actor_label: identity.actor_label,
            agent_session_id: identity.agent_session_id,
            credential_fence: identity.credential_fence,
          }).catch((error: unknown) => {
            console.error(`[room agent delivery] failed to retire expired delivery for ${input.roomId}`, error);
          }).finally(() => {
            if (sharedDeliveryLeases.get(leaseKey) === lease
              && isRoomAgentDeliveryCredentialExpired(identity.credential_fence)) {
              retireSharedDeliveryLease(leaseKey, lease, "credential expiry");
              cleanupSharedDeliveryFence(leaseKey, fence);
            }
          });
        }, delay);
        lease.expiryTimer.unref?.();
      }
    }
    assertDeliverySetupCurrent(fence, setupGeneration, credentialFingerprint);
    sharedDeliveryLeases.set(leaseKey, lease);
    return lease;
  } catch (error) {
    if (connected) {
      await deps.markRoomAgentDeliveryDisconnected({
        room_id: input.roomId,
        actor_label: identity.actor_label,
        agent_session_id: identity.agent_session_id,
        credential_fence: identity.credential_fence,
      }).catch(() => undefined);
    }
    if (error instanceof InactiveRoomAgentDeliverySessionError) {
      throw new InvalidRoomAgentDeliverySessionError("Agent delivery session is no longer active.");
    }
    throw error;
  } finally {
    sharedDeliveryLeaseCreations.delete(creationKey);
  }
}
