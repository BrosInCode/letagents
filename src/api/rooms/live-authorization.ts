import { createHash } from "node:crypto";

import { githubRepoAccessInvalidationEvents } from "../github/repo-access.js";
import { parseCookies, type AuthenticatedRequest } from "../http/helpers.js";
import { roomEventBridgeLossEvents } from "../server/bridged-emitter.js";
import type { RoomAgentDeliveryCredentialFence } from "../../shared/agent-presence.js";
import {
  roomAgentCredentialInvalidationEvents,
  roomAgentDeliveryCredentialFingerprint,
} from "./agent-credential-events.js";

const AUTHORIZATION_LEASE_MS = 60_000;
// A sustained invalidation storm must not turn one delivered event into an
// unbounded series of upstream GitHub checks. One initial check plus one
// trailing generation is enough to avoid publishing stale authorization; if
// the trailing check also races, fail closed and let the next event retry.
const MAX_AUTHORIZATION_CHECKS_PER_FLIGHT = 2;

interface SharedAuthorizationLease {
  roomId: string;
  roomName: string;
  login: string | null;
  authorize: () => Promise<boolean>;
  allowed: boolean;
  checkedAt: number;
  invalidated: boolean;
  credentialFingerprint: string | null;
  credentialRetired: boolean;
  invalidationGeneration: number;
  inFlight: Promise<boolean> | null;
  refs: number;
  invalidationHandlers: Set<() => void>;
}

export interface LiveRoomAuthorizationLease {
  check(options?: { force?: boolean }): Promise<boolean>;
  onInvalidated(handler: () => void): () => void;
  release(): void;
}

const leases = new Map<string, SharedAuthorizationLease>();

function invalidateAuthorizationLeases(roomName: string | null, login: string | null): void {
  for (const lease of leases.values()) {
    if (roomName && lease.roomName !== roomName) continue;
    if (login && lease.login !== login) continue;
    lease.invalidated = true;
    lease.invalidationGeneration += 1;
    for (const handler of lease.invalidationHandlers) {
      try {
        handler();
      } catch (error) {
        console.error("[room authorization] invalidation handler failed", error);
      }
    }
  }
}

githubRepoAccessInvalidationEvents.on("invalidate", (payload: unknown) => {
  const invalidation = payload && typeof payload === "object"
    ? payload as { roomName?: unknown; login?: unknown }
    : {};
  invalidateAuthorizationLeases(
    typeof invalidation.roomName === "string" ? invalidation.roomName : null,
    typeof invalidation.login === "string" ? invalidation.login : null,
  );
});

roomEventBridgeLossEvents.on("loss", (payload: unknown) => {
  const reason = payload && typeof payload === "object"
    ? (payload as { reason?: unknown }).reason
    : null;
  if (reason === "uninterested_reference" || reason === "listener_connected_boundary") return;
  // A dropped cross-instance frame may itself have been a revocation. Treat
  // the compact durable loss marker as a global authorization invalidation;
  // leases still coalesce the resulting fresh checks per room/credential.
  invalidateAuthorizationLeases(null, null);
});

roomAgentCredentialInvalidationEvents.on("invalidate", (payload: unknown) => {
  const invalidation = payload && typeof payload === "object"
    ? payload as { room_id?: unknown; credential_fingerprints?: unknown }
    : {};
  const roomId = typeof invalidation.room_id === "string" ? invalidation.room_id : null;
  const fingerprints = new Set(
    Array.isArray(invalidation.credential_fingerprints)
      ? invalidation.credential_fingerprints.filter(
          (value): value is string => typeof value === "string" && Boolean(value),
        )
      : [],
  );
  if (!roomId || fingerprints.size === 0) return;
  for (const lease of leases.values()) {
    if (
      lease.roomId !== roomId
      || !lease.credentialFingerprint
      || !fingerprints.has(lease.credentialFingerprint)
    ) continue;
    lease.credentialRetired = true;
    lease.invalidated = true;
    lease.invalidationGeneration += 1;
    for (const handler of lease.invalidationHandlers) {
      try {
        handler();
      } catch (error) {
        console.error("[room authorization] credential invalidation handler failed", error);
      }
    }
  }
});

/**
 * Acquires a process-shared, expiring authorization decision. Every active
 * connection for one exact credential/room shares the same fresh GitHub check,
 * while webhook invalidations wake it immediately.
 */
