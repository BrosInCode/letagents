# GitHub message link previews

Desktop and web show compact pull request and issue cards below messages. Each
card contains the number, title, repository and last-observed state. It uses the
existing GitHub event card with compact spacing and safe text interpolation.

The existing markdown renderers collect the links they render, in message order.
Inline code and fenced code blocks do not contribute links. The shared GitHub
reference helper accepts HTTPS GitHub PR/issue URLs, ignores query/fragment
variants, matches the room's connected repository case-insensitively, and keeps
the first three distinct eligible references per message. Other repositories and
sites produce no preview. Local desktop rooms make no HTTP request.

## Separate read contract

`POST /rooms/:room/messages/link-previews` is a read-only endpoint:

```json
{ "references": [{ "kind": "pull", "number": 42 }, { "kind": "issue", "number": 8 }] }
```

The body has exactly one field. At most 50 entries are accepted (before
deduplication); each entry has exactly `kind` and a positive safe integer
`number`. Unknown fields, URLs, repository names, invalid numbers and oversized
batches return 400. The response is:

```json
{
  "room_id": "github.com/org/repo",
  "previews": [{
    "kind": "pull", "number": 42, "repository": "org/repo",
    "url": "https://github.com/org/repo/pull/42",
    "title": "Stored title", "state": "open"
  }]
}
```

The route resolves the canonical room and calls the same participant gate as
Events before reading any event. It uses `getGitHubEventLaneRoomId` to select
exactly the Events lane: generated Git-ref and `focus_owned_only` rooms use
their own lane; other focus rooms inherit their parent's lane. A parameterized
batch query selects the latest PR/issue snapshot per kind/number using Events'
`event_order_at DESC, id DESC` ordering. Supplying a number from another
repository only queries this room's lane. The endpoint has no outbound fetch,
repository parameter, cross-room search or GitHub credential access.

Missing or incomplete snapshots are omitted. A usable snapshot has a valid
GitHub object URL matching its kind/number, a title, and a recognized state.
State precedence is merged, closed, draft, open, including stored PR metadata.
Bodies, actors, comments and other metadata are excluded from the response.
Manual artifacts and review/comment events are not used to guess a snapshot.

## Client state and freshness

`shared/message-link-preview-store.mjs` owns the independent preview cache.
Rendered messages register/unregister like reactions, including thread replies;
this is the rendered set, not an IntersectionObserver visibility test. Reads
coalesce and run sequential batches of at most 50 references. Duplicate
references share cache entries, including misses. A background read failure
keeps existing cards and retries on the next trigger. Room, repository and
account changes clear the cache and reject late responses. Unmounting the
provider cancels scheduled work. Message payloads are never used as a preview
cache or changed by the feature.

Desktop provides the store from `useDesktopRoomGitHubEvents`, which already has
the connected repository; web provides it from `Room.vue`, above the chat view,
using the existing GitHub support identifier. This avoids new
repository props through `DesktopRoomShell.vue`, which is unchanged.

Existing GitHub-event and artifact-update stream events, stream reconnect and
opening the room refresh the rendered references. No new resource, webhook
work, focus-room fan-out, message, receipt, notification, push or agent wake is
introduced. The existing artifact event remains pointer-only; the existing
GitHub event contract is unchanged. Clients reread authorized preview data.

An inherited focus lane can remain stale until its own stream gets one of
these events, reconnects, or the room is reopened. This is an explicit limit:
parent-lane updates are not newly forwarded into focus rooms. Data is only as
current as stored supported webhooks; title-only edits without a later supported
event can also remain stale. There is no metadata fetching or polling fallback.

Neither message list nor its ancestors disables native scroll anchoring. The
desktop sidebar's `overflow-anchor: none` does not apply to the message list.
Scrolled-up readers rely on Chromium's native anchoring. For bottom-following,
both lists and desktop threads reuse their reaction revision watcher before layout and
scroll after `nextTick`. Desktop's existing ResizeObserver covers viewport
height changes; it does not detect content-only growth, so the revision watcher
also observes previews. There is no custom anchor algorithm or new observer.

## Verification

Server contract/store/route/database suites and the existing message route
suite are explicitly registered in CI. Tests cover Events-lane isolation,
authorization before reads, request bounds, snapshot completeness/provider
ordering, state precedence, and actual history/single/thread/MCP representation
equality. The production SSE handler is exercised before/after preview reads:
no new frame or message-only subscriber event appears, and message frames retain
the same payload. Client tests cover renderer link collection, compact escaped
cards, batching/context changes and room invalidation. Electron tests cover the
number-only request and local storage refusing HTTP. Database tests require
`TEST_DB_URL` pointing to a fresh database on a Postgres process started by the
tester; they must never run against an existing database.

Fable's live checks remain necessary; unit, SSR and shell checks are not browser
or Electron QA:

1. Desktop/web: PR and issue links, duplicates, inline/fenced code, other repos,
   unknown numbers, three-card limit, escaped titles and narrow/light/dark views.
2. Open/merged/closed/draft snapshots, including closed drafts. With two clients,
   trigger an existing GitHub event/artifact update and verify refresh; reconnect
   and reopen the room. Check the documented inherited-focus limitation.
3. While at the bottom, let a delayed preview arrive and remain at the bottom.
   While scrolled up, let cards above the first visible message grow and verify
   that message stays in place. Include threads and collapsed long messages.
4. Keyboard focus and external link behavior; room/account changes while a read
   is delayed; local desktop rooms; no extra agent activity or notifications.

Follow-up outside this PR: consider adopting the shared URL helper in existing
`github-pr-stats.ts` and `repo-workflow/task-artifacts.ts` recognition paths.
