import assert from "node:assert/strict";
import test from "node:test";
import { DAEMON_IMPLEMENTATION_VERSION } from "#daemon-contract/index.js";
import { mapStatus } from "../main/supervisor-daemon/status-mapping.js";

test("mapStatus preserves optional legacy_state_reset payload and omits it when absent or malformed", () => {
  const base = {
    healthy: true,
    protocol_version: 3,
    implementation_version: DAEMON_IMPLEMENTATION_VERSION,
    capabilities: {
      room_delivery_retry: true,
      provider_continuation_repair: true,
      room_delivery_skip: true,
      agent_inspector_detail_v1: true,
      agent_inspector_settings_v1: true,
      agent_room_move_v1: true,
      agent_lifecycle_v1: true,
      agent_runtime_recovery_v1: true,
      agent_runtime_recovery_v2: true,
      agent_state_subscription_v1: true,
      agent_activity_stream_v1: true,
    },
    generation: 2,
    pid: 4242,
    started_at: "2026-11-25T09:00:00.000Z",
    maintenance_hold_id: null,
  };

  assert.equal(mapStatus(base).legacyStateReset, undefined);
  assert.equal(mapStatus({ ...base, legacy_state_reset: { backup_name: 123 } }).legacyStateReset, undefined);

  const mapped = mapStatus({
    ...base,
    legacy_state_reset: {
      reset_at: "2026-11-25T09:15:00.000Z",
      backup_name: "daemon-state.sqlite.legacy-2026-11-25T09-15-00-000Z",
      legacy_schema_version: 54,
      preserved_room_only_workspaces: true,
      preserved_review_archives: true,
    },
  });
  assert.deepEqual(mapped.legacyStateReset, {
    resetAt: "2026-11-25T09:15:00.000Z",
    backupName: "daemon-state.sqlite.legacy-2026-11-25T09-15-00-000Z",
    legacySchemaVersion: 54,
    preservedRoomOnlyWorkspaces: true,
    preservedReviewArchives: true,
  });
});
