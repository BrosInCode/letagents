/**
 * Repository-backed room ids are `host/namespace/repo` locators. Kept free of
 * imports so hot paths can use it.
 *
 * Two shapes count:
 *   - Any three segments whose first segment is a hostname-like token
 *     (`github.com/owner/repo`, `bitbucket.org/ws/repo`, `local/Users/x`). A
 *     first segment without a dot is kept on purpose: an SSH config alias such
 *     as `git@github-work:acme/app.git` becomes `github-work/acme/app`, and the
 *     server cannot tell it from a typed name. Failing closed is safer than
 *     opening an ad-hoc room that is named after a private repository.
 *   - `gitlab.com` with three or more segments. GitLab nests groups
 *     (`gitlab.com/group/sub/project`), and `parseRepoRoomName` already reads
 *     those as repositories, so both functions must agree.
 */
const THREE_SEGMENT_ROOM_ID = /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/;

export function isRepoBackedRoomId(roomId: string): boolean {
  if (THREE_SEGMENT_ROOM_ID.test(roomId)) {
    return true;
  }

  const segments = roomId.split("/");
  return segments.length >= 3 && segments[0].toLowerCase() === "gitlab.com";
}
