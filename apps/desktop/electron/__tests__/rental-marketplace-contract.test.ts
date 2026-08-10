import assert from "node:assert/strict";
import test from "node:test";

import { mapMarketplaceProviders } from "../rental/handlers/marketplace.js";

test("maps the public person-and-compact-offer server DTO without internal ids", () => {
  const providers = mapMarketplaceProviders({
    providers: [{
      providerKey: "ghostofshannon",
      displayName: "Ghost of Shannon",
      login: "GhostOfShannon",
      avatarUrl: "https://example.test/avatar.png",
      available: true,
      availableSlots: 2,
      maxConcurrentSessions: 3,
      supportsRepository: false,
      maxDurationMinutes: 90,
      runtimes: [{ kind: "codex", label: "Codex CLI" }],
      offers: [{
        id: "rlist_public",
        listingId: "rlist_public",
        displayName: "Codex CLI",
        status: "active",
        verificationStatus: "experimental",
        ideKind: "codex",
        modelLabel: null,
        supportedModes: ["scoped"],
        manualAcceptRequired: true,
        defaultLrtLimit: 75_000,
        defaultTimeLimitMinutes: 90,
      }],
    }],
  });

  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.accountId, "ghostofshannon");
  assert.equal(providers[0]?.availability, "available");
  assert.equal(providers[0]?.supportsRepository, false);
  assert.equal(providers[0]?.offers[0]?.id, "rlist_public");
  assert.equal(providers[0]?.offers[0]?.defaultLrtLimit, 75_000);
  assert.equal(providers[0]?.offers[0]?.manualAcceptRequired, true);
});
