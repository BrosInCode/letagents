import { findTaskByExternalRefs, getCachedRoomExternalRefScope } from "../db/task-external-refs.js";
import type { Task } from "../db/types.js";
import type { RepoEventTicketKeyInputs } from "../github/repo-event-task-resolution.js";
import { detectKeysInPullRequest, normalizeGitHubRepo, type TicketKeyMatch } from "./key-detectors.js";
import { getCachedRoomTrackerScope } from "./room-filters.js";

/** `owner/repo` of `https://github.com/owner/repo/pull/12`, or null. */
export function repositoryOfPullRequestUrl(url: string | null | undefined): string | null {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i.exec(url ?? "");
  return match ? normalizeGitHubRepo(match[1]!) : null;
}

export interface TicketKeyResolutionOptions {
  /**
   * Imports a ticket the event names when no card holds it and the room has
   * a filter on a connection for that tracker (ticket connectors PR3).
   */
  importTicket?: (roomId: string, matches: readonly TicketKeyMatch[]) => Promise<Task | undefined>;
}

/**
 * Resolves a repo event to the card whose `external_ref` names a key in the
 * branch, PR title or PR body. A room with no external ref and no tracker
 * filter stops after two cached, indexed probes and runs no detector (ticket
 * connectors invariant 1).
 */
export async function findTaskByTicketKeys(
  roomId: string,
  inputs: RepoEventTicketKeyInputs,
  options: TicketKeyResolutionOptions = {},
): Promise<Task | undefined> {
  const scope = await getCachedRoomExternalRefScope(roomId);
  const trackers = options.importTicket ? await getCachedRoomTrackerScope(roomId) : null;
  const imports = Boolean(trackers?.sources.length);
  if (!scope.hasExternalRefs && !imports) return undefined;
  const linearTeamKeys = [...new Set([...(scope.detectorOptions.linearTeamKeys ?? []), ...(trackers?.linearTeamKeys ?? [])])];
  const githubRepos = [...new Set([...(scope.detectorOptions.githubRepos ?? []), ...(trackers?.githubRepos ?? [])])];
  const matches = detectKeysInPullRequest({
    headRef: inputs.branchRef,
    title: inputs.title,
    body: inputs.body,
  }, { ...scope.detectorOptions, linearTeamKeys, githubRepos, githubDefaultRepo: repositoryOfPullRequestUrl(inputs.pullRequestUrl) });
  if (matches.length === 0) return undefined;
  const found = scope.hasExternalRefs ? await findTaskByExternalRefs(roomId, matches.map((match) => match.ref)) : undefined;
  if (found || !imports || !options.importTicket) return found;
  return options.importTicket(roomId, matches);
}
