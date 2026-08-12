import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DesktopRentalRequest } from "../../electron/ipc-types";
import { buildDesktopInboxItems } from "../src/components/desktop/content/room-inbox/items";

const request: DesktopRentalRequest = {
  id: "rr_1", sessionId: "rs_1", listingId: "rl_1", status: "pending",
  renterDisplayName: "Emmy", providerDisplayName: "Shannon", taskTitle: "Review the launch",
  taskPrompt: "Read the room and propose the next move.", mode: "scoped", continuityMode: "full_transcript",
  requestedLrtLimit: 50_000, requestedTimeLimitMinutes: 30, createdAt: "2026-08-09T10:00:00.000Z",
  expiresAt: "2026-08-09T10:15:00.000Z", updatedAt: "2026-08-09T10:00:00.000Z",
};

describe("rental requests in the room Inbox", () => {
  it("presents pending account requests as actionable rental items", () => {
    const items = buildDesktopInboxItems({ filter: "actionable", threadPage: null, tasks: [], githubEvents: [], reasoningSessions: [], rentalRequests: [request] });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "rental_request");
    assert.equal(items[0]?.title, "Emmy wants to rent your agent");
    assert.equal(items[0]?.context, "Renting · account");
  });

  it("does not show accepted or expired rental requests as actionable work", () => {
    const items = buildDesktopInboxItems({ filter: "all", threadPage: null, tasks: [], githubEvents: [], reasoningSessions: [], rentalRequests: [{ ...request, status: "accepted" }, { ...request, id: "rr_2", status: "expired" }] });
    assert.equal(items.length, 0);
  });
});
