import { inArray, sql } from "drizzle-orm";
import { extractMentionedLogins } from "../../../shared/room-notification-preferences.mjs";
import { db } from "../db/client.js";
import { accounts } from "../db/schema.js";

export interface MentionAccountRow {
  id: string;
  login: string;
}

const AGENT_STATUS_MESSAGE_PREFIX = /^\[status\]\s*/i;

/** Agent `[status]` broadcasts are hidden from human chat and must never notify or seed recents. */
export function isHiddenAgentStatusMessage(source: string | null | undefined, text: string): boolean {
  return source === "agent" && AGENT_STATUS_MESSAGE_PREFIX.test(text);
}

/**
 * Selects account ids whose lower-cased login matches unambiguously across all
 * matching account rows. Any login shared by more than one account is skipped
 * rather than guessing, and `excludeAccountId` (the human publisher) is omitted.
 */
export function selectUnambiguousMentionedAccountIds(
  rows: readonly MentionAccountRow[],
  mentionedLogins: readonly string[],
  excludeAccountId?: string | null,
): string[] {
  if (rows.length === 0 || mentionedLogins.length === 0) return [];
  const byLowerLogin = new Map<string, string[]>();
  for (const row of rows) {
    const lower = row.login.trim().toLowerCase();
    if (!lower) continue;
    const ids = byLowerLogin.get(lower);
    if (ids) {
      if (!ids.includes(row.id)) ids.push(row.id);
    } else {
      byLowerLogin.set(lower, [row.id]);
    }
  }

  const excluded = excludeAccountId?.trim() || null;
  const resolved: string[] = [];
  const seenAccountIds = new Set<string>();
  for (const login of mentionedLogins) {
    const ids = byLowerLogin.get(login.toLowerCase());
    if (!ids || ids.length !== 1) continue;
    const accountId = ids[0]!;
    if (excluded && accountId === excluded) continue;
    if (!seenAccountIds.has(accountId)) {
      seenAccountIds.add(accountId);
      resolved.push(accountId);
    }
  }
  return resolved;
}

async function queryAccountsByLowerLogins(logins: readonly string[]): Promise<MentionAccountRow[]> {
  if (logins.length === 0) return [];
  return db
    .select({ id: accounts.id, login: accounts.login })
    .from(accounts)
    .where(inArray(sql<string>`lower(${accounts.login})`, [...logins]));
}

export interface ResolveMentionedAccountIdsOptions {
  excludeAccountId?: string | null;
  findAccountsByLowerLogins?: (logins: readonly string[]) => Promise<readonly MentionAccountRow[]>;
}

/**
 * Resolves `@<login>` mentions in a chat message to unambiguous LetAgents
 * account ids. Never used for `source === "github"` webhook payloads, which
 * resolve strictly by immutable `github_user_id`.
 */
export async function resolveMentionedAccountIds(
  text: string,
  options?: ResolveMentionedAccountIdsOptions,
): Promise<string[]> {
  const mentionedLogins = extractMentionedLogins(text);
  if (mentionedLogins.length === 0) return [];
  const lookup = options?.findAccountsByLowerLogins ?? queryAccountsByLowerLogins;
  const rows = await lookup(mentionedLogins);
  return selectUnambiguousMentionedAccountIds(rows, mentionedLogins, options?.excludeAccountId);
}