export function acquireLiveRoomAuthorization(input: {
  req: AuthenticatedRequest;
  roomId: string;
  accessRoomName: string;
  authorize: () => Promise<boolean>;
  deliveryCredentialFence?: RoomAgentDeliveryCredentialFence | null;
  initiallyAllowed?: boolean;
  now?: () => number;
}): LiveRoomAuthorizationLease {
  const now = input.now ?? Date.now;
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(
    input.deliveryCredentialFence ?? requestAgentCredentialFence(input.req),
  );
  const key = `${input.roomId}\n${requestCredentialKey(input.req)}\n${credentialFingerprint ?? "shared"}`;
  let lease = leases.get(key);
  if (!lease) {
    lease = {
      roomId: input.roomId,
      roomName: input.accessRoomName.trim().toLowerCase(),
      login: input.req.sessionAccount?.login?.trim().toLowerCase() || null,
      authorize: input.authorize,
      allowed: input.initiallyAllowed ?? true,
      checkedAt: now(),
      // The entry route may have used a visibility/access cache. Force one
      // fresh shared check before the first live body so reconnecting cannot
      // keep extending a stale allow decision indefinitely.
      invalidated: true,
      credentialFingerprint,
      credentialRetired: false,
      invalidationGeneration: 1,
      inFlight: null,
      refs: 0,
      invalidationHandlers: new Set(),
    };
    leases.set(key, lease);
  }
  lease.refs += 1;
  let released = false;

  const check = (options: { force?: boolean } = {}): Promise<boolean> => {
    if (lease!.credentialRetired) return Promise.resolve(false);
    if (!options.force && !lease!.invalidated && now() - lease!.checkedAt < AUTHORIZATION_LEASE_MS) {
      return Promise.resolve(lease!.allowed);
    }
    if (lease!.inFlight) return lease!.inFlight;
    let pending!: Promise<boolean>;
    pending = (async () => {
      for (let attempt = 0; attempt < MAX_AUTHORIZATION_CHECKS_PER_FLIGHT; attempt += 1) {
        const checkedGeneration = lease!.invalidationGeneration;
        let allowed: boolean;
        try {
          allowed = await lease!.authorize();
        } catch (error) {
          // Delivery is fail-closed: a dependency failure is not cached as a
          // revocation, but this event must not pass on a stale allow decision.
          lease!.checkedAt = now();
          lease!.invalidated = true;
          console.error("[room authorization] live recheck failed", error);
          return false;
        }
        if (lease!.credentialRetired) return false;
        if (checkedGeneration !== lease!.invalidationGeneration) {
          // A webhook/bridge invalidation raced the request. Never publish the
          // stale allow; the shared flight owns exactly one trailing fresh
          // check. A second race fails closed and remains invalidated so later
          // traffic can retry without amplifying this event into more calls.
          continue;
        }
        lease!.allowed = allowed;
        lease!.checkedAt = now();
        lease!.invalidated = false;
        return allowed;
      }
      return false;
    })().finally(() => {
      if (lease!.inFlight === pending) lease!.inFlight = null;
    });
    lease!.inFlight = pending;
    return pending;
  };

  return {
    check,
    onInvalidated(handler) {
      lease!.invalidationHandlers.add(handler);
      return () => lease!.invalidationHandlers.delete(handler);
    },
    release() {
      if (released) return;
      released = true;
      lease!.refs = Math.max(0, lease!.refs - 1);
      if (lease!.refs === 0 && leases.get(key) === lease) leases.delete(key);
    },
  };
}

function requestAgentCredentialFence(
  req: AuthenticatedRequest,
): RoomAgentDeliveryCredentialFence | null {
  if (req.authKind !== "agent_session" || !req.agentSession) return null;
  return {
    kind: "bearer",
    bearer_id: req.agentSession.bearer_id,
    generation: req.agentSession.bearer_generation,
  };
}

function requestCredentialKey(req: AuthenticatedRequest): string {
  if (req.authKind === "agent_session" && req.agentSession) {
    return `agent:${req.agentSession.bearer_id}:${req.agentSession.bearer_generation}`;
  }
  const authorization = String(req.headers?.authorization ?? "");
  const sessionToken = parseCookies(req.headers?.cookie).letagents_session ?? "";
  const credential = authorization || sessionToken;
  if (credential) {
    return `${req.authKind ?? "unknown"}:${createHash("sha256").update(credential).digest("base64url")}`;
  }
  return `${req.authKind ?? "anonymous"}:${req.sessionAccount?.account_id ?? "anonymous"}`;
}
