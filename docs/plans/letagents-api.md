# LetAgents API: one contract for pages, agents, apps and outside tools

Status: building, 2026-11-18. Integration branch `feat/letagents-api` (from `staging` ae0ef1b89).
Each PR below targets `feat/letagents-api`; one final PR takes it to `staging`.
Owner: EmmyMay. Executing agents: one subagent per PR, reviewed by a different subagent.

## Goal

LetAgents gets one public API: typed reads of what is in a room, shared data, actions as intents,
structured agent jobs, and live events. Every client uses the same contract: pages pinned in a room,
agents over MCP, the desktop, web and iPhone apps, and later outside tools with a token.

The first client is **room pages**: an HTML tool that a team pins in its room, written and changed
by the room's agents. This is how one company gets its own sprint view, release checklist or triage
desk without LetAgents changing for that company.

Two reference pages test the design from different sides:
- **Schedule Hub** (Herotel): Jira-heavy, shared tables, meeting transcripts, release tracking.
- **Review queue** (any GitHub-only room, no tracker): open PRs, checks, who is waiting on whom,
  "ask an agent to rebase this".

## Non-goals

- No code from a page runs in the app. Pages run only in a sandbox.
- No direct writes from any client to an outside system. Outside writes go through intents.
- No page network access.
- No marketplace, no billing, no third-party developer program in this plan.

## Principles every PR must keep

1. **Contract first.** Every resource, method, event and error is defined once in `shared/api/`.
   Server checks, client types, the page bridge and MCP tool descriptions all come from it.
2. **One server API, many transports.** The desktop bridge, a web iframe, an iPhone web view, MCP
   and HTTPS tokens call the same server routes. Clients hold no permission logic of their own.
3. **Every call has an actor chain.** Who (person or agent), through what (page version, job,
   integration), for whom. A delegated caller gets the overlap of its own grant and the person's
   rights, never more.
4. **Reads are direct. Outside writes are intents.** An intent passes the room policy, then the
   effect journal (`workflow_effects`) or an agent does the write.
5. **Events are pointers.** An event says "this changed"; the client reads again through a checked
   route. Permission is enforced in one place, on reads.
6. **Additive versioning.** Inside `api: 1`, changes only add. Contract tests fail on a breaking
   change.
7. **Rooms that use none of this are unchanged.** No new UI, prompts or agent behaviour until a room
   pins a page or a client calls the API.

## Where we start (facts on staging ae0ef1b89)

1. Contracts are written per client: desktop IPC types, web composables, MCP tool schemas (zod in
   `src/mcp/server`), iPhone Swift. Some are shared as hand-written `shared/*.mjs` + `.d.mts`
   (`message-contracts`, `room-resource-invalidation`). Attachment upload logic exists three times.
2. Auth kinds are `session`, `owner_token`, `agent_session`, `supervisor_grant`, `mcp_oauth`
   (`src/api/http/helpers.ts`). `mcp_oauth` is limited by path: the middleware refuses it outside
   `/mcp`, and inside a remote MCP session it acts as a full owner token. So it is a precedent for
   the path limit only, not for narrower rights.
3. Agent writes to the board go through board intents; Board Manager modes are `off`,
   `manager_optional`, `intent_required`. An approved board intent runs nothing: the agent must send
   the change again with the intent id. A person's own board writes skip board intents. Outside
   writes go through `workflow_effects` with kinds `github_review_verdict`, `tracker_transition`,
   `tracker_comment`; `task_id` is required, and only the rules engine checks that a ticket belongs
   to the room.
4. Live updates: room SSE stream with `resource_invalidation_v1` pointer events
   (`shared/room-resource-invalidation.mjs`), carried between API processes by Postgres NOTIFY.
   The stream already supports `Last-Event-ID` replay and sends `room_sync` with a `gap` flag. The
   replay buffer is in memory in one process: 256 events, 60 s, 2 MB per room.
