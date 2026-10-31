import assert from "node:assert/strict";
import test from "node:test";

import { githubRepoAccessInvalidationEvents } from "../github/repo-access.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { acquireLiveRoomAuthorization } from "../rooms/live-authorization.js";
import { roomEventBridgeLossEvents } from "../server/bridged-emitter.js";
import {
  bearerDeliveryCredentialFingerprint,
  roomAgentCredentialInvalidationEvents,
} from "../rooms/agent-credential-events.js";

function authenticatedRequest(credential: string): AuthenticatedRequest {
  return {
    headers: { authorization: `Bearer ${credential}` },
    authKind: "user_token",
    sessionAccount: { account_id: "account_1", login: "EmmyMay" },
  } as unknown as AuthenticatedRequest;
}

test("live room authorization shares rechecks and reacts only to matching invalidations", async () => {
  let now = 0;
  let checks = 0;
  const authorize = async () => {
    checks += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return true;
  };
  const input = {
    req: authenticatedRequest("shared-credential"),
    roomId: "room_auth_shared",
    accessRoomName: "github.com/example/private",
    authorize,
    now: () => now,
  };
  const first = acquireLiveRoomAuthorization(input);
  const second = acquireLiveRoomAuthorization(input);
  const invalidationChecks: Promise<boolean>[] = [];
  const removeFirst = first.onInvalidated(() => {
    invalidationChecks.push(first.check({ force: true }));
  });
  const removeSecond = second.onInvalidated(() => {
    invalidationChecks.push(second.check({ force: true }));
  });

  assert.deepEqual(await Promise.all([
    first.check(),
    second.check(),
  ]), [true, true]);
  assert.equal(checks, 1, "the first live delivery is fresh and shared across connections");

  githubRepoAccessInvalidationEvents.emit("invalidate", {
    roomName: "github.com/example/other",
    login: "emmymay",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invalidationChecks.length, 0);

  githubRepoAccessInvalidationEvents.emit("invalidate", {
    roomName: "github.com/example/private",
    login: "emmymay",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invalidationChecks.length, 2, "all live sockets are woken immediately");
  assert.deepEqual(await Promise.all(invalidationChecks), [true, true]);
  assert.equal(checks, 2, "matching invalidation still causes only one upstream recheck");

  now = 60_001;
  assert.deepEqual(await Promise.all([first.check(), second.check()]), [true, true]);
  assert.equal(checks, 3, "expired leases are also process-shared");

  removeFirst();
  removeSecond();
  first.release();
  second.release();
});

test("failed live authorization checks fail closed without caching a denial", async () => {
  let checks = 0;
  const lease = acquireLiveRoomAuthorization({
    req: authenticatedRequest("retry-credential"),
    roomId: "room_auth_retry",
    accessRoomName: "github.com/example/retry",
    authorize: async () => {
      checks += 1;
      if (checks === 1) throw new Error("temporary GitHub failure");
      return true;
    },
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await lease.check({ force: true }), false);
    assert.equal(await lease.check(), true);
    assert.equal(checks, 2);
  } finally {
    console.error = originalError;
    lease.release();
  }
});

test("a matching revocation invalidation replaces a prior allow before the next body", async () => {
  let allowed = true;
  const lease = acquireLiveRoomAuthorization({
    req: authenticatedRequest("revoked-credential"),
    roomId: "room_auth_revoked",
    accessRoomName: "github.com/example/revoked",
    authorize: async () => allowed,
  });
  assert.equal(await lease.check(), true, "the legitimate collaborator is initially allowed");

  let invalidationCheck: Promise<boolean> | null = null;
  const remove = lease.onInvalidated(() => {
    invalidationCheck = lease.check({ force: true });
  });
  allowed = false;
  githubRepoAccessInvalidationEvents.emit("invalidate", {
    roomName: "github.com/example/revoked",
    login: "emmymay",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(invalidationCheck);
  assert.equal(await invalidationCheck, false, "the stale allow cannot authorize another live body");
  assert.equal(await lease.check(), false, "the denial remains active for the bounded lease window");

  remove();
  lease.release();
});

test("an invalidation racing an in-flight allow forces a trailing generation check", async () => {
  let checks = 0;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  const lease = acquireLiveRoomAuthorization({
    req: authenticatedRequest("generation-credential"),
    roomId: "room_auth_generation",
    accessRoomName: "github.com/example/generation",
    authorize: async () => {
      checks += 1;
      if (checks === 1) {
        firstStarted();
        await firstGate;
        return true;
      }
      return false;
    },
  });
  const checking = lease.check();
  await firstStart;
  githubRepoAccessInvalidationEvents.emit("invalidate", {
    roomName: "github.com/example/generation",
    login: "emmymay",
  });
  releaseFirst();
  assert.equal(await checking, false, "the stale allow is never exposed to a waiting body");
  assert.equal(checks, 2, "the shared flight owns one trailing fresh generation");
  assert.equal(await lease.check(), false);
  lease.release();
});

test("an invalidation storm bounds one shared flight and leaves a later retry available", async () => {
  let checks = 0;
  const releases: Array<() => void> = [];
  const starts: Array<Promise<void>> = [];
  const startResolvers: Array<() => void> = [];
  for (let index = 0; index < 2; index += 1) {
    starts.push(new Promise<void>((resolve) => startResolvers.push(resolve)));
  }
  const lease = acquireLiveRoomAuthorization({
    req: authenticatedRequest("storm-credential"),
    roomId: "room_auth_storm",
    accessRoomName: "github.com/example/storm",
    authorize: async () => {
      checks += 1;
      if (checks <= 2) {
        startResolvers[checks - 1]!();
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return true;
    },
  });

  const checking = lease.check();
  await starts[0];
  githubRepoAccessInvalidationEvents.emit("invalidate", {
    roomName: "github.com/example/storm",
    login: "emmymay",
  });
  releases.shift()!();
  await starts[1];
  githubRepoAccessInvalidationEvents.emit("invalidate", {
    roomName: "github.com/example/storm",
    login: "emmymay",
  });
  releases.shift()!();

  assert.equal(await checking, false, "a twice-raced flight fails closed");
  assert.equal(checks, 2, "one event cannot cause an unbounded upstream recheck loop");
  assert.equal(await lease.check(), true, "the invalidated lease remains retryable");
  assert.equal(checks, 3);
  lease.release();
});

test("a bridge loss marker retires cached authorization before the next body", async () => {
  let checks = 0;
  const lease = acquireLiveRoomAuthorization({
    req: authenticatedRequest("bridge-loss-credential"),
    roomId: "room_auth_bridge_loss",
    accessRoomName: "github.com/example/bridge-loss",
    authorize: async () => {
      checks += 1;
      return checks === 1;
    },
  });

  try {
    assert.equal(await lease.check(), true);
    roomEventBridgeLossEvents.emit("loss", {
      epoch: 1,
      reason: "remote_publish_loss",
      roomId: null,
    });
    assert.equal(
      await lease.check(),
      false,
      "a possibly-dropped revocation cannot leave the shared allow lease live",
    );
    assert.equal(checks, 2);
  } finally {
    lease.release();
  }
});

test("exact credential retirement closes only the predecessor generation", async () => {
  const request = (bearerId: string, generation: number) => ({
    headers: { authorization: `Bearer ${bearerId}-${generation}` },
    authKind: "agent_session",
    agentSession: {
      bearer_id: bearerId,
      bearer_generation: generation,
    },
  }) as unknown as AuthenticatedRequest;
  const authorize = async () => true;
  const predecessor = acquireLiveRoomAuthorization({
    req: request("bearer_shared", 1),
    roomId: "room_credential_rotation",
    accessRoomName: "room_credential_rotation",
    authorize,
  });
  const successor = acquireLiveRoomAuthorization({
    req: request("bearer_shared", 2),
    roomId: "room_credential_rotation",
    accessRoomName: "room_credential_rotation",
    authorize,
  });
  assert.equal(await predecessor.check(), true);
  assert.equal(await successor.check(), true);

  roomAgentCredentialInvalidationEvents.emitLocal("invalidate", {
    room_id: "room_credential_rotation",
    agent_session_id: "session_shared",
    credential_fingerprints: [bearerDeliveryCredentialFingerprint("bearer_shared", 1)],
    reason: "rotated",
  });
  assert.equal(await predecessor.check(), false, "v1 cannot authorize another body after rotation");
  assert.equal(await successor.check(), true, "the exact v2 generation remains live");
  predecessor.release();
  successor.release();
});

test("a lease seeded fresh at entry serves the first body without a recheck, then expires normally", async () => {
  let now = 0;
  let checks = 0;
  const lease = acquireLiveRoomAuthorization({
    req: authenticatedRequest("fresh-at-entry-credential"),
    roomId: "room_auth_fresh_entry",
    accessRoomName: "room_auth_fresh_entry",
    authorize: async () => {
      checks += 1;
      return true;
    },
    freshAtEntry: true,
    now: () => now,
  });
  try {
    assert.equal(await lease.check(), true);
    assert.equal(checks, 0, "the entry check of the same request already made this decision");
    now = 60_001;
    assert.equal(await lease.check(), true);
    assert.equal(checks, 1, "the periodic recheck still runs once the lease window expires");
  } finally {
    lease.release();
  }
});

test("a bridge loss marker leaves human leases in rooms without a repository alone", async () => {
  const checks = { adHoc: 0, repo: 0 };
  const adHoc = acquireLiveRoomAuthorization({
    req: authenticatedRequest("bridge-loss-ad-hoc-credential"),
    roomId: "room_auth_bridge_loss_ad_hoc",
    accessRoomName: "room_auth_bridge_loss_ad_hoc",
    authorize: async () => {
      checks.adHoc += 1;
      return true;
    },
  });
  const repo = acquireLiveRoomAuthorization({
    req: authenticatedRequest("bridge-loss-repo-credential"),
    roomId: "room_auth_bridge_loss_repo",
    accessRoomName: "github.com/example/bridge-loss-scope",
    authorize: async () => {
      checks.repo += 1;
      return true;
    },
  });
  const invalidated = { adHoc: 0, repo: 0 };
  const removeAdHoc = adHoc.onInvalidated(() => { invalidated.adHoc += 1; });
  const removeRepo = repo.onInvalidated(() => { invalidated.repo += 1; });
  try {
    assert.deepEqual(await Promise.all([adHoc.check(), repo.check()]), [true, true]);
    assert.deepEqual(checks, { adHoc: 1, repo: 1 });

    roomEventBridgeLossEvents.emit("loss", {
      epoch: 2,
      reason: "listener_disconnected",
      roomId: null,
    });
    assert.deepEqual(invalidated, { adHoc: 0, repo: 1 }, "only bridge-borne authorization is retired");
    assert.deepEqual(await Promise.all([adHoc.check(), repo.check()]), [true, true]);
    assert.deepEqual(
      checks,
      { adHoc: 1, repo: 2 },
      "a session revoked in the database never travels over the bridge, so no forced read is needed",
    );
  } finally {
    removeAdHoc();
    removeRepo();
    adHoc.release();
    repo.release();
  }
});
