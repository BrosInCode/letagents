import assert from "node:assert/strict";
import test from "node:test";

import { isSupervisorGrantRouteAllowed } from "../supervisor-grant-route-registry.js";

test("supervisor grant registry is exact and default-deny", () => {
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/renew"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/worker-sessions/session_1/end"), true);
  assert.equal(isSupervisorGrantRouteAllowed("GET", "/supervisor-host-grants/grant_1/execution-delegations"), true);
  assert.equal(isSupervisorGrantRouteAllowed("GET", "/supervisor-host-grants/grant_1/execution-delegations/delegation_1"), true);
  assert.equal(isSupervisorGrantRouteAllowed("GET", "/supervisor-host-grants/grant_1/execution-delegation-decisions"), true);
  assert.equal(isSupervisorGrantRouteAllowed("GET", "/supervisor-host-grants/grant_1/execution-delegation-decisions/decision_1"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/execution-delegation-decisions"), false);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/execution-delegations"), false);
  assert.equal(isSupervisorGrantRouteAllowed("DELETE", "/supervisor-host-grants/grant_1"), false);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/rooms/example/messages"), false);
});
