import type { DesktopSupervisorLegacyStateReset } from "../../../electron/ipc-types";

export const LEGACY_STATE_RESET_DISMISSED_STORAGE_KEY = "letagents-desktop:dismissed-legacy-state-reset";

type MinimalStorage = Pick<Storage, "getItem" | "setItem">;

export function readDismissedLegacyResetBackup(storage: MinimalStorage | null | undefined): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(LEGACY_STATE_RESET_DISMISSED_STORAGE_KEY)?.trim() ?? "";
    return value || null;
  } catch {
    return null;
  }
}

export function rememberDismissedLegacyResetBackup(
  storage: MinimalStorage | null | undefined,
  backupName: string,
): void {
  const trimmed = backupName.trim();
  if (!storage || !trimmed) return;
  try {
    storage.setItem(LEGACY_STATE_RESET_DISMISSED_STORAGE_KEY, trimmed);
  } catch {
    /* Keep dismissal usable for this session. */
  }
}

export function shouldShowLegacyStateResetNotice(
  reset: DesktopSupervisorLegacyStateReset | null | undefined,
  dismissedBackupName: string | null | undefined,
): boolean {
  if (!reset || !reset.backupName.trim()) return false;
  return reset.backupName !== dismissedBackupName;
}

export function formatLegacyStateResetNotice(reset: DesktopSupervisorLegacyStateReset): string {
  const preserved: string[] = ["previous database"];
  if (reset.preservedRoomOnlyWorkspaces) preserved.push("room-only workspaces");
  if (reset.preservedReviewArchives) preserved.push("review archives");
  const backupClause = preserved.length === 1
    ? "Your previous database was kept as a backup."
    : preserved.length === 2
      ? `Your ${preserved[0]} and ${preserved[1]} were kept as backups.`
      : `Your ${preserved[0]}, ${preserved[1]}, and ${preserved[2]} were kept as backups.`;
  return `Background service upgraded: local agents and saved tool rules were reset once (re-add agents to rooms as needed). ${backupClause}`;
}
