export interface AgentInspectorRecoveryDismissalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY =
  "letagents-desktop:agent-inspector-recovery-dismissals";
export const AGENT_INSPECTOR_RECOVERY_DISMISSALS_LIMIT = 128;

function readDismissedNoticeIds(
  storage: AgentInspectorRecoveryDismissalStorage | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(
      storage.getItem(AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY) || "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return [...new Set(
      parsed.filter((noticeId): noticeId is string =>
        typeof noticeId === "string" && Boolean(noticeId.trim())
      ),
    )].slice(0, AGENT_INSPECTOR_RECOVERY_DISMISSALS_LIMIT);
  } catch {
    return [];
  }
}

export function isAgentInspectorRecoveryDismissed(
  storage: AgentInspectorRecoveryDismissalStorage | null | undefined,
  noticeId: string | null | undefined,
): boolean {
  return Boolean(noticeId && readDismissedNoticeIds(storage).includes(noticeId));
}

export function rememberAgentInspectorRecoveryDismissal(
  storage: AgentInspectorRecoveryDismissalStorage | null | undefined,
  noticeId: string | null | undefined,
): void {
  if (!storage || !noticeId) return;
  const dismissed = readDismissedNoticeIds(storage);
  const next = [noticeId, ...dismissed.filter((candidate) => candidate !== noticeId)]
    .slice(0, AGENT_INSPECTOR_RECOVERY_DISMISSALS_LIMIT);
  try {
    storage.setItem(
      AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Dismissing the current notice remains useful when persistence is unavailable.
  }
}
