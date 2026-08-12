import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express, { type Express } from "express";

process.env.DB_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/letagents_test";

const { deriveRentalCapabilityEnvelope } = await import("../rental/sessions/create.js");
const {
  canAcceptRentalDaemonGeneration,
  isRentalHostFresh,
  projectPublicRentalOffer,
  RENTAL_HOST_FRESHNESS_MS,
  safePublicRentalAvatarUrl,
} = await import("../rental/provider-hosts.js");
const {
  isRentalLaunchRetry,
  rentalLaunchIdentityReset,
} = await import("../rental/sessions/transitions.js");
const { decodeRentalProviderEventCursor, encodeRentalProviderEventCursor } = await import("../rental/provider-events.js");
const { registerRentalRenterRoutes } = await import("../routes/rental/renter/index.js");
const { registerRentalProviderHostRoutes } = await import("../routes/rental/provider-hosts.js");
const { registerRentalProviderRoutes } = await import("../routes/rental/provider.js");
const { registerActivityLifecycleRoutes } = await import("../routes/rental/internal/activity-lifecycle-routes.js");
const { projectRentalProviderRequest } = await import("../routes/rental/provider.js");
const {
  assertRentalLaunchAcknowledgementMonotonic,
  rentalLaunchAcknowledgementPriorStates,
  rentalLaunchAcknowledgementPriorStatuses,
} = await import("../rental/session-launch.js");
const {
  assertRentalHostRuntimeSafe,
  assertRentalRuntimeSelectionSafe,
  isRentalRuntimeSelectionSafe,
} = await import("../rental/runtime-policy.js");

const previousRentFlag = process.env.LETAGENTS_RENT_ENABLED;

function authenticated(app: Express, authKind: "session" | "owner_token" = "session"): void {
  app.use((req, _res, next) => {
    Object.assign(req, {
      authKind,
      sessionAccount: {
        account_id: "acct_renter",
        login: "Renter",
        display_name: "Renter",
      },
    });
    next();
  });
  app.use(express.json());
}