5. Tracker sync runs with the connection of the admin who set the room filter. Jira filters are
   wrapped by `jiraFilterClause`, which rejects unbalanced brackets and quotes.
6. Desktop runs HTML demos in a locked sandbox (`apps/desktop/electron/main/attachments/html-demo-*`):
   in-memory partition, no network, no permissions, no preload, no bridge.
7. `request_human_input` already pairs a record with a message by a reserved `client_message_id`
   namespace: the model for linking a job to its thread.

## Vocabulary

| Term | Meaning |
|---|---|
| actor chain | Who made a call, through what, for whom. Stored with every write. |
| grant | The capabilities one delegated caller holds (a page version, an integration token). |
| capability | A named permission, like `tickets.read` or `tasks.propose`. |
| policy | Per room, per capability: what happens when it is used (allow, confirm, approve, deny). |
| intent | A proposed write with a kind and a payload. Policy decides; an executor does it. |
| executor | The effect journal (mechanical writes) or an agent (work that needs judgement). |
| job | Structured work for an agent: instruction, input, result schema, status, result. |
| surface | A place in the apps where a page shows (room tab first). |
| manifest | JSON in a page: API version, capabilities, surfaces, data scopes. |
| collection | Shared JSON documents in one scope: viewer, page or room. |

---

## Architecture

### 1. Contracts (`shared/api/`)

- One module per area: `rooms`, `people`, `agents`, `messages`, `tasks`, `planning`, `work-items`,
  `git`, `memory`, `data`, `intents`, `jobs`, `events`, `pages`, `errors`.
- Each method has: name, capability, input schema, output schema, error codes, rate class, and
  whether it is a read, an intent or a job.
- Format: zod 4 schemas (zod is already used by `src/mcp/server` and the desktop main process; it is
  only a transitive dependency at the root today, at a different patch version than the desktop's
  pin, so make it direct and pin one version). PR0 proves the pipeline: server validation,
  generated `.d.ts` for clients and pages, JSON Schema for MCP tool inputs.
- All 86 `shared/*.d.mts` files are written by hand today, and the root `tsc` compiles only `src`.
  So PR0 adds a declaration build step (`allowJs` over `shared/api/`), or puts the contracts in
  `src/shared/api/` as `.ts` and builds them for the desktop. PR0 decides and proves one.
- One error shape everywhere: `{ code, message, retryAfterMs? }` with codes `not_granted`,
  `not_participant`, `not_found`, `no_source`, `source_unavailable`, `rate_limited`, `conflict`,
  `too_large`, `declined`, `pending_approval`.
- The contract is the documentation. The page reference and the MCP tool descriptions are generated
  from it, so an agent can build a page from the tool description alone.

### 2. Actor chain and grants

- Every request resolves to an actor:
  `{ principal: person | agent, via?: { kind: page | job | integration, id, version? }, room }`.
- New auth kind `page_grant`: a short-lived token (15 min, refreshed by the client) bound to
  (account, room, page id, page version). The desktop main process mints it with the person's
  session and keeps it; the page never sees it.
- `page_grant` is accepted only on `/api/v1/…` routes and refused everywhere else, the same way
  `mcp_oauth` is refused outside `/mcp`. Older routes check only the account and room role, so this
  path limit is what keeps a page from using the person's full rights. Every `/api/v1` route
  checks the capability for the grant.
- The live access recheck (`src/api/rooms/access.ts`) learns `page_grant`, so unpin or revoke closes
  open streams at once.
- Rights = person's room rights ∩ the page version's grant. An agent acting through a job keeps its
  own agent rights; the job does not widen them.
- Writes, intents and jobs append to `api_actions` (actor chain, capability, target, outcome, time).
  Reads are rate-limited, not logged.
- Messages, intents and jobs made through a page show "via <page>" in the room.

### 3. Capabilities and room policy

