import assert from "node:assert/strict";
import test from "node:test";

import type { TrackerConnectionView } from "../../../../shared/ticket-connectors.mjs";
import {
  connectionStateLabel,
  statusMapFromRows,
  statusMapRowLabel,
  statusMapRows,
} from "../src/components/desktop/settings/connectors.js";

function connection(overrides: Partial<TrackerConnectionView> = {}): TrackerConnectionView {
  return {
    id: "tcon_00000000-0000-4000-8000-000000000000",
    provider: "jira",
    display_name: "acme",
    site_url: "https://acme.atlassian.net",
    auth_kind: "api_token",
    tracker_user_id: "acc-1",
    tracker_user_label: "Emmy",
    status_map: { "To Do": "todo", Done: "done" },
    unmapped_statuses: ["Blocked", "done"],
    jev_linking_enabled: false,
    status: "active",
    last_error: null,
    last_verified_at: null,
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

test("the status map editor lists unmapped statuses first, as in progress", () => {
  const rows = statusMapRows(connection());
  assert.deepEqual(rows, [
    { name: "Blocked", state: "in_progress", unmapped: true },
    { name: "To Do", state: "todo", unmapped: false },
    { name: "Done", state: "done", unmapped: false },
  ]);
  rows[0].state = "todo";
  rows.push({ name: "  ", state: "done", unmapped: false });
  assert.deepEqual(statusMapFromRows(rows), { Blocked: "todo", "To Do": "todo", Done: "done" });
});

test("Linear type keys and connection states read in plain words", () => {
  assert.equal(statusMapRowLabel("type:started"), "Any started status");
  assert.equal(statusMapRowLabel("In Review"), "In Review");
  assert.equal(statusMapRowLabel("type:indeterminate", "jira"), "Any status in the In Progress category");
  assert.equal(statusMapRowLabel("type:new", "jira"), "Any status in the To Do category");
  assert.equal(statusMapRowLabel("type:started", "linear"), "Any started status");
  assert.deepEqual(connectionStateLabel(connection({ status: "needs_reauth" })), { label: "Reconnect", state: "failed" });
  assert.deepEqual(connectionStateLabel(connection()), { label: "Connected", state: "connected" });
});
