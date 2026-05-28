const timestamp = "2026-05-11T10:00:00.000Z";

export function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "listing_1",
    display_name: "Antigravity rental",
    ide_kind: "antigravity",
    status: "active",
    updated_at: timestamp,
    ...overrides,
  };
}

export function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsess_1",
    listing_id: "listing_1",
    status: "requested",
    task_title: "Fix flaky test",
    task_prompt: "Run the suite and patch failures.",
    updated_at: timestamp,
    ...overrides,
  };
}

export function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsess_1",
    listing_id: "listing_1",
    status: "requested",
    task_title: "Run tests",
    task_prompt: "go",
    updated_at: timestamp,
    ...overrides,
  };
}

export function readinessRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    summary: "1 listing: 1 active.",
    blockers: [],
    warnings: [],
    badges: ["verified"],
    checks: [
      {
        id: "listing:listing_1",
        label: "My agent",
        status: "passed",
        detail: "Listing is accepting rental requests.",
      },
    ],
    last_checked_at: "2026-05-12T11:00:00.000Z",
    ...overrides,
  };
}

export function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "rsess_42",
    lrt_limit: 10_000,
    lrt_reserved: 100,
    lrt_used: 2_500,
    lrt_remaining: 7_400,
    budget_stop_threshold: 0.95,
    time_limit_minutes: 60,
    started_at: "2026-05-12T10:00:00.000Z",
    ends_at: "2026-05-12T11:00:00.000Z",
    quota_snapshot: null,
    updated_at: "2026-05-12T10:30:00.000Z",
    ...overrides,
  };
}

export function activityEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    session_id: "rsess_42",
    room_id: "room_1",
    event_type: "session.started",
    source: "system",
    verified: true,
    visibility: "rental_visible",
    payload: { hello: "world" },
    created_at: "2026-05-12T10:00:00.000Z",
    ...overrides,
  };
}

export function patchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rpatch_1",
    session_id: "rsess_1",
    source: "explicit_patch",
    summary: "Fix tests",
    gate_status: "passed",
    updated_at: timestamp,
    ...overrides,
  };
}
