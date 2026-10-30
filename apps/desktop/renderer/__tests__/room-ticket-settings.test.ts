import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  boardMayShowTicketSettings,
  rememberActiveConnectionCount,
  roomShowsTicketSettings,
  ticketSettingsSummary,
} from "../src/components/desktop/content/room-board/ticket-settings";

const bridge = globalThis as unknown as { window?: { letagentsDesktop?: unknown } };
const originalWindow = bridge.window;
after(() => { bridge.window = originalWindow; });

function stubBridge(filters: unknown[] | Error, connections: Array<{ status: string }> | Error): void {
  bridge.window = {
    letagentsDesktop: {
      room: {
        listTrackerFilters: async () => {
          if (filters instanceof Error) throw filters;
          return { filters, can_manage: true };
        },
      },
      connectors: {
        list: async () => {
          if (connections instanceof Error) throw connections;
          return { connections };
        },
      },
    },
  };
}

test("Board manager asks the server nothing in a room with no connector and no imported card", () => {
  rememberActiveConnectionCount(0);
  assert.equal(boardMayShowTicketSettings([{ externalRef: null }, {}]), false);
  assert.equal(boardMayShowTicketSettings([{ externalRef: "jira:SCRUM-1" }]), true, "an imported card asks");
  rememberActiveConnectionCount(1);
  assert.equal(boardMayShowTicketSettings([]), true, "a known active connection asks");
  rememberActiveConnectionCount(0);
});

test("the Tickets rail summary counts filters and hides with no filter and no connection", () => {
  assert.equal(ticketSettingsSummary(0, 0), null);
  assert.equal(ticketSettingsSummary(0, 1), "No filters");
  assert.equal(ticketSettingsSummary(1, 0), "1 filter");
  assert.equal(ticketSettingsSummary(3, 2), "3 filters");
});

test("Board manager links to ticket filters only where Room settings shows them", async () => {
  stubBridge([], []);
  assert.equal(await roomShowsTicketSettings("room-1"), false, "a zero-connector room shows nothing new");
  stubBridge([], [{ status: "needs_reauth" }]);
  assert.equal(await roomShowsTicketSettings("room-1"), false, "an inactive connection does not count");
  stubBridge([], [{ status: "active" }]);
  assert.equal(await roomShowsTicketSettings("room-1"), true);
  stubBridge([{ id: "f1" }], new Error("signed out"));
  assert.equal(await roomShowsTicketSettings("room-1"), true);
  stubBridge(new Error("no connectors on this server"), new Error("signed out"));
  assert.equal(await roomShowsTicketSettings("room-1"), false);
  stubBridge([], [{ status: "active" }]);
  await roomShowsTicketSettings("room-1");
  assert.equal(boardMayShowTicketSettings([]), true, "the check remembers an active connection");
  stubBridge([], []);
  await roomShowsTicketSettings("room-1");
  assert.equal(boardMayShowTicketSettings([]), false, "and forgets it when it is gone");
});