async function listen(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

before(() => { process.env.LETAGENTS_RENT_ENABLED = "true"; });
after(() => {
  if (previousRentFlag === undefined) delete process.env.LETAGENTS_RENT_ENABLED;
  else process.env.LETAGENTS_RENT_ENABLED = previousRentFlag;
});

describe("rental marketplace supervised primitives", () => {
  it("derives a room-only capability envelope instead of trusting renter JSON", () => {
    const envelope = deriveRentalCapabilityEnvelope({
      listingId: "listing_1",
      renterAccountId: "acct_1",
      targetRoomId: "room_1",
      roomHistoryAccess: "full",
      taskTitle: "Help",
      taskPrompt: "Continue",
      capabilityEnvelope: { commands: true, network: true },
    });
    assert.deepEqual(envelope, {
      room: { id: "room_1", history: "full" },
      repository: null,
      commands: false,
      network: false,
      externalActions: false,
    });
  });

  it("normalizes direct-room history to the only launch scope currently enforced", () => {
    const envelope = deriveRentalCapabilityEnvelope({
      listingId: "listing_1",
      renterAccountId: "acct_1",
      targetRoomId: "room_1",
      roomHistoryAccess: "filtered",
      taskTitle: "Help",
      taskPrompt: "Continue",
    });
    assert.deepEqual(envelope.room, { id: "room_1", history: "full" });
  });

  it("uses a strict 90 second provider heartbeat freshness window", () => {
    const now = Date.now();
    assert.equal(isRentalHostFresh(new Date(now - RENTAL_HOST_FRESHNESS_MS), now), true);
    assert.equal(isRentalHostFresh(new Date(now - RENTAL_HOST_FRESHNESS_MS - 1), now), false);
  });

  it("fences stale provider daemons while allowing the live generation to advance", () => {
    assert.equal(canAcceptRentalDaemonGeneration(null, null), true);
    assert.equal(canAcceptRentalDaemonGeneration(null, 4), true);
    assert.equal(canAcceptRentalDaemonGeneration(4, 4), true);
    assert.equal(canAcceptRentalDaemonGeneration(4, 5), true);
    assert.equal(canAcceptRentalDaemonGeneration(5, 4), false);
    assert.equal(canAcceptRentalDaemonGeneration(5, null), false);
  });

  it("retries failed launches without reusing the prior daemon binding", () => {
    assert.equal(isRentalLaunchRetry("accepted", "launch_failed"), true);
    assert.equal(isRentalLaunchRetry("requested", "launch_failed"), false);
    assert.deepEqual(rentalLaunchIdentityReset(), {
      daemon_entry_id: null,
      room_agent_session_id: null,
    });
  });

  it("owns the rental-safe runtime policy on the server", () => {
    assert.equal(isRentalRuntimeSelectionSafe({ kind: "cursor", permissionProfileId: "sandboxed_write" }), true);
    assert.equal(isRentalRuntimeSelectionSafe({ kind: "cursor" }), false);
    assert.equal(isRentalRuntimeSelectionSafe({ kind: "codex", permissionProfileId: "full_access" }), false);
    assert.deepEqual(assertRentalRuntimeSelectionSafe({
      kind: " Cursor ",
      permissionProfileId: "sandboxed_write",
      modelLabel: "auto",
    }), {
      kind: "cursor",
      permissionProfileId: "sandboxed_write",
      modelLabel: "auto",
    });
    assert.throws(() => assertRentalHostRuntimeSafe({
      kind: "cursor",
      label: "Cursor",
      authenticated: true,
      permissionProfiles: ["sandboxed_write", "full_access"],
    }), /unsafe_rental_runtime_profile/);
  });

  it("does not allow a failed acknowledgement to regress an active launch", () => {
    assert.doesNotThrow(() => assertRentalLaunchAcknowledgementMonotonic("active", "active"));
    assert.throws(
      () => assertRentalLaunchAcknowledgementMonotonic("active", "launch_failed"),
      /launch_already_active/,
    );
    assert.doesNotThrow(() => assertRentalLaunchAcknowledgementMonotonic("provisioning", "launch_failed"));
    assert.deepEqual(rentalLaunchAcknowledgementPriorStates("active"), ["provisioning"]);
    assert.deepEqual(rentalLaunchAcknowledgementPriorStatuses("active"), ["provisioning"]);
    assert.deepEqual(
      rentalLaunchAcknowledgementPriorStatuses("launch_failed"),
      ["accepted", "provisioning"],
    );
    assert.deepEqual(
      rentalLaunchAcknowledgementPriorStates("launch_failed"),
      ["pending", "provisioning", "launch_failed"],
    );
    assert.throws(
      () => assertRentalLaunchAcknowledgementMonotonic("launch_failed", "active"),
      /launch_state_transition_invalid/,
    );
  });

  it("round trips opaque durable event cursors and rejects malformed values", () => {
    const cursor = { createdAt: new Date("2026-08-09T10:00:00.000Z"), id: "rpevt_1" };
    assert.deepEqual(decodeRentalProviderEventCursor(encodeRentalProviderEventCursor(cursor)), cursor);
    assert.equal(decodeRentalProviderEventCursor("not-a-cursor"), null);
  });

  it("maps the dedicated request expiry into the existing provider request contract", () => {
    const expiry = new Date("2026-08-09T10:15:00.000Z");
    const projected = projectRentalProviderRequest({
      id: "rsess_1",
      request_expires_at: expiry,
      expires_at: undefined,
    });
    assert.equal(projected.expires_at, expiry);
  });

  it("scopes the provider capacity dashboard to the requesting desktop host", async () => {
    const app = express();
    authenticated(app, "owner_token");
    let received: { accountId: string; hostId: string | null | undefined; installationId: string | null | undefined } | null = null;
    registerRentalProviderRoutes(app, {
      async listProviderSessions(accountId: string, hostId?: string | null, installationId?: string | null) {
        received = { accountId, hostId, installationId };
        return [{ id: "rsess_local" }];
      },
    } as never);
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/provider/sessions?hostId=host_desktop_1&installationId=install_1`);
      assert.equal(response.status, 200);
      assert.deepEqual(received, { accountId: "acct_renter", hostId: "host_desktop_1", installationId: "install_1" });
      assert.deepEqual(await response.json(), { sessions: [{ id: "rsess_local" }] });
    } finally { await server.close(); }
  });

  it("allows only GitHub's avatar CDN in public marketplace image URLs", () => {
    assert.equal(
      safePublicRentalAvatarUrl("https://avatars.githubusercontent.com/u/123?v=4"),
      "https://avatars.githubusercontent.com/u/123?v=4",
    );
    assert.equal(safePublicRentalAvatarUrl("https://tracker.example/pixel.gif"), null);
    assert.equal(safePublicRentalAvatarUrl("http://avatars.githubusercontent.com/u/123"), null);
    assert.equal(safePublicRentalAvatarUrl("not a URL"), null);
  });

  it("returns a person-grouped provider DTO compatible with the Desktop listing mapper", async () => {
    const app = express();
    authenticated(app);
    let marketplaceViewer: string | undefined;
    const offer = projectPublicRentalOffer({
      id: "listing_1",
      display_name: "Codex",
      verification_status: "experimental",
      readiness_badges: ["desktop_host"],
      ide_kind: "codex",
      model_label: null,
      quota_lane_label: null,
      meter_confidence: "unknown",
      native_quota_unit: "unknown",
      last_lrt_estimate: null,
      last_quota_reset_at: null,
      supported_modes: ["scoped"],
      max_concurrent_sessions: 2,
      default_lrt_limit: 50_000,
      default_time_limit_minutes: 30,
      manual_accept_required: true,
      created_at: new Date("2026-08-09T10:00:00.000Z"),
      updated_at: new Date("2026-08-09T10:00:00.000Z"),
    } as never, "Provider Person", 1);
    registerRentalRenterRoutes(app, {
      publicListings: async () => [],
      publicProviders: async (viewerAccountId) => {
        marketplaceViewer = viewerAccountId;
        return [{
        providerKey: "provider",
        accountId: "provider",
        displayName: "Provider Person",
        login: "Provider",
        avatarUrl: "https://avatars.example/provider",
        availability: "available",
        availableSlots: 1,
        maxConcurrentSessions: 1,
        supportsRepository: false,
        maxDurationMinutes: 30,
        runtimes: [{ kind: "codex", label: "Codex" }],
        offers: [offer],
      }];
      },
      shouldAllowListingsQuery: () => true,
      createSession: async () => ({}) as never,
      getSessionById: async () => null,
      cancelSession: async () => null,
    });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/providers`);
      assert.equal(response.status, 200);
      const body = await response.json() as { providers: Array<Record<string, unknown>> };
      const provider = body.providers[0]!;
      assert.equal(provider.accountId, "provider");
      assert.equal(provider.availability, "available");
      assert.equal(provider.supportsRepository, false);
      const mappedOffer = (provider.offers as Array<Record<string, unknown>>)[0];
      assert.equal(mappedOffer?.status, "active");
      assert.equal(mappedOffer?.manualAcceptRequired, true);
      assert.equal(mappedOffer?.maxConcurrentSessions, 2);
      assert.equal(mappedOffer?.activeSessionCount, 1);
      assert.equal("provider_account_id" in provider, false);
      assert.equal(marketplaceViewer, "acct_renter");
    } finally { await server.close(); }
  });

  it("creates a direct-room request without repository fields after room authorization", async () => {
    const app = express();
    authenticated(app, "owner_token");
    let createInput: Record<string, unknown> | null = null;
    registerRentalRenterRoutes(app, {
      publicListings: async () => [],
      publicProviders: async () => [],
      shouldAllowListingsQuery: () => true,
      resolveAuthorizedTargetRoom: async (_req, _res, roomId) => `canonical:${roomId}`,
      createSession: async (input) => {
        createInput = input as unknown as Record<string, unknown>;
        return { id: "rsess_1", status: "requested" } as never;
      },
      getSessionById: async () => null,
      cancelSession: async () => null,
    });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingId: "listing_1",
          targetRoomId: "room_1",
          roomHistoryAccess: "full",
          taskTitle: "Continue my work",
          taskPrompt: "Read the room and continue.",
          lrtLimit: 50_000,
        }),
      });
      assert.equal(response.status, 201);
      assert.equal(createInput?.targetRoomId, "canonical:room_1");
      assert.equal(createInput?.repoOwner, undefined);
      assert.equal(createInput?.roomHistoryAccess, "full");
    } finally { await server.close(); }
  });

  it("rejects repository claims on direct-room requests before room authorization", async () => {
    const app = express();
    authenticated(app, "owner_token");
    let authorized = false;
    registerRentalRenterRoutes(app, {
      publicListings: async () => [],
      publicProviders: async () => [],
      shouldAllowListingsQuery: () => true,
      resolveAuthorizedTargetRoom: async () => {
        authorized = true;
        return "room_1";
      },
      createSession: async () => ({}) as never,
      getSessionById: async () => null,
      cancelSession: async () => null,
    });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingId: "listing_1",
          targetRoomId: "room_1",
          repoOwner: "renter",
          repoName: "private-repo",
          baseBranch: "main",
          taskTitle: "Continue my work",
          taskPrompt: "Read the room and continue.",
        }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "repository_rentals_not_available" });
      assert.equal(authorized, false);
    } finally { await server.close(); }
  });

  it("keeps launch authority credentials on the provider-only endpoint contract", async () => {
    const app = express();
    authenticated(app, "owner_token");
    registerRentalProviderHostRoutes(app, {
      registerHost: async () => ({ id: "host" }) as never,
      heartbeatHost: async () => ({ id: "host" }) as never,
      listHosts: async () => [],
      listEvents: async () => ({ events: [], cursor: null }),
      createLaunchAuthority: async (input) => ({
        session: { id: input.sessionId, room_id: "room_1", launch_attempt: 1 },
        grant: {
          grant_id: "grant_1",
          generation: 1,
          current_generation: 1,
          token_version: 1,
          expires_at: "2026-08-09T11:00:00.000Z",
          supervisor_grant: "secret",
        },
      }) as never,
      acknowledgeLaunch: async () => null,
    });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/provider/sessions/rsess_1/launch-authority`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentKey: "agent:provider:rental" }),
      });
      assert.equal(response.status, 201);
      const body = await response.json() as { grant: { supervisor_grant: string; generation: number } };
      assert.equal(body.grant.supervisor_grant, "secret");
      assert.equal(body.grant.generation, 1);
    } finally { await server.close(); }
  });

  it("commits the terminal session fence before revoking launch authority", async () => {
    const app = express();
    authenticated(app, "owner_token");
    const operations: string[] = [];
    registerActivityLifecycleRoutes(app, {
      resolveSessionAccess: async () => "renter",
      getSessionLifecycle: async () => ({ status: "active", room_id: "room_1" }),
      revokeSessionLaunchAuthority: async () => { operations.push("revoke"); },
      updateSessionLifecycle: async () => {
        operations.push("update");
        return { id: "rsess_1", status: "completed", room_id: "room_1" } as never;
      },
      emitActivityEvent: async () => {
        operations.push("event");
        return {} as never;
      },
      releaseSessionLease: async () => {
        operations.push("release");
        return { released: true, lease: null };
      },
    } as never);
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/sessions/rsess_1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "Done" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(operations, ["update", "revoke", "release", "event"]);
    } finally { await server.close(); }
  });

  it("attempts quota release even when terminal worker revocation fails", async () => {
    const app = express();
    authenticated(app, "owner_token");
    let released = false;
    registerActivityLifecycleRoutes(app, {
      resolveSessionAccess: async () => "provider",
      getSessionLifecycle: async () => ({ status: "active", room_id: "room_1" }),
      updateSessionLifecycle: async () => (
        { id: "rsess_1", status: "cancelled", room_id: "room_1" } as never
      ),
      revokeSessionLaunchAuthority: async () => { throw new Error("daemon unavailable"); },
      releaseSessionLease: async () => {
        released = true;
        return { released: true, lease: null };
      },
    } as never);
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/sessions/rsess_1/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Stop" }),
      });
      assert.equal(response.status, 500);
      assert.equal(released, true);
    } finally { await server.close(); }
  });

  it("does not revoke a worker when the terminal status fence is lost", async () => {
    const app = express();
    authenticated(app, "owner_token");
    let revoked = false;
    registerActivityLifecycleRoutes(app, {
      resolveSessionAccess: async () => "provider",
      getSessionLifecycle: async () => ({ status: "active", room_id: "room_1" }),
      updateSessionLifecycle: async () => null,
      revokeSessionLaunchAuthority: async () => { revoked = true; },
    } as never);
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/api/rental/sessions/rsess_1/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Concurrent completion" }),
      });
      assert.equal(response.status, 409);
      assert.equal(revoked, false);
    } finally { await server.close(); }
  });
});
