# Desktop pull request changes

Choose **View changes** on a pull request's GitHub event card or in its Events
details. The dialog reuses the agent workspace diff surface. Select a file to
read its changes; Escape, Close or the backdrop closes the dialog and restores
focus. The view has no review, editing or merge actions.

The desktop requests
`GET /rooms/:room/pull-requests/:number/diff?include_files=1`
through `room.getPullRequestDiff(roomIdentifier, number)`. Without this opt-in,
the response remains exactly `{number, head_sha, diff, cached}`. A repository
search found no existing production clients of the diff route in MCP, agents,
web or desktop; the existing consumers are the route/service tests and server
registration. Default-response regression tests also cover a cache populated
by the new desktop caller.

Authorization and repository resolution stay on the server. Each request,
including a cache hit, checks room participation and fresh repository access,
then resolves the stored room connection (the parent for focus rooms), active
GitHub App installation and latest stored PR event. Neither a URL nor client
owner/repository fields are used for GitHub requests. The desktop uses the
person's app credential; GitHub calls use the existing installation token.
This is a read path: it writes no chat message/event and wakes no agents.

The opt-in adds `file_list` (or `null`) and a server-built `github_url`.
One extra GitHub request fetches the first 100 changed files. The existing PR
metadata supplies the total count. There is no further pagination. The diff
and file-list response bodies are capped at 5 MiB each. The file-list request
has a five-second sub-deadline within the existing fifteen-second operation.
It must finish before the final head check; unfinished metadata is discarded
and cancelled when the required diff request finishes. Its errors, rate limits
and timeouts leave the diff usable with a notice;
paths then come from the diff and authoritative line counts are unavailable.

Successful file metadata shares the existing five-minute cache with the diff.
The key contains repository identity, installation ID, PR number and the head
SHA from the latest stored pull-request event. A new event head invalidates it.
Authorization still precedes every cache read. Metadata counts toward the
existing 5 MiB entry/64 MiB total/200-entry budget. An unavailable enhancement
is cached explicitly as `file_list: null` until the entry expires, so reopening
or retrying does not repeat GitHub calls. The notice stays visible. A later
plain request preserves any cached file list or unavailable marker.
The service verifies the GitHub head before and after fetching.

A GitHub 403 with rate-limit headers now returns `rate_limited` (HTTP 429)
for all route callers, instead of `forbidden`. Successful default responses
remain unchanged.

The renderer scans file boundaries and bounded headers, yielding every 32 files.
It retains at most 100 file descriptors and indexes code lines only for the
selected file, with a 128 KiB UTF-8 patch cap. Oversized files are omitted
whole. The existing reader limits pages to 500 lines and 128 KiB of displayed
characters, with 4,096-character line segments. Only the selected file's index
is retained. Patch text is Vue text interpolation, never HTML. Closing or
changing rooms discards state and ignores pending responses. There is no
client disk cache or polling.

Renames include the previous path. Binary markers, omitted patches and oversized
patches have explicit notices. Missing patches are not assumed to be binary.
The Open on GitHub link remains available in all states. The existing
`WorkspaceDiff.vue` props and workspace labels retain their defaults.
`DesktopRoomShell.vue` is unchanged. The task_10 link-preview entry is deferred
until that feature lands.

## Verification still requiring a live desktop

- Open from both event entry points, including a focus room and a thread.
- Check initial Close focus, Tab/Shift+Tab trapping, Escape/backdrop dismissal
  and focus return; switch rooms during loading.
- Check light/dark themes, narrow windows, file counts and line paging.
- Once task_10 lands, check the compact pull-request preview card with its
  inherited View changes button.
- Check responsiveness near 5 MiB and with more than 100 files.
- Check actual revoked repository access, inactive installation, GitHub rate
  limiting and a deleted/unavailable PR; follow Open on GitHub.

Automated checks use pure functions, mocked HTTP/IPC and existing suites.
They are not browser QA. No Electron instance or existing database is needed.
