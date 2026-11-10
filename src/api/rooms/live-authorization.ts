import { createHash } from "node:crypto";

import { githubRepoAccessInvalidationEvents } from "../github/repo-access.js";
import { parseCookies, type AuthenticatedRequest } from "../http/helpers.js";
import { parseBearerAuthorization } from "../request/bearer-authorization.js";
import { createBridgedEmitter, roomEventBridgeLossEvents } from "../server/bridged-emitter.js";
import { roomMembershipInvalidationEvents } from "./membership-events.js";
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
  /** The hash of the person's session or owner token this lease is keyed by, if any. */
  accountCredentialHash: string | null;
  invalidationGeneration: number;
  /** When the last check threw (no answer), else null. */
  failedAt: number | null;
  inFlight: Promise<boolean> | null;
  refs: number;
  invalidationHandlers: Set<() => void>;
}

export interface LiveRoomAuthorizationLease {
  check(options?: { force?: boolean }): Promise<boolean>;
  /** True when the last check got no answer (it threw): a false that is not a refusal. */
  lastCheckFailed(): boolean;
  onInvalidated(handler: () => void): () => void;
  release(): void;
}

const leases = new Map<string, SharedAuthorizationLease>();

/**
 * A person's app session or owner token ended (sign-out, token revocation).
 * The payload names only hashes of the credentials, never the tokens. Every
 * live lease keyed by one of them is retired at once, so room streams and
 * the account activity stream of that credential close at once, on every
 * API instance.
 */
export const accountCredentialRetirementEvents = createBridgedEmitter("account_credentials");
// One listener per open account activity stream, plus the lease listener.
accountCredentialRetirementEvents.setMaxListeners(0);

/** The hash a live lease keys a person's token by. */
export function accountCredentialHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Retires every live lease of these app session or owner tokens. */
export function retireAccountCredentials(tokens: readonly string[]): void {
  const hashes = [...new Set(tokens.filter(Boolean).map(accountCredentialHash))];
  if (hashes.length) accountCredentialRetirementEvents.emit("retire", { credential_hashes: hashes });
}

/** The person's token behind a request: a bearer token, else the session cookie. */
function requestAccountToken(req: AuthenticatedRequest): string | null {
  const bearer = parseBearerAuthorization(req.headers?.authorization as string | undefined);
  if (bearer.kind === "token") return bearer.token;
  if (bearer.kind === "invalid") return null;
  return parseCookies(req.headers?.cookie).letagents_session || null;
}

/** Calls `handler` once this request's own app session or owner token is retired. Returns the unsubscribe. */
export function onRequestCredentialRetired(req: AuthenticatedRequest, handler: () => void): () => void {
  const token = requestAccountToken(req);
  if (!token) return () => undefined;
  const hash = accountCredentialHash(token);
  const listener = (payload: unknown) => {
    const hashes = payload && typeof payload === "object" ? (payload as { credential_hashes?: unknown }).credential_hashes : null;
    if (Array.isArray(hashes) && hashes.includes(hash)) handler();
  };
  accountCredentialRetirementEvents.on("retire", listener);
  return () => { accountCredentialRetirementEvents.off("retire", listener); };
}

accountCredentialRetirementEvents.on("retire", (payload: unknown) => {
  const hashes = payload && typeof payload === "object" ? (payload as { credential_hashes?: unknown }).credential_hashes : null;
  if (!Array.isArray(hashes)) return;
  const retired = new Set(hashes.filter((value): value is string => typeof value === "string"));
  for (const lease of leases.values()) {
    if (!lease.accountCredentialHash || !retired.has(lease.accountCredentialHash)) continue;
    lease.credentialRetired = true;
    lease.invalidated = true;
    lease.invalidationGeneration += 1;
    for (const handler of lease.invalidationHandlers) {
      try {
        handler();
      } catch (error) {
        console.error("[room authorization] account credential retirement handler failed", error);
      }
    }
  }
});

function invalidateAuthorizationLeases(
  roomName: string | null,
  login: string | null,
  shouldInvalidate: (lease: SharedAuthorizationLease) => boolean = () => true,
): void {
  for (const lease of leases.values()) {
    if (roomName && lease.roomName !== roomName) continue;
    if (login && lease.login !== login) continue;
    if (!shouldInvalidate(lease)) continue;
    lease.invalidated = true;
    lease.failedAt = null;
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

roomMembershipInvalidationEvents.on("invalidate", (payload: unknown) => {
  const invalidation = payload && typeof payload === "object"
    ? payload as { roomId?: unknown; login?: unknown }
    : {};
  if (typeof invalidation.roomId !== "string" || typeof invalidation.login !== "string") return;
  invalidateAuthorizationLeases(invalidation.roomId, invalidation.login);
});

roomEventBridgeLossEvents.on("loss", (payload: unknown) => {
  const reason = payload && typeof payload === "object"
    ? (payload as { reason?: unknown }).reason
    : null;
  if (reason === "uninterested_reference" || reason === "listener_connected_boundary") return;
  // A dropped cross-instance frame may itself have been a revocation: a
  // repository access change, a worker credential retirement or a person
  // leaving a room. Treat the compact durable loss marker as a global
  // authorization invalidation; leases still coalesce the resulting fresh
  // checks per room/credential.
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
  /** The caller's entry check was exact (no cache), so the first body needs no recheck. */
  freshAtEntry?: boolean;
  /**
   * Leases of different scopes never share a decision (the account activity
   * stream decides from cached answers, room streams freshly).
   */
  scope?: string;
  /** How long an answer is reused. Defaults to 60 s. */
  leaseMs?: number;
  /**
   * After a check that got no answer, how long a plain check answers false
   * without asking again. Defaults to 0 (ask again at once).
   */
  failureRetryMs?: number;
  now?: () => number;
}): LiveRoomAuthorizationLease {
  const now = input.now ?? (() => Date.now());
  const leaseMs = input.leaseMs ?? AUTHORIZATION_LEASE_MS;
  const failureRetryMs = input.failureRetryMs ?? 0;
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(
    input.deliveryCredentialFence ?? requestAgentCredentialFence(input.req),
  );
  const key = `${input.scope ?? "room"}\n${input.roomId}\n${requestCredentialKey(input.req)}\n${credentialFingerprint ?? "shared"}`;
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
      // keep extending a stale allow decision indefinitely. A caller whose
      // entry check was itself exact seeds the lease as fresh instead.
      invalidated: !input.freshAtEntry,
      credentialFingerprint,
      credentialRetired: false,
      accountCredentialHash: input.req.authKind === "agent_session" ? null : (() => {
        const token = requestAccountToken(input.req);
        return token ? accountCredentialHash(token) : null;
      })(),
      invalidationGeneration: 1,
      failedAt: null,
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
    if (!options.force && !lease!.invalidated && now() - lease!.checkedAt < leaseMs) {
      return Promise.resolve(lease!.allowed);
    }
    if (!options.force && lease!.failedAt !== null && now() - lease!.failedAt < failureRetryMs) {
      return Promise.resolve(false);
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
          lease!.failedAt = now();
          lease!.invalidated = true;
          if (failureRetryMs === 0) console.error("[room authorization] live recheck failed", error);
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
        lease!.failedAt = null;
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
    lastCheckFailed: () => lease!.failedAt !== null,
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
