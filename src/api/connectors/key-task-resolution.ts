import { findTaskByExternalRefs, getRoomExternalRefScope } from "../db/task-external-refs.js";
import type { Task } from "../db/types.js";
import type { RepoEventTicketKeyInputs } from "../github/repo-event-task-resolution.js";
import { detectKeysInPullRequest } from "./key-detectors.js";

/**
 * Resolves a repo event to the card whose `external_ref` names a key in the
 * branch, PR title or PR body. A room with no external ref stops after one
 * indexed probe and runs no detector (ticket connectors invariant 1).
 */
export async function findTaskByTicketKeys(
  roomId: string,
  inputs: RepoEventTicketKeyInputs,
): Promise<Task | undefined> {
  const scope = await getRoomExternalRefScope(roomId);
  if (!scope.hasExternalRefs) return undefined;
  const matches = detectKeysInPullRequest({
    headRef: inputs.branchRef,
    title: inputs.title,
    body: inputs.body,
  }, scope.detectorOptions);
  if (matches.length === 0) return undefined;
  return findTaskByExternalRefs(roomId, matches.map((match) => match.ref));
}
