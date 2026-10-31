import {
  ROOM_AGENT_GUIDELINES_MAX_BYTES,
  ROOM_AGENT_GUIDELINES_TOKEN_BUDGET,
  estimateRoomAgentGuidelineTokens,
  looksLikeBinaryText,
  roomAgentGuidelinesBytes,
  type GitHubRoomChatEventKind,
} from "../../../../../../../../shared/room-settings.mjs";

export const GITHUB_EVENT_KIND_LABELS: Record<GitHubRoomChatEventKind, { label: string; hint: string }> = {
  pull_request: { label: "Pull requests", hint: "Opened, merged, closed, ready for review" },
  review: { label: "Reviews", hint: "Approvals and change requests" },
  comment: { label: "Comments", hint: "On pull requests and issues" },
  issue: { label: "Issues", hint: "Opened, closed, reopened" },
  check_failed: { label: "Failed checks", hint: "Passing checks are never posted" },
  repository: { label: "Branches and pushes", hint: "New commits, branches created or deleted" },
};

/** Files past this size are refused unread; nothing this large can fit the budget. */
export const GUIDELINES_IMPORT_MAX_BYTES = 64 * 1024;
const GUIDELINES_IMPORT_EXTENSION = /\.(md|markdown|mdc|txt)$/i;

export type GuidelinesBudgetLevel = "ok" | "near" | "over";

export interface GuidelinesBudget {
  tokens: number;
  /** Share of the budget in use, from 0 to 1, for the meter. */
  fill: number;
  level: GuidelinesBudgetLevel;
  message: string;
  /** What the section rail shows for the saved guidelines. */
  summary: string;
}

const formatNumber = (value: number): string => value.toLocaleString("en-US");

/**
 * People see tokens, which is the cost they care about. The limit itself is
 * counted in bytes, so "over" is decided by the exact count.
 */
export function describeGuidelinesBudget(text: string): GuidelinesBudget {
  const length = roomAgentGuidelinesBytes(text);
  const tokens = estimateRoomAgentGuidelineTokens(text);
  const ratio = length / ROOM_AGENT_GUIDELINES_MAX_BYTES;
  const level: GuidelinesBudgetLevel = ratio > 1 ? "over" : ratio >= 0.8 ? "near" : "ok";
  const budget = formatNumber(ROOM_AGENT_GUIDELINES_TOKEN_BUDGET);
  const excess = Math.max(1, tokens - ROOM_AGENT_GUIDELINES_TOKEN_BUDGET);
  const message = level === "over"
    ? `About ${formatNumber(excess)} ${excess === 1 ? "token" : "tokens"} over the ${budget} limit. Shorten it to save.`
    : length === 0 ? `Up to about ${budget} tokens`
    : `About ${formatNumber(tokens)} of ${budget} tokens`;
  return {
    tokens,
    fill: Math.min(ratio, 1),
    level,
    message,
    summary: length === 0 ? "None" : `${Math.max(1, Math.round(ratio * 100))}% used`,
  };
}

export type GuidelinesImportCheck = { ok: true } | { ok: false; reason: string };

/**
 * A file with a text name can still hold something else, such as a document
 * saved as UTF-16 or a renamed binary. Read as text it is full of null
 * characters, and importing it would fill the guidelines with noise.
 */
export function checkGuidelinesImportText(fileName: string, text: string): GuidelinesImportCheck {
  if (!looksLikeBinaryText(text)) return { ok: true };
  return { ok: false, reason: `${fileName} isn't plain text. Save it as UTF-8 text, or paste the rules in.` };
}

export function checkGuidelinesImport(file: { name: string; size: number; type: string }): GuidelinesImportCheck {
  if (!file.type.startsWith("text/") && !GUIDELINES_IMPORT_EXTENSION.test(file.name)) {
    return { ok: false, reason: `${file.name} isn't a text file. Import a .md or .txt file.` };
  }
  if (file.size > GUIDELINES_IMPORT_MAX_BYTES) {
    const size = formatNumber(Math.round(file.size / 1024));
    return { ok: false, reason: `${file.name} is ${size} KB, far past the limit. Import a shorter file, or paste only the rules agents need.` };
  }
  return { ok: true };
}
