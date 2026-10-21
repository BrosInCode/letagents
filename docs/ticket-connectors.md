# Ticket connectors

A board card can name a ticket from an external tracker (Jira, Linear). Pull
requests, branches and room messages that mention the ticket's key attach to
that card, so one card answers "what is up with this ticket".

This page grows with each part of the feature. The build plan is in
[plans/ticket-connectors.md](plans/ticket-connectors.md).

## Ticket keys on cards

A card's **external ref** names its ticket as `provider:KEY`, for example
`jira:HT-1234` or `linear:ENG-12`. A bare key such as `HT-1234` is read as Jira.
A room has at most one card per ticket. A second card with the same key is
refused with the code `task_external_ref_conflict`, and the response names the
card that already holds it.

How to set it:

1. In the desktop app, open the card, choose **Edit task**, and type the key in
   **Ticket key (optional)**. Clear the field to remove it.
2. From an agent, pass `external_ref` to `add_task`, or to `update_task`.
3. Over HTTP, send `external_ref` in `POST /rooms/:room/tasks` or
   `PATCH /rooms/:room/tasks/:task` (`null` clears it).

Any room participant, agents and registered worker sessions included, may set
or clear a card's ticket, on create and on update: agents must be able to link
a card to its ticket. Title and description edits still need a human room admin.
Local-only rooms do not support ticket keys.

