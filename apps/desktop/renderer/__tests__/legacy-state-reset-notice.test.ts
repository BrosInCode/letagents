import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLegacyStateResetNotice,
  LEGACY_STATE_RESET_DISMISSED_STORAGE_KEY,
  readDismissedLegacyResetBackup,
  rememberDismissedLegacyResetBackup,
  shouldShowLegacyStateResetNotice,
} from "../src/domain/legacy-state-reset-notice.js";

test("legacy state reset notice formats preserved backup summary accurately", () => {
  const base = {
    resetAt: "2026-11-25T09:15:00.000Z",
    backupName: "daemon-state.sqlite.legacy-2026-11-25T09-15-00-000Z",
    legacySchemaVersion: 54,
    preservedRoomOnlyWorkspaces: false,
    preservedReviewArchives: false,
  };
  assert.match(formatLegacyStateResetNotice(base), /previous database was kept as a backup\./);
  assert.match(
    formatLegacyStateResetNotice({ ...base, preservedRoomOnlyWorkspaces: true }),
    /previous database and room-only workspaces were kept as backups\./,
  );
  assert.match(
    formatLegacyStateResetNotice({ ...base, preservedReviewArchives: true }),
    /previous database and review archives were kept as backups\./,
  );
  assert.match(
    formatLegacyStateResetNotice({ ...base, preservedRoomOnlyWorkspaces: true, preservedReviewArchives: true }),
    /previous database, room-only workspaces, and review archives were kept as backups\./,
  );
});

test("legacy state reset notice dismissal persists per backupName", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  const reset = {
    resetAt: "2026-11-25T09:15:00.000Z",
    backupName: "daemon-state.sqlite.legacy-2026-11-25T09-15-00-000Z",
    legacySchemaVersion: 54,
    preservedRoomOnlyWorkspaces: true,
    preservedReviewArchives: false,
  };

  assert.equal(shouldShowLegacyStateResetNotice(null, null), false);
  assert.equal(shouldShowLegacyStateResetNotice(reset, readDismissedLegacyResetBackup(storage)), true);

  rememberDismissedLegacyResetBackup(storage, reset.backupName);
  assert.equal(store.get(LEGACY_STATE_RESET_DISMISSED_STORAGE_KEY), reset.backupName);
  assert.equal(shouldShowLegacyStateResetNotice(reset, readDismissedLegacyResetBackup(storage)), false);

  const newerReset = { ...reset, backupName: "daemon-state.sqlite.legacy-2026-11-26T00-00-00-000Z" };
  assert.equal(shouldShowLegacyStateResetNotice(newerReset, readDismissedLegacyResetBackup(storage)), true);
});
