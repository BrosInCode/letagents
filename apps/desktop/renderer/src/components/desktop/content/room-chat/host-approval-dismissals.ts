const STORAGE_KEY = "letagents-desktop:host-approval-dismissals";
// Keys are room-scoped digests, oldest first. Records that stop being listed
// are never pruned by presence: an empty or partial snapshot must not revive
// every dismissed card, so the oldest keys age out instead.
const REMEMBERED_LIMIT = 500;

export function readHostApprovalDismissals(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberHostApprovalDismissal(dismissals: ReadonlySet<string>, dismissKey: string): ReadonlySet<string> {
  const next = new Set([...dismissals, dismissKey].slice(-REMEMBERED_LIMIT));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Keep the dismissal for this session when storage is unavailable.
  }
  return next;
}