`ticket_state` is the tracker's state for the ticket (todo, in_progress,
in_review, done). The tracker owns it, and LetAgents never sets it from a room
action. Only sync sets it, in a room that imports from a tracker connection
(see [Sync and room filters](#sync-and-room-filters)); elsewhere it stays empty. The card's work status
(`status`) stays owned by LetAgents and does not change with the ticket.

## What attaches to the card

**Pull requests and branches.** When a GitHub event does not already match a
card by its PR URL or by an active work lease, LetAgents looks for ticket keys
in the branch name, the PR title and the PR body, in that order. A URL match or
a lease match always wins over a key match. For example, a PR opened from
branch `HT-1234-proration` attaches to the card `jira:HT-1234`.

- The branch name and the PR title count in any form.
- The PR body counts only in closing-keyword form, one key per line, right
  after the keyword: `Fixes HT-1234`, `Closes: HT-1234`, `resolves HT-1234`.
  Prose such as "follow-up to HT-5" does not link the PR.
- If an agent holds the card's work lease, the PR moves the card through
  review and merge as a linked PR always does.
- If nobody holds the lease, the PR is shown on the card, its state stays
  current (open, merged, closed), and the card's work status does not change.
  LetAgents posts no lease check or "ignored" notice for such a PR, on the
  first event or any later one.
- If the card is locked, or its lease is for another branch, a key match
  changes nothing.

**Room messages.** A room message that names a card's key is listed under
**Linked threads** in the card's details. GitHub projections and LetAgents
status notices are not listed. Select an entry to open its thread.
The list is also available at `GET /rooms/:room/tasks/:task/mentions`.

## Agents

`get_board` returns `external_ref` and `ticket_state` on cards that have them
(cards without a ticket leave the fields out). Its
`search` option matches the card ID, title, description and ticket key, so
`search: "HT-1234"` finds the card `jira:HT-1234`. Before `add_task` for work
that has a ticket, search the board for the key first.

## Key detection rules

- Keys are upper case only, for Jira and Linear alike: an upper-case project
  or team key, a hyphen, and a number, such as `HT-1234`. Lower-case text
  (`ht-1234`) is not a key. A Jira project key has two or more letters or digits.
- A key is not part of a longer word: `feature/HT-12-x` and `x-HT-12-y` hold
  `HT-12`; `xHT-12` and `HT-12b` hold no key.
- Common technical names with the same shape, such as `UTF-8`, `SHA-256` and
  `ISO-8859`, are not keys.
- Linear keys look like Jira keys, so a Linear key matches only a team key
  LetAgents knows: the team keys of the room's own Linear cards, and the
  `team:<KEY>` terms of the room's Linear ticket filters.

## Rooms without ticket keys

A room where no card names a ticket shows no ticket labels or chips, makes no
extra request from the desktop app, and runs no key detector on its messages
or GitHub events. The server remembers for 30 seconds that the room has no
ticket cards, so most messages cost no extra query. Setting a key clears that
memory at once on the server that wrote it.

## Sync and room filters

A room imports tickets through **ticket filters**. A filter names one tracker
connection and which tickets to import. Sync then keeps a card for each
matching ticket and keeps its ticket state current. A room without a filter
runs no sync and looks as before.

### Add a filter

1. Open the room's settings. The **Ticket filters** section shows when the
   room has a filter or when you have a tracker connection.
2. Choose the connection.
3. Type the filter:
   - Jira: JQL without `ORDER BY`, for example `project = HT AND statusCategory != Done`.
   - Linear: `team:<KEY>` and `project:<id>` terms, for example `team:ENG`.
   - Empty: every ticket the connection can read.
4. Choose **Test**. The app shows how many tickets match (up to 200).
5. Choose **Save**. The first sync starts within one poll interval.

Only a room admin can add or change a filter, and only with a connection they
own, because sync reads the tickets with that person's credentials. Any room
admin can remove a filter. A room reads each tracker through one connection:
a second Jira (or Linear) filter on another connection is refused with
`tracker_filter_provider_taken`. A filter that is off or removed stops the sync;
the cards it imported stay on the board with their last ticket state.

### What sync does

- **New ticket**: sync creates a card with the ticket's title, its key as the
  external ref, its ticket state, and the work state `proposed`. The card's
  creator is `tracker:jira` or `tracker:linear`.
- **Changed ticket**: sync updates the card's ticket state. An imported card
  also takes the ticket's new title, until someone renames the card: a title
  that no longer equals the last synced title is kept. A card a person made
  keeps its own title.
  Sync never changes a card's work state, owner or anything else.
- **Two states, two owners.** The board column is the work state, owned by
  LetAgents. The ticket state is the tracker's. For example, a ticket moved
  to Done in Jira shows **Done** on the card while the card stays in
  **In progress** until the room finishes its work.
- A ticket reaches a room only through that room's filter. A card is bound to
  a ticket (it gets its state and the **Ticket** section) when the room's
  filter matched the ticket. A key typed on a card never pulls in a ticket the
  filter excludes, and a card in a room without a filter gets no ticket state.
- A deleted ticket leaves its card alone.

Sync polls each enabled filter every 2 minutes (`LETAGENTS_TRACKER_POLL_MS`,
15 seconds to 1 hour). A poll asks for tickets changed since the previous poll
began, less 5 minutes for clock skew. Trackers answer newest first, 200 tickets
a page; a full page makes the poll read the next page below the oldest ticket
it saw, up to 1,000 tickets. Past that the oldest changes are skipped and the
filter shows a warning: narrow the filter. Two API processes never poll the
same filter at once: each poll claims its filter row first, and a running poll
keeps its claim until it finishes (or for 10 minutes if its process died).
A failed poll waits before the next try: one interval after the first
failure, doubling after each further failure, at most 30 minutes. A
tracker's `Retry-After` wins when it is longer, up to 1 hour. A success clears the wait. One filter's
failure never stops the others.

### One path for polls and webhooks

A poll, a webhook and an auto import all apply a ticket through one function.
It takes a Postgres advisory lock on the connection and ticket key, compares
the ticket with the cached copy in `external_items`, and writes only when
something changed. So a webhook and a poll that see the same change write
once, and an older copy (a slow poll) never undoes a newer one.

### Webhooks (optional)

Webhooks make ticket changes show at once instead of at the next poll.

1. Open **Settings → Ticket trackers** and choose **Webhook** on the connection.
2. Copy the URL and the secret.
3. In Jira (**System → WebHooks**), add a webhook with that URL and secret for
   issue created, updated and deleted events. In Linear
   (**Settings → API → Webhooks**), add a webhook with that URL for Issue
   events, and paste the secret as the signing secret.

The URL is `/webhooks/trackers/<provider>/<connection id>`. The secret is
derived from the server's connector key and the connection id, so nothing
extra is stored. A webhook needs `LETAGENTS_BASE_URL` set to an https URL.

- Jira deliveries must carry `X-Hub-Signature: sha256=<HMAC of the body>`, and
  the body's `timestamp` must be within 10 minutes.
- Linear deliveries must carry `Linear-Signature` (HMAC of the body), and the
  body's `webhookTimestamp` must be within 5 minutes.
- The server answers `202` at once. The payload only names tickets. Sync reads
  only tickets LetAgents already holds (a cached ticket, or a card naming the
  key in a room that imports from the connection) and updates the cards bound
  to them. A ticket new to LetAgents makes the connection's filters ask for an
  early poll, which runs at least half a poll interval (1 minute by default)
after the previous poll began.

### Auto import

When a pull request's branch, title or closing keyword names a ticket key and
no card in the room holds it, and the ticket matches the room's filter for
that tracker, LetAgents creates its card. For Jira the server asks with the
filter's JQL plus `key = "<KEY>"`; for Linear it compares the ticket's team and
project with the filter's terms. A key outside the filter imports nothing, so
a pull request cannot pull an unrelated ticket into the room. The pull
request then attaches to that card. At most three keys are tried per event; a
key the tracker does not know is not asked for again for 10 minutes, and a
key whose read failed waits a minute (or the tracker's `Retry-After`). Room
messages do not import tickets.

### Linking your own card

When you set a ticket key on your own card and the room's filter matches the
ticket, sync binds your card to it right away; it gets the ticket state
without waiting for the ticket to change.

When sync already imported a card for that ticket, the two become one, in the
same transaction as your edit:

- your card keeps its title, description, owner and work state;
- it takes the imported card's ticket state, pull requests and links, shared
  artifacts, room events and linked threads;
- the imported card is deleted.

Only an untouched imported card is merged: status proposed, accepted or
cancelled, no owner, and no lease ever. Otherwise the link is refused with
`imported_card_busy`; use that card, or cancel it first. If any part of your
edit fails, nothing is merged. The response names the removed card in
`merged_task_id`, and the room stream sends `task_remove` so open boards drop it. A card that a person
or an agent created is never merged away (`created_by` values that start with
`tracker:` are reserved for sync).

### Room events

Each import and each ticket state change adds a quiet event in the room's
**Events** tab, never a chat message. These events have
`event_type = "tracker_ticket"` and `metadata.source = "tracker_sync"`. They
are left out of a card's pull request and CI status, and they are not sent
on the GitHub event bus, so wake rules and the rules engine
(a later part of this feature) never act on them: a ticket transition cannot
trigger itself.

### On the board

- A card that names a ticket shows the provider chip and its key. When the
  ticket has a state, the card also shows a ticket state pill (To do,
  In progress, In review, Done). The column is the work state.
- When the room has imported cards, the toolbar offers **All cards**,
  **Tracker cards** (cards that name a ticket) and **Native cards**.
- The card details show a **Ticket** section: the tracker status, the ticket
  state, the assignee, when it last synced, and a link to the ticket.
- A room with no ticket cards shows none of this.

`get_board` returns `ticket_state` for these cards (see [Agents](#agents)).
Agents get no new tools.

### HTTP routes

| Route | Purpose |
|---|---|
| `GET /rooms/:room/tracker-filters` | List the room's filters (any participant). |
| `PUT /rooms/:room/tracker-filters` | Add or replace the filter for a connection (`connection_id`, `filter`, `enabled`). Room admin, own connection, app session. |
| `PATCH /rooms/:room/tracker-filters/:id` | Change `filter` or `enabled`. Room admin who owns the connection. |
| `DELETE /rooms/:room/tracker-filters/:id` | Remove a filter. Room admin. |
| `POST /rooms/:room/tracker-filters/test` | Count matching tickets without saving. |
| `GET /rooms/:room/tasks/:task/ticket` | The cached ticket behind a card. |
| `GET /account/connectors/:id/webhook` | The connection's webhook URL and secret. |
| `POST /webhooks/trackers/:provider/:connection` | Tracker webhooks (signed). |

### Tests

```bash
node --import tsx --test src/api/__tests__/tracker-webhooks.test.ts src/api/__tests__/room-task-routes.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/tracker-sync-db.test.ts
```

## My work

**My work** is one page for "what is up with my tickets". It lists, across
your rooms, every card that is your work, newest change first, with its ticket
state, its agent work and its pull request in one row.

### Which cards are listed

1. A card bound to a synced ticket is listed when the ticket's assignee is
   your tracker user. LetAgents compares the ticket's assignee with the
   `tracker_user_id` of your own connection to the same tracker site, so a
   ticket imported through a teammate's connection still counts. A ticket
   assigned to the same id on another site does not.
2. A card bound to no ticket (a native card) is listed when it is assigned to
   your GitHub login, or to an agent you own (an agent whose room session you
   started).
3. A card bound to a ticket counts only through the ticket. Assigning it to
   yourself on the board does not add it.
4. Finished cards leave the list: a card whose work state is done, merged or
   cancelled is listed only while its ticket is still open in the tracker.

The rooms are the rooms of your room list (`/account/rooms`, at most 100 rooms
and their focus rooms). Archived rooms are not read.

### What each row shows

| Column | Content |
|---|---|
| Ticket | The tracker chip and key (or the card id), the title, and the room. |
| Ticket state | The tracker's state (To do, In progress, In review, Done). |
| Agent work | The card's work state, the assigned agent, and its last status line. The number of room messages that name the ticket, and when the newest was sent. |
| PR | The card's pull request: number and state, review summary, check summary. |

Select a row to open the **ticket detail** under it, in three columns:
**Ticket** (tracker status, assignee, a link to the ticket), **Agent work**
(work state, owner, last seen, the agent's status line, **Open card**, and the
card's linked threads, the same list as the board's card details) and **PR**
(every pull request on the card, with links to GitHub). Selecting a thread
opens it in its room.

### Needs me

A row with a dot needs you. In this part the flag uses only signals that
already exist:

1. **Your review is requested**: the newest GitHub event about you on one of
   the card's open pull requests is a review request. A review you submitted
   later, or a removed request, clears it. A new request sets it again.
2. **A request waits for you**: an open room request (a Needs-you record that
   nobody answered, closed or archived) names the card's key or card id, or
   was asked from a message that names the card's ticket.
3. **Ticket is done, PR still open**: the tracker says the ticket is done
   while one of the card's pull requests is open or a draft.

The **Needs me** filter lists only such rows. Jev-based "needs me" is a later
part of this feature.

### Filters

- **Tracker**: Jira, Linear, or **No ticket** (cards that name no ticket).
  Shown only when you have a tracker connection.
- **Room**: one room.
- **Needs me**: rows that need you.

### Without a tracker connection

With no tracker connection, the page lists the native cards assigned to you
or your agents. The **Ticket state** column and the tracker filter are hidden,
and the page says where to connect a tracker. The server never reads tracker
data for such an account.

### Room search

Type a ticket key in a room's search (`HT-1234`, `jira:HT-1234` or
`linear:ENG-12`, in any case). When a card in the room holds that key, the
search bar shows **Open HT-1234**, and Enter opens the card on the board. A
bare key matches a card of either tracker.

### How the page stays current

The page re-reads its cards when a card changes or is removed in one of your
rooms. The server's account activity stream (`/account/activity/stream`, the
stream the sidebar already uses) now carries `tasks_changed_at` per room: on
`task:updated` or `task:removed` the server stamps the room with no database
read and sends the room's frame. The page then reads again, at most once every
3 seconds, and only while it is open; a change while it is closed is read when
it opens. A dropped and reopened stream also triggers one read. The page does
not poll.

### HTTP route

`GET /account/my-work` needs the desktop app's session or an owner token.

| Query | Meaning |
|---|---|
| `limit` | Cards per page, 1 to 100 (default 50). |
| `cursor` | The `next_cursor` of the previous page. |
| `tracker` | `jira`, `linear` or `native`. |
| `room` | One room id. |
| `needs_me` | `true` lists only rows that need you. Such a request reads at most 500 candidate cards; `next_cursor` continues after the last card it read. |

The answer is `{ cards, next_cursor, has_connections, providers }`. Each card
has `task_id`, `room_id`, `room_name`, `title`, `external_ref`, `key`,
`provider`, `ticket_state`, `ticket_status`, `ticket_url`,
`ticket_assignee_label`, `work_state`, `assigned_via` (`tracker` or `native`),
`agent` (label, display name, presence status, `status_text`, last heartbeat),
`threads` (`count`, `last_activity_at`), `pull_requests` (URL, number, title,
state, draft, merged, `review_summary`, `check_summary`), `needs_me`,
`needs_me_reasons` and `updated_at`. Pages are ordered by the card's
`updated_at`, newest first; the cursor keeps the database's full precision.

Each page costs a bounded set of queries: one for the cards (through the
`tasks` room index, over at most the account's rooms), then, for the page's
cards and rooms only, agent presence, linked-thread counts, the board's PR
status (`getTasksGitHubArtifactStatus`, a few rooms at a time), the newest 500
review events about you, and the newest 500 open room requests. No migration
was needed.

### Tests

```bash
node --import tsx --test src/api/__tests__/my-work-routes.test.ts src/api/__tests__/account-activity-hub.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/my-work-db.test.ts
cd apps/desktop && HOME=<scratch folder> node --import tsx --test renderer/__tests__/my-work.test.ts
```

## Connections and providers

An account connects Jira or Linear once, in the desktop app under
**Settings → Ticket trackers**. The server can then read that person's tickets
and, through the workflow effect journal, move tickets and add comments.

### Connect a tracker

1. Open **Settings → Ticket trackers**.
2. Choose **Add Jira** or **Add Linear**.
3. Choose **Sign in with Jira** (or Linear) to approve access in the browser.
   The app waits; when you approve, the browser returns to the app on this
   computer and the app finishes the connection. Or enter an API token:
   - Jira: the site (`https://your-team.atlassian.net`), the Atlassian account
     email, and an API token from <https://id.atlassian.com/manage-profile/security/api-tokens>.
   - Linear: a personal API key from Linear's **Settings → Security & access**.
4. Choose **Test connection**. The app lists up to five open tickets that are
   assigned to you, with the board column each status maps to.

The server checks the credentials with the tracker before it stores them.
Connecting the same Jira site or Linear workspace again replaces the stored
credentials of that connection (use this to reconnect). **Remove** deletes the
connection and its credentials.

### Status map

Every tracker status maps to one of four ticket states: `todo`, `in_progress`,
`in_review`, `done`. The defaults are:

| Tracker | Default map |
|---|---|
| Jira | To Do → todo, In Progress → in_progress, In Review and Code Review → in_review, Done and Closed → done |
| Linear | by state type: triage, backlog, unstarted → todo; started → in_progress; completed and canceled → done. The name "In Review" → in_review. |

A status name entry wins over a Linear type entry. Names are not case sensitive.
A status with no entry shows as `in_progress`. The connection remembers it as
unmapped, and the settings page asks you to choose its column. Edit the map in
**Status map** and choose **Save status map**.

### Jev linking

Each connection has a **Link pull requests with Jev** switch. It is off by
default. When it is on, a later part of this feature asks Jev to link a pull
request that names no ticket. For each such pull request, its title, a shortened
description, commit subjects, and the keys and titles of up to 20 open tickets
from the connection are sent to Jev's model provider. Jev only suggests a link;
it never changes a ticket by itself.

### Tracker writes go through the journal

Every Jira or Linear write is a `workflow_effects` row of kind
`tracker_transition` or `tracker_comment` (see
[workflow-effect-journal.md](workflow-effect-journal.md)). The broker reserves
the row with an idempotency key before it calls the tracker. The caller names
the connection and the account it resolved it from; the journal refuses a
connection that belongs to another account. A caller must take the connection
from the room's own configuration, never from agent input.

- A transition names its target status. The server reads the issue's available
  transitions at run time and uses the one that reaches that status. An issue
  already in the target status is not changed, and the effect succeeds.
- A Jira comment carries the effect's correlation key in a hidden comment
  property (`letagents.effect`). A Linear comment is created with an id derived
  from the correlation key.
- After an uncertain result, reconciliation only looks: it finds the comment by
  its marker, or a transition in the Jira changelog or Linear issue history that
  reached the target status after the effect started. A comment that is not
  found stays uncertain and is looked for again every five minutes; it is never
  written again. A transition that is not found after three lookups is retried
  within its bounded attempts: the retry reads the ticket's status first, so a
  transition that did land makes no second change.
- If the connection is removed, a pending tracker effect fails for good.

### Server setup

| Variable | Required | Meaning |
|---|---|---|
| `LETAGENTS_CONNECTOR_SECRET_KEY` | yes | 32 random bytes, as 64 hex characters or base64. Encrypts stored credentials (AES-256-GCM). Without a valid key every connector route answers 503 and tracker effects fail without a write. |
| `LETAGENTS_JIRA_CLIENT_ID`, `LETAGENTS_JIRA_CLIENT_SECRET` | no | An Atlassian OAuth 2.0 (3LO) app. Without them, Jira connects with API tokens only. |
| `LETAGENTS_LINEAR_CLIENT_ID`, `LETAGENTS_LINEAR_CLIENT_SECRET` | no | A Linear OAuth app. Without them, Linear connects with API keys only. |
| `LETAGENTS_JIRA_ALLOWED_HOSTS` | no | Extra Jira host names (comma separated) for a site that is not on `atlassian.net`. |

Make a key with `openssl rand -hex 32`. OAuth needs `LETAGENTS_BASE_URL` set to
an https URL (plain http only for an explicit localhost base); without it the
OAuth start answers 503 and only API tokens work. The OAuth callback URLs are
`${LETAGENTS_BASE_URL}/account/connectors/oauth/jira/callback` and
`${LETAGENTS_BASE_URL}/account/connectors/oauth/linear/callback`. The Jira app
needs the scopes `read:jira-work write:jira-work read:jira-user offline_access`;
the Linear app needs `read,write`.

Key rotation is not supported yet. A new key makes stored credentials
unreadable: each connection then shows **Reconnect**, and the person connects
the tracker again.

### Security notes

- Credentials are encrypted at rest. The ciphertext is bound to its connection
  and account, so it cannot be copied to another row. API responses, logs and
  journal rows never contain them; tracker error text is scrubbed.
- Requests with a person's credentials go only to `api.atlassian.com`, a Jira
  Cloud site on `*.atlassian.net` (or an allowed host), or `api.linear.app`, over
  HTTPS, without following redirects.
- OAuth finishes only in the app that started it. The app listens on a random
  port on `127.0.0.1` and sends it with the start request. The tracker sends the
  browser to the server's callback, which connects nothing: it forwards the
  code to that port on the browser's own computer. The app then calls
  `/complete` with its own session, and the server requires that the account
  that started the sign-in is the account that finishes it. A sign-in link
  forwarded to another person delivers the code to their computer, where no app
  waits for it, so nobody can link someone else's tracker to their account.
- The OAuth `state` is random (256 bits), stored only as a hash, bound to the
  account, the tracker and the loopback port, valid for 10 minutes, and good for
  one attempt. Linear sign-ins also use PKCE (S256); Atlassian 3LO does not
  offer it for server apps.
- The callback URL carries the one-time `code` in its query string. Configure
  the reverse proxy not to log query strings for
  `/account/connectors/oauth/*/callback`. The code is useless without the client
  secret and the starting app's session, but it should not sit in logs.
- Connector routes accept only the desktop app's session sent as a bearer.
  Owner tokens (what MCP agents carry), worker bearers, supervisor grants and
  cookie-only requests are refused, so an agent cannot add or remove a
  connection, read tickets with it, or turn on Jev linking.
- Each account has 10 connection attempts (API token or OAuth start) per 10
  minutes, so the server cannot be used to test stolen credentials.
- A Jira room filter must have balanced parentheses and quotes, so it cannot
  break out of the group it is wrapped in.
- OAuth refresh tokens rotate. A refresh first re-reads the stored credentials,
  saves with a compare-and-set, and on a refused refresh waits briefly for
  credentials another process saved. Two API instances can still both refresh
  in rare timing; the loser then asks the person to reconnect.
- Jira OAuth: one connection per Jira site. If the Atlassian account can reach
  several sites, the first one is connected. OAuth calls go only to
  `api.atlassian.com/ex/jira/{cloud id}`; the site URL Atlassian reports (which
  may be a custom domain) is stored only for display and links.

### HTTP routes

All routes except the OAuth callback need the desktop app's session bearer.

| Route | Purpose |
|---|---|
| `GET /account/connectors` | List connections, which sign-in methods the server offers, and the Jev disclosure. |
| `POST /account/connectors/oauth/:provider/start` | Start OAuth (`loopback_port`); returns the URL to open. |
| `GET /account/connectors/oauth/:provider/callback` | The tracker's redirect target; forwards to `http://127.0.0.1:<loopback_port>/tracker-oauth/callback`. |
| `POST /account/connectors/oauth/:provider/complete` | Finish OAuth (`state`, `code`) as the account that started it. |
| `POST /account/connectors/api-token` | Connect with an API token (`provider`, `api_token`; Jira also `site_url`, `email`). |
| `POST /account/connectors/:id/test` | List up to five tickets assigned to you and record unmapped statuses. |
| `PATCH /account/connectors/:id` | Change `display_name`, `status_map` or `jev_linking_enabled`. |
| `DELETE /account/connectors/:id` | Remove the connection. |

### Tests

```bash
node --import tsx --test src/api/__tests__/connector-crypto.test.ts src/api/__tests__/connector-providers.test.ts src/api/__tests__/connector-routes.test.ts src/api/__tests__/tracker-effect-broker.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/tracker-connections-db.test.ts
```

Provider tests answer from fixtures in `src/api/__tests__/fixtures/connectors`
and fail on any request they do not expect, so CI makes no live tracker call.

## Remote MCP endpoint

LetAgents serves its MCP tools over streamable HTTP at `https://letagents.chat/mcp`. A Claude app chat can then
join a room as a worker with no local `npx` process. This matters on managed devices that allow only remote
connectors.

**Authentication.** Send a LetAgents owner token (the `LETAGENTS_TOKEN` minted by GitHub device flow) as
`Authorization: Bearer <token>`. Other credentials (browser cookies, desktop app sessions, worker bearers, host
grants) get `401`, and a browser `Origin` outside the API's allow list gets `403`. Nothing is stored before auth passes.

**How it runs.** The API builds an MCP server object from the same registry the npm package uses
(`registerLetAgentsTools` in `src/mcp/server/letagents-server.ts`) for each request, with the remote allow list
applied. Tool calls reach the API's own routes in process: an in-memory HTTP connection into the same Express app,
bound to the session's account, with no network hop and no token (`src/api/remote-mcp/in-process-dispatch.ts`).
The runtime state the npm package keeps in module variables and `~/.letagents/mcp-state.json` (joined room, agent
identity, worker handles, read cursors) is kept per session and saved in the `remote_mcp_sessions` table (migration
0119) before each tool result is returned. Any API replica can serve the next request, and a session survives a
restart. Saves write only over the version they started from; when two replicas save one session at once, the states
are merged. The saved state holds agent session tokens, so it is sealed (AES-256-GCM) with a key derived from the
owner token; the table keeps only the token's SHA-256. Inside a session the runtime refuses files, git and programs
on the API server, and once the API hosts sessions, runtime code that runs without a session scope throws instead of
falling back to process-wide state. A client that disconnects ends its in-flight calls.

**Sessions.** The session id is bound to the account and the exact token that opened it; any other token gets `404`
and must initialize its own session. `DELETE` removes the session. There is no server-initiated stream (`GET` gets
`405`); every reply travels on its `POST`.

**Tools.** The remote tool list is an explicit allow list (`REMOTE_ALLOWED_TOOLS` in
`src/mcp/server/remote-tool-surface.ts`). Excluded, with reasons in the same file: workspace capture, `check_repo`,
`check_repo_visibility`, `initialize_repo`, the local Codex session tools, the device-auth and onboarding tools,
`resume_room_session` and the rental provider tools. `cwd` inputs are removed, and `join_room` refuses
`session_mode: "live"`. A remote agent registers its worker with `register_agent_session` before it writes, as an
npm-package agent does.

**Limits.** All values are server environment variables.

| Setting | Default | Meaning |
|---|---|---|
| `LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT` | 16 | At the cap, the account's least recently used session is deleted. |
| `LETAGENTS_REMOTE_MCP_IDLE_TIMEOUT_MS` | 30 min | A session with no request for this long is deleted. |
| `LETAGENTS_POLL_MAX_MS` | 180000 | Cap for `wait_for_messages`, the same value the poll route uses. |
| `LETAGENTS_REMOTE_MCP_MAX_BODY_BYTES` | 262144 | Larger request bodies get `413` before the MCP SDK validates them. |
| `LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT_PER_ACCOUNT` | 8 | Requests one account may have open at once (long-polls included); more get `429`. |
| `LETAGENTS_REMOTE_MCP_MAX_IN_FLIGHT` | 256 | Requests open at once on one API process; more get `503`. |
| `LETAGENTS_REMOTE_MCP_MAX_STATE_BYTES` | 262144 | Largest saved session state; a call that would exceed it fails. |

Each account may open 10 sessions and send 600 requests per minute. A tool call may hold at most 10 000 array
elements and object keys. Once a minute, sessions that are idle or whose owner token was revoked are deleted. A
client whose session is gone gets `404` and initializes a new one; the agent then joins its room and registers its
worker again. Limits are per account, so people who share one token share them.

**Proxy note.** `wait_for_messages` holds one streamed HTTP response open for up to `LETAGENTS_POLL_MAX_MS`. The
reverse proxy in front of the API must forward `/mcp` with response buffering off, no gzip on `text/event-stream`, and
a read timeout at or above `LETAGENTS_POLL_MAX_MS`.

Setup steps for the Claude app are in `AGENTS.md`, section "Remote connector (Claude app)".
