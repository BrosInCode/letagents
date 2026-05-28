import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import type { GitHubEventPresentation } from "./types";

export function parseGitHubEvent(message: DesktopRoomMessage): GitHubEventPresentation | null {
  if (message.source !== "github" && message.sender.toLowerCase() !== "github") return null;
  const text = message.text.trim();
  const urlMatch = text.match(/\s(https?:\/\/\S+)$/i);
  const url = urlMatch?.[1] || null;
  const body = urlMatch ? text.slice(0, urlMatch.index).trim() : text;
  const reviewMatch = /^(.+?)\s+(approved|requested changes on|reviewed)\s+(PR #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i.exec(body);
  if (reviewMatch) {
    const action = reviewMatch[2].trim();
    return {
      kind: "review",
      tone: action === "approved" ? "emerald" : action === "requested changes on" ? "rose" : "sky",
      kindLabel: "Review",
      statusLabel: action === "requested changes on" ? "changes requested" : action,
      headline: `${reviewMatch[1].trim()} ${action} ${reviewMatch[3]}`,
      detail: null,
      repository: reviewMatch[4],
      taskId: reviewMatch[5] || null,
      url,
      urlLabel: "Open review",
    };
  }
  const commentMatch = /^(.+?)\s+commented on\s+(PR #\d+|Issue #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?:\s+"([\s\S]*)"$/i.exec(body);
  if (commentMatch) {
    return {
      kind: "comment",
      tone: "sky",
      kindLabel: "Comment",
      statusLabel: "new comment",
      headline: `${commentMatch[1].trim()} commented on ${commentMatch[2]}`,
      detail: commentMatch[5].trim(),
      repository: commentMatch[3],
      taskId: commentMatch[4] || null,
      url,
      urlLabel: "Open thread",
    };
  }
  const checkMatch = /^Check "([^"]+)"(?: \(([^)]+)\))?\s+([a-z_]+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i.exec(body);
  if (checkMatch) {
    const conclusion = checkMatch[3].trim();
    const conclusionLabel = titleCase(conclusion);
    return {
      kind: "check",
      tone: checkTone(conclusion),
      kindLabel: "Check run",
      statusLabel: conclusionLabel,
      headline: `Check ${checkMatch[1].trim()} ${conclusionLabel.toLowerCase()}`,
      detail: checkMatch[2] ? `Reported by ${checkMatch[2].trim()}` : null,
      repository: checkMatch[4],
      taskId: checkMatch[5] || null,
      url,
      urlLabel: "Open check",
    };
  }
  const prMatch = /^(PR #\d+|Issue #\d+)\s+(.+?)\s+in\s+([^\s:]+)(?:\s+linked to\s+(task_\d+))?(?::\s*([\s\S]*))?$/i.exec(body);
  if (prMatch) {
    const kindLabel = prMatch[1].startsWith("PR ") ? "Pull request" : "Issue";
    const action = prMatch[2].trim();
    const kind = kindLabel === "Pull request" ? "pull-request" : "issue";
    return {
      kind,
      tone: artifactTone(kind, action),
      kindLabel,
      statusLabel: summarizeAction(action),
      headline: `${prMatch[1]} ${action}`,
      detail: prMatch[5]?.trim() || null,
      repository: prMatch[3],
      taskId: prMatch[4] || null,
      url,
      urlLabel: kindLabel === "Pull request" ? "Open pull request" : "Open issue",
    };
  }
  const repositoryEvent = parseRepositoryEvent(body, url);
  if (repositoryEvent) return repositoryEvent;
  return {
    kind: "generic",
    tone: "slate",
    kindLabel: "GitHub event",
    statusLabel: null,
    headline: body,
    detail: null,
    repository: null,
    taskId: null,
    url,
    urlLabel: "Open on GitHub",
  };
}

function summarizeAction(action: string): string | null {
  const normalized = action.toLowerCase();
  if (normalized.includes("ready for review")) return "ready";
  if (normalized.includes("merged")) return "merged";
  if (normalized.includes("closed")) return "closed";
  if (normalized.includes("reopened")) return "reopened";
  if (normalized.includes("opened")) return "opened";
  if (normalized.includes("converted to draft") || normalized.includes("draft")) return "draft";
  if (normalized.includes("commits")) return "updated";
  return null;
}

function artifactTone(kind: GitHubEventPresentation["kind"], action: string): GitHubEventPresentation["tone"] {
  const normalized = action.trim().toLowerCase();
  if (normalized.includes("merged")) return "emerald";
  if (normalized.includes("closed")) return "slate";
  if (normalized.includes("converted to draft")) return "amber";
  if (normalized.includes("received new commits")) return "sky";
  if (kind === "issue") return "amber";
  return "violet";
}

function parseRepositoryEvent(body: string, url: string | null): GitHubEventPresentation | null {
  if (!/^Repository\b/i.test(body)) return null;
  const statusLabel = /\brenamed\b/i.test(body)
    ? "renamed"
    : /\btransferred\b/i.test(body)
      ? "transferred"
      : null;
  return {
    kind: "repository",
    tone: "sky",
    kindLabel: "Repository",
    statusLabel,
    headline: body,
    detail: null,
    repository: null,
    taskId: null,
    url,
    urlLabel: "Open repository",
  };
}

function titleCase(value: string): string {
  return value.split(/[_\s-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function checkTone(conclusion: string): GitHubEventPresentation["tone"] {
  const normalized = conclusion.toLowerCase();
  if (["failure", "timed_out", "cancelled"].includes(normalized)) return "rose";
  if (["action_required", "neutral"].includes(normalized)) return "amber";
  return "sky";
}