- One registry in `shared/api/capabilities.mjs`. Names: `<area>.<verb>`, for example `tasks.read`,
  `tasks.propose`, `tickets.read`, `tickets.propose`, `data.room`, `jobs.start`.
- A page manifest asks for capabilities. A room admin grants them when pinning.
- Room policy, per capability, with safe defaults:

| Capability | Default |
|---|---|
| any `*.read` | allow for room participants |
| `data.viewer`, `data.page` | allow |
| `data.room` | allow for participants |
| `tasks.propose` | allow when Board Manager mode is `off`; an intent when `shouldRequireBoardIntent` is true |
| `tickets.propose` | admin approval, or allow when the viewer's own tracker connection runs it |
| `jobs.start`, `messages.post` | viewer confirms in an app-drawn sheet |

- The confirm sheet is drawn by the app, never by the page, and shows the exact text and target.
  A viewer can tick "Don't ask again for this page version".

### 4. Read model (v1)

| Area | Reads |
|---|---|
| rooms | current room, settings a page may know (name, kind, repo, visibility) |
| people | members with role; the viewer |
| agents | agents in the room, owner, online state, access level label |
| messages | a thread by id; recent messages (paged); a job's thread |
| tasks | board tasks with status, assignees, external ref, PR links |
| planning | sprints, release queue, board planning document |
| work items | search/get across the room's tracker sources; normalised fields + a raw `fields` map |
| git | open PRs, checks and reviews for the room's repo |
| memory | room facts |

Work items rules:
- A search is `(<room filter>) AND (<query>)`, both through `jiraFilterClause`. An empty or disabled
  room filter gives `no_source`. This stops a page from using the filter owner's token to read the
  whole Jira site.
- `currentUser()` means the filter owner; the reference says so.
- Normalised fields: key, title, url, status, statusCategory, state, assignee, storyPoints, sprints,
  parent, fixVersions, labels, statusChangedAt, updatedAt, linked task. Custom fields come in
  `fields` only when the manifest names them.
- Server cache 60 s per (room, query), keyed by a per-room sync generation that `applyItem` bumps.
  At most 2 live searches per room per 10 s.
- `history(key)` reads the changelog for exact time in status.

### 5. Data collections

