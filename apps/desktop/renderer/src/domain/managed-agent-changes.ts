import type {
  DesktopManagedAgentChangedFile,
  DesktopManagedAgentChangeSummary,
  DesktopRoomMessageAttachment,
} from "../../../electron/ipc-types";

export const MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME =
  "application/vnd.letagents.managed-agent-change-summary+json";

interface ManagedAgentChangeSummaryAttachmentPayload {
  kind?: string;
  version?: number;
  summary?: DesktopManagedAgentChangeSummary;
}

export function isManagedAgentChangeSummaryAttachment(
  attachment: Pick<DesktopRoomMessageAttachment, "mimeType">,
): boolean {
  return attachment.mimeType === MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME;
}

export function decodeManagedAgentChangeSummaryAttachment(
  attachment: Pick<DesktopRoomMessageAttachment, "contentBase64" | "dataUrl">,
): DesktopManagedAgentChangeSummary | null {
  const json = attachmentJsonText(attachment);
  if (!json) return null;
  return parseManagedAgentChangeSummaryPayload(json);
}

export async function fetchManagedAgentChangeSummaryAttachment(
  attachment: Pick<DesktopRoomMessageAttachment, "downloadUrl" | "url">,
): Promise<DesktopManagedAgentChangeSummary | null> {
  const href = attachment.downloadUrl || attachment.url;
  if (!href) return null;
  const response = await fetch(href);
  if (!response.ok) return null;
  return parseManagedAgentChangeSummaryPayload(await response.text());
}

export function managedAgentChangeSummaryTitle(
  summary: DesktopManagedAgentChangeSummary | null,
  loading = false,
): string {
  if (!summary && loading) return "Checking file changes";
  if (summary?.error) return "Changes unavailable";
  if (!summary || summary.changedFileCount === 0) return "No file changes";
  return `Edited ${summary.changedFileCount} ${summary.changedFileCount === 1 ? "file" : "files"}`;
}

export function managedAgentChangeSummarySubtitle(
  summary: DesktopManagedAgentChangeSummary | null,
  loading = false,
): string {
  if (!summary) return loading ? "Reading the Codex working tree..." : "Codex working tree";
  if (summary.error) return "Git summary could not be loaded.";
  const totals = [
    summary.additions ? `+${summary.additions}` : null,
    summary.deletions ? `-${summary.deletions}` : null,
    summary.untrackedFileCount ? `${summary.untrackedFileCount} untracked` : null,
    summary.stagedFileCount ? `${summary.stagedFileCount} staged` : null,
  ].filter(Boolean);
  return totals.length ? totals.join("  ") : "Codex working tree is clean.";
}

export function visibleManagedAgentChangedFiles(
  summary: DesktopManagedAgentChangeSummary | null,
  expanded: boolean,
  collapsedLimit = 3,
): DesktopManagedAgentChangedFile[] {
  if (!summary) return [];
  return expanded ? summary.files : summary.files.slice(0, collapsedLimit);
}

export function hiddenManagedAgentChangedFileCount(
  summary: DesktopManagedAgentChangeSummary | null,
  expanded: boolean,
  collapsedLimit = 3,
): number {
  if (!summary || expanded) return 0;
  return Math.max(0, summary.files.length - collapsedLimit);
}

export function managedAgentChangedFileStateLabel(
  file: DesktopManagedAgentChangedFile,
): string {
  if (file.untracked) return "untracked";
  if (file.staged && file.unstaged) return "staged + unstaged";
  if (file.staged) return "staged";
  if (file.unstaged) return file.status;
  return file.status;
}

function attachmentJsonText(
  attachment: Pick<DesktopRoomMessageAttachment, "contentBase64" | "dataUrl">,
): string | null {
  if (attachment.contentBase64) {
    return base64ToUtf8(attachment.contentBase64);
  }
  if (attachment.dataUrl?.startsWith("data:")) {
    const [, encoded] = attachment.dataUrl.split(",", 2);
    return encoded ? base64ToUtf8(encoded) : null;
  }
  return null;
}

function base64ToUtf8(value: string): string | null {
  try {
    return decodeURIComponent(
      Array.from(atob(value), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
  } catch {
    return null;
  }
}

function parseManagedAgentChangeSummaryPayload(json: string): DesktopManagedAgentChangeSummary | null {
  try {
    const payload = JSON.parse(json) as ManagedAgentChangeSummaryAttachmentPayload;
    if (payload.kind !== "managed_agent_change_summary") return null;
    const summary = payload.summary;
    if (!summary || typeof summary.sessionId !== "string" || !Array.isArray(summary.files)) {
      return null;
    }
    return summary;
  } catch {
    return null;
  }
}
