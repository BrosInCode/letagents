// Supervisor grants are opt-in and default-deny. Keep this list intentionally
// small: a grant is not an owner credential and cannot acquire new routes by
// falling through generic account-less handlers.
const SUPERVISOR_GRANT_ROUTE_PATTERNS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/renew$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/handoff$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/worker-sessions$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/worker-sessions\/[^/]+\/rotate$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/worker-sessions\/[^/]+\/end$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/worker-sessions\/[^/]+\/agent-work$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/worker-sessions\/[^/]+\/execution-approval-publications$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/worker-sessions\/[^/]+\/execution-approval-publications\/[^/]+\/close$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/leases\/[^/]+\/attestation$/ },
  { method: "POST", pattern: /^\/supervisor-host-grants\/[^/]+\/leases\/[^/]+\/rebind$/ },
  // Reconciliation reads outlive the admission rollout flag so an issued
  // delegation can still be observed and revoked after admission is disabled.
  { method: "GET", pattern: /^\/supervisor-host-grants\/[^/]+\/execution-delegations$/ },
  { method: "GET", pattern: /^\/supervisor-host-grants\/[^/]+\/execution-delegations\/[^/]+$/ },
  { method: "GET", pattern: /^\/supervisor-host-grants\/[^/]+\/execution-delegation-decisions$/ },
  { method: "GET", pattern: /^\/supervisor-host-grants\/[^/]+\/execution-delegation-decisions\/[^/]+$/ },
];

export function isSupervisorGrantRouteAllowed(method: string, path: string): boolean {
  return SUPERVISOR_GRANT_ROUTE_PATTERNS.some((route) => route.method === method && route.pattern.test(path));
}