- One table, `api_documents (room_id, scope, scope_id, collection, doc_id, data jsonb, revision,
  updated_by, updated_at)`. Scopes:
  - `viewer`: one person, one page (settings, tab choice). 16 KB per page per viewer.
  - `page`: shared by everyone using one page (meeting next steps). 
  - `room`: shared by all pages and agents in the room (a room's release calendar).
- Compare-and-set by `revision`; 409 `conflict` on mismatch.
- Caps: 64 KB per doc, 5,000 docs per scope id, 120 writes per minute per actor.
- Agents read and write the same collections through MCP, so "sync to Excel" is an agent job that
  reads a collection and writes the file with the agent's own tools.

### 6. Intents

- `intents.propose(kind, payload)` returns `{ id, state }` with states `pending_approval`,
  `approved`, `running`, `done`, `failed`, `denied`.
- v1 kinds and executors:

| Kind | Executor |
|---|---|
| `task.update` (status, assignee, fields) | new server executor that runs the approved change as the person |
| `task.create` | same executor |
| `ticket.transition` | `workflow_effects` `tracker_transition` |
| `ticket.comment` | `workflow_effects` `tracker_comment` |

- Board intents only approve today; the agent re-sends the change. Pages have no agent to re-send,
  so PR4 adds an executor that applies an approved intent itself. The pending-intent unique index
  gets the person's account, so two people can propose the same change.
- For the ticket kinds: `workflow_effects.task_id` becomes nullable with a `subject` column (most
  tickets have no card). The intent handler checks that the ticket is inside the room filter, and,
  when the viewer's own connection runs it, that the connection's `site_key` matches the room's
  tracker site.

- Agents propose the same kinds over MCP, so there is one write path for pages and agents.
- New kinds are added in the contract with an executor and a default policy, nothing else.

### 7. Jobs

- `jobs.start({ agent?, instruction, input?, files?, resultSchema? })` posts a thread root in the
  room ("via <page>") and creates a `jobs` row linked by a reserved `client_message_id` namespace
  `internal:job:<id>`, added to the reserved-namespace check like `internal:attention-*`.
- The server always picks one target agent and mentions it exactly (`@agent:<key>`): the one the
  page names, or the room's choice (recent partner, else the first online agent). A person's
  message without a mention wakes nobody in rooms with more than two agents, so this is required.
- `no_agent` uses the 90 s presence window (`src/shared/agent-presence.ts`), not open MCP
  sessions, which can be stale (see #1988).
- States: `queued`, `no_agent`, `running`, `needs_input`, `done`, `failed`, `cancelled`.
- Agents get MCP tools `update_job(progress)` and `complete_job(result)`, written by hand in PR5.
  The result is checked against `resultSchema`. The daemon change: a reply to a job root goes into
  its thread (today a reply to a top-level message stays top-level).
- A job carries no permission. The agent's own access level and the room policy decide what it can
  do. A job can propose intents and can create a board task when the work is large.
- Later, triggers (a schedule, a ticket change) start the same jobs.

### 8. Events

- `events.subscribe(resource, filter?)` on top of the room stream. Events stay pointers:
  `{ resource, ids?, cursor }`. The client reads again.
- New resources in `ROOM_RESOURCE_INVALIDATION_RESOURCES`: `work_items`, `documents`, `jobs`,
  `intents`, `pages`. The v1 wire event stays `resource_invalidation_v1` with `room_id` + `resource`;
  ids in the event need a `v2` event and are not needed for v1.
- Catch-up uses the stream's existing `Last-Event-ID` replay. The buffer is per process and keeps
  60 s, so one rule covers every miss: on `room_sync` with `gap`, the client reads all its
  subscribed resources again.

### 9. Pages, surfaces and the manifest

```html
<script type="application/letagents-page+json">
{ "api": 1,
  "title": "Schedule Hub",
  "surfaces": ["room.tab"],
  "capabilities": ["work_items.read", "planning.read", "data.page", "data.viewer", "jobs.start"],
  "workItemFields": ["customfield_10027"],
  "collections": { "page": ["mos_items", "leave"], "viewer": ["prefs"] },
  "owner": "room" }
</script>
```

- Surfaces in the contract from day 1: `room.tab`, `task.panel` (gets the task and work item as
  context), `message` (an interactive message an agent posts: a form or a checklist),
  `room.widget`. v1 ships `room.tab` only.
- `owner` is `room` or `org` from day 1; v1 ships `room` only. An org library comes later.
- Tables: `pages (id, owner_kind, owner_id, slug, title, current_version)`, `page_versions (page_id,
  version, object_key, sha256, manifest, author, status)`, `page_placements (page_id, room_id,
  surface, position, pinned_by)`, `page_grants (page_id, version, room_id, capabilities,
  approved_by)`. Placements are separate so one org page can sit in many rooms later.
- HTML is copied into page storage at pin time (2 MB max). Deleting the chat message keeps the page.
- Every page route resolves the page through its placement in the room in the URL; 404 otherwise.

Who can do what:

| Action | Who |
|---|---|
| View a page | Room participant |
| Pin, unpin, grant, roll back, delete | Room admin, signed-in person |
| New version, same capabilities | Room admin, or any agent in the room; goes live with an "Updated by" banner and Undo |
| New version, more capabilities | Waits for a room admin |
| New version of a page that holds `jobs.start`, `messages.post` or `*.propose`, made by a non-admin or by an agent whose owner is not an admin | Waits for a room admin |

### 10. Page conveniences

These are part of the page contract, not separate APIs:
- `ui.open(url)`: https only, opens in the system browser; first use of a new domain shows it.
- `ui.copy(text)`: plain text, after a click in the page.
- `ui.theme`: light or dark plus `--la-*` colour tokens, with a change event.
- `ui.context`: viewer, room, surface context (for `task.panel` later).
- Diagnostics: console errors, uncaught exceptions and failed calls per page version, readable by
  agents through MCP (`read_page_diagnostics`). A `draft` version is visible only to admins and the
  author's owner, with a Preview switch.

### 11. Transports

| Client | Transport | v1 |
|---|---|---|
| Desktop page | preload bridge → main → `page_grant` HTTPS | yes |
| Agents | MCP tools generated from the contract | yes |
| Desktop app itself | existing IPC, moved onto contract types area by area | partly |
| Web page | sandboxed iframe on a separate origin, `postMessage` bridge | later |
| iPhone page | WKWebView with a message handler | later |
| Outside tools | HTTPS with a scoped token, same routes | later |

Desktop bridge details (from the demo sandbox):
1. Own in-memory partition `letagents-pages` and own scheme host per mount.
2. Same CSP and network block as demos.
3. One `will-attach-webview` router for demos and pages. The demo listener today calls
   `preventDefault()` for every webview without a demo lease, so it must be replaced, not joined.
4. A standalone CommonJS preload (the desktop build emits ESM today), set by main only for page
   leases. It exposes `window.letagents` and talks over one channel, `page:call`. Main checks the
   sender against the page lease registry and checks input against the contract.
5. Own lease budget, kept alive while the room is open, no 5 s liveness kill (stop only on
   `unresponsive`), no 760 px zoom.
6. `RoomTabId` gets `` `page:${string}` ``; more than 3 pinned pages go into a "Pages" menu.

## Threat model

We guard:
1. **Widening tracker visibility** through the filter owner's token: room filter AND query; empty
   filter is `no_source`.
2. **Acting as a person without them**: app-drawn confirm sheet for jobs and posts; version rule for
   pages that hold write-like capabilities.
3. **Writing beyond a person's own tracker rights or room**: `tickets.propose` needs an admin
   unless the viewer's own connection runs it; the ticket must be inside the room filter, and the
   viewer's connection must be on the room's tracker site.
4. **Cross-room access**: every page and document route resolves through the room in the URL.
5. **Escalation through delegation**: `page_grant` works only on `/api/v1`, where every route
   checks the capability; rights are always the overlap; a job never adds rights.
6. **A page reaching other IPC**: one channel with a sender check.
7. **Abuse**: caps and rate classes per actor, from the contract.

We do not guard, and say why:
- Pages reading room data: they see only what the viewer sees.
- Exfiltration: no network; jobs, posts and documents are visible to the room.
- DNS prefetch / WebRTC lookups from the sandbox: accepted for demos already.
- Encrypting documents per page: they are room data, like messages.
- Work item queries as a yes/no oracle: Jira refuses (400) a query that names a project or key it does
  not know and answers (200, empty) one it does, so a caller can still learn whether a project or key
  exists on the site. The API forwards no Jira error text, only "Jira refused the query"; the bit that
  remains is accepted.

## Build order

```
PR0 contracts + generator ─┬─ PR1 actor chain, page_grant, policy, api_actions
                           ├─ PR2 read model v1 ── PR4 intents ─┐
                           ├─ PR3 documents ────────────────────┤
                           ├─ PR5 jobs (+ daemon threads) ──────┼─ PR7 pages registry ─ PR8 desktop surface + bridge ─┐
                           └─ PR6 events ───────────────────────┘                                                     │
                                         PR9 MCP tools from the contract (after PR2–PR6) ───────────────────────────────┴─ release ─ PR10
```

PR0 first. Then PR1, PR2, PR3, PR5 and PR6 can run in parallel (PR1 lands before the others merge,
since they record actors). PR4 needs PR2's ticket-scope check. Before PR10: an npm publish of the
MCP package (publish runs only on a version change) and a desktop release with the new MCP pin and
daemon version. Size: about 4 to 5 agent days in all, plus reviews and that release.

### PR0: Contract foundation
- `shared/api/` layout, zod as a direct dependency, generator for `.d.ts` and MCP JSON Schema,
  contract tests that fail on a removed field or a narrowed type.
- Move one existing area (room resource invalidation) onto it to prove the pipeline.

### PR1: Actor chain, grants and policy
- `page_grant` auth kind (mint, refresh, revoke on unpin and sign-out), actor resolution middleware,
  capability registry, room policy table with defaults, `api_actions` table.
- Tests: a `page_grant` on any route outside `/api/v1` is refused; the overlap rule (a page with
  `tasks.read` for a viewer without room access gets `not_participant`); a revoked grant fails at
  once and closes its stream; agent bearers cannot pin or grant.

### PR2: Read model v1
- `/api/v1/rooms/<room>/…` routes for the areas in section 4. Work item scoping, cache, history.
- Tests: `) OR (project = HR` is rejected; an empty filter is `no_source`; a ticket outside the
  filter is `not_found`; a search right after a change returns the new state.

### PR3: Documents
- `api_documents`, three scopes, caps, compare-and-set, MCP access.

### PR4: Intents
- `intents` table, policy evaluation, the task executor, `workflow_effects` subject change, ticket
  room-scope and site checks, intent events.
- Tests: `ticket.transition` from a member waits for an admin; with the viewer's own connection it
  runs; a ticket outside the room filter or on another Jira site is refused; an approved
  `task.update` is applied without an agent; a denied intent writes nothing.

### PR5: Jobs
- `jobs` table, `internal:job:` namespace, target agent choice, `no_agent` by presence window,
  daemon replies into the job thread, hand-written `update_job` / `complete_job`, result schema
  check.

### PR6: Events
- New resources in the invalidation list, a client helper with the gap rule. No new cursor work:
  `Last-Event-ID` replay exists.

### PR7: Pages registry
- `pages`, `page_versions`, `page_placements`, `page_grants`; manifest parser from the contract;
  version rules; draft state; diagnostics store.

### PR8: Desktop surface and bridge
- Partition, scheme, preload build, webview router, `page:call` dispatcher, room tab, Pages menu,
  "Pin to room" on HTML attachments, grant sheet, confirm sheet, "Updated by" banner, `ui.*`.
- Tests: a call from a demo or the main window to `page:call` is refused; a demo still attaches
  after the router change; a cancelled confirm sheet returns `declined` and posts nothing.

### PR9: MCP tools from the contract
- Generated tools for reads, documents, intents, jobs; page tools (`list_pages`, `read_page`,
  `publish_page`, `read_page_diagnostics`); tool descriptions include the generated page reference.

### PR10: Reference pages
- Schedule Hub on `window.letagents` in a test room with a Jira filter.
- Review queue in a GitHub-only room with no tracker.
- Done when: both are built by an agent from the MCP tool descriptions alone; Schedule Hub release
  items turn green within one poll interval of Done in Jira; two people edit the next steps table at
  once; a job from each page reaches an agent and its result shows in the page; the review queue
  works with `no_source` for work items.

## Later

- Surfaces `task.panel`, `message`, `room.widget`.
- Org-owned pages and a company page library; copy a page to another room.
- Web and iPhone page transports; outside HTTPS tokens.
- Triggers that start jobs (schedule, work item change, PR event).
- Event `v2` with ids; per-field change events.
- Moving the desktop, web and iPhone apps onto the contract area by area.

## Decisions taken for the build (owner may revise)

The owner said "start building" with these four open. The build uses the recommended answer for each.

1. Agent versions with the same capabilities go live with an "Updated by" banner and Undo.
2. `tickets.propose` needs admin approval unless the viewer's own tracker connection runs it.
3. New routes live under `/api/v1/…`; existing app routes stay and move over later, area by area.
4. Outside HTTPS tokens wait until after v1 (not in this build).
