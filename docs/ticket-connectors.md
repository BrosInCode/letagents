# Ticket connectors

A board card can name a ticket from an external tracker (Jira, Linear, GitHub
Issues). Pull requests, branches and room messages that mention the ticket's
key attach to that card, so one card answers "what is up with this ticket".

This page grows with each part of the feature. The build plan is in
[plans/ticket-connectors.md](plans/ticket-connectors.md).

## Connectors page

The desktop app keeps everything a person connects on one page: **Settings →
Connectors** (under **You**). The page has three parts:

| Part | What it lists | Where it was before |
|---|---|---|
| **Trackers** | Jira, Linear and GitHub Issues connections (this document). | Settings → Ticket trackers |
| **Agent apps** | Agent apps on this computer that run LetAgents as a local MCP server, and the flow to connect another one. | Settings → Connections → Connected apps, Connect an app |
| **Remote sign-ins** | Apps signed in through the remote MCP connector (`/mcp`), with the steps to add it. | Settings → Connections → Remote connector |

At the top, one list shows every connector with its name, its kind (Tracker,
Agent app or Remote sign-in) and its status:

- **Connected**: the connection works.
- **Not connected**: an agent app on this computer that has no LetAgents setup.
- **Needs attention**: a tracker that needs a reconnect or reported an error,
  or an agent app whose LetAgents setup has a problem.

**Add connector** opens a catalog: Jira, Linear, GitHub Issues, Connect an agent
app, and Remote connector. A tracker opens its form on the Trackers part;
Connect an agent app opens the setup flow; Remote connector shows the steps.

The old settings ids still open: `system:mcp` opens Agent apps,
`system:setup` opens the setup flow, and `system:remote-mcp` opens Remote
sign-ins (`legacySettingsPaneRedirects` in
`apps/desktop/renderer/src/components/desktop/settings/navigation.ts`). The
Trackers part keeps the id `account:connectors`.

When the server has no `LETAGENTS_CONNECTOR_SECRET_KEY`, the connector routes
answer 503 with the code `connectors_not_configured`. The page then shows
"Connectors are not enabled on this server. Ask your server admin to set
LETAGENTS_CONNECTOR_SECRET_KEY." instead of an error, and the trackers in the
catalog cannot be added. Agent apps and remote sign-ins do not need the key. The
app also reads the older 503 text, so it shows the same state for a server
released before the code existed.

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
- GitHub Issues keys are `owner/repo#123`, stored in lower case
  (`github:brosincode/letagents#123`). The detector reads `#123`,
  `owner/repo#123` and `Fixes #123` only in a room whose GitHub Issues filter
  names that repository; with no such filter, GitHub keys match nothing. A bare
  `#123` names the pull request's own repository when the filter names it, else
  the only repository the filter names, else nothing. A number inside a word, a
  path, a URL or an HTML entity (`&#123;`) is not a key. A number that is a pull
  request, not an issue, imports nothing.

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
   - GitHub Issues: up to 10 repositories as `owner/repo`, separated by spaces,
     for example `BrosInCode/letagents`. Each one must be in the connection's
     GitHub App installation, and you must be able to read it on GitHub.
   - Empty (Jira and Linear only): every ticket the connection can read.
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

1. Open **Settings → Connectors → Trackers** and choose **Webhook** on the connection.
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
and their focus rooms). Archived rooms are not read. Before a room's cards are
shown, the server checks that you may still read the room (the cached access
decision that room notifications use); a private Git Room you lost access to is
left out.

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
   nobody answered, closed or archived) names the card's key or card id, in
   any case, or was asked from a message that names the card's ticket. A
   request is not addressed to one person, so in a room with several people
   it shows for each of them.
3. **Ticket is done, PR still open**: the tracker says the ticket is done
   while one of the card's pull requests is open or a draft.

The **Needs me** filter lists only such rows. On a card whose ticket's
connection has Jev on, **Ask Jev who this waits on** gives Jev's reading (see
[Ask Jev who a card waits on](#ask-jev-who-a-card-waits-on)).

### Filters

- **Tracker**: Jira, Linear, or **Not from a tracker** (cards that sync did
  not bind to a ticket, including cards with a typed key). Shown only when you
  have a tracker connection.
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
rooms, or when a pull request or review event, or a finished check run,
arrives there. The
server's account activity stream (`/account/activity/stream`, the stream the
sidebar already uses) now carries `tasks_changed_at` per room: on
`task:updated`, `task:removed` or such a GitHub event the server stamps the
room with no database read and sends the room's frame. The page then reads
again: 3 seconds after its previous read when the changed room holds a card on
the page, else 30 seconds after it. It reads only while it is open (it reads
everything when it opens), and once after a dropped stream reopens. The
desktop app keeps these stamps apart from the sidebar's room activity, so a
card change does not redraw the sidebar. The page does
not poll. A new or answered room request does not stamp the room, so its
**Needs me** flag shows on the next read or **Refresh**.

### HTTP route

`GET /account/my-work` needs the desktop app's session or an owner token.

| Query | Meaning |
|---|---|
| `limit` | Cards per page, 1 to 100 (default 50). |
| `cursor` | The `next_cursor` of the previous page. |
| `tracker` | `jira`, `linear` or `native`. |
| `room` | One room id. |
| `needs_me` | `true` lists only rows that need you. |

A request reads at most 500 candidate cards. With `needs_me` a page can come
back short, or empty, with a `next_cursor`: the next page continues after the
last card read.

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
partial indexes of migration `0124_my_work_task_indexes`, which hold a room's
unfinished cards and its finished cards whose ticket is still open, so the
done cards of a busy board are never read), then, for the page's
cards and rooms only, agent presence, linked-thread counts, the board's PR
status (`getTasksGitHubArtifactStatus`, narrowed to the page's cards, a few
rooms at a time), the newest 500
review events about you, and the newest 500 open room requests. Each card's PR
status and each room's review events and requests are read once per request,
however many batches it reads.

### Tests

```bash
node --import tsx --test src/api/__tests__/my-work-routes.test.ts src/api/__tests__/account-activity-hub.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/my-work-db.test.ts
cd apps/desktop && HOME=<scratch folder> node --import tsx --test renderer/__tests__/my-work.test.ts
```

## Connections and providers

An account connects Jira, Linear or GitHub Issues once, in the desktop app under
**Settings → Connectors → Trackers**. The server can then read that person's
tickets and, through the workflow effect journal, move Jira and Linear tickets
and add comments.

### Connect a tracker

1. Open **Settings → Connectors → Trackers**.
2. Choose **Add Jira** or **Add Linear** (for GitHub Issues, see below).
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

Each connection has a **Use Jev with this connection** switch. It is off by
default, and every Jev question for the connection's rooms needs it (see
[Jev decides the link and the exceptions](#jev-decides-the-link-and-the-exceptions)).
The disclosure next to the switch names what leaves the server for each kind
of question. Jev only suggests; a person approves every ticket change.

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
| `POST /account/connectors/api-token` | Connect with an API token (`provider`, `api_token`; Jira also `site_url`, `email`). Refuses `github`. |
| `POST /account/connectors/github-app` | Connect GitHub Issues: the GitHub App installation that holds `repository` (`owner/repo`). |
| `POST /account/connectors/:id/test` | List up to five tickets assigned to you and record unmapped statuses. |
| `PATCH /account/connectors/:id` | Change `display_name`, `status_map` or `jev_linking_enabled`. |
| `DELETE /account/connectors/:id` | Remove the connection. |

Without a connector key every route answers 503 with
`{ "error": "Connectors are not enabled on this server. Ask your server admin to set LETAGENTS_CONNECTOR_SECRET_KEY.", "code": "connectors_not_configured" }`.
OAuth routes know only Jira and Linear; `GET /account/connectors/:id/webhook`
answers 409 for a GitHub Issues connection.

### GitHub Issues

GitHub Issues uses the LetAgents GitHub App that the server already runs for Git
Rooms. There is no token to paste and no new credential is stored.

**Connect.** Choose **Add GitHub Issues**, type one repository (`owner/repo`)
where the App is installed, and choose **Connect**. The server:

1. finds the App installation that holds that repository (the server's own
   record, kept current by the App's `installation` webhooks);
2. checks that your GitHub login is the GitHub id you signed in with, and that
   you have your own access to that repository (a collaborator or an
   organization member with access, `GET /repos/{owner}/{repo}/collaborators/{login}`
   answers 204). Public read alone is not enough, so a person outside the
   organization cannot attach to its installation;
3. stores a connection whose site is the installation (`installation:<id>`)
   and whose sealed "credentials" are only `{ kind: "github_app",
   installation_id, login }`, with `auth_kind` `github_app`.

One connection covers the installation. Each room filter then names the
repositories to import.

**Every read checks two things**, before any issue is read:

1. The repository is in the connection's installation. A repository of another
   installation, or one the App does not hold, is refused without a request to
   GitHub.
2. The connection's GitHub login can read the repository
   (`GET /repos/{owner}/{repo}/collaborators/{login}/permission` is not `none`).
   The answer is kept for 5 minutes (a refusal for 1 minute). The answer must
   be about the GitHub id that connected, so a renamed login that someone else
   takes later reads nothing.

"Not installed", "cannot read" and any GitHub error during the connect checks
(for example the App lacks Issues: read) give the same 403 text; the real reason
goes to the server log only. They give the same text, so the answer never tells
whether a private repository exists. Test connection and the room filter test
are rate limited for GitHub Issues (they spend the organization's App budget).

The token for each read is minted for the installation with
`repositories: [<that repository>]` and `permissions: { issues: read,
metadata: read }`, so GitHub itself limits it to one repository and to reading.
Every token names exactly one repository; no token reaches the whole
installation. Test connection lists open issues assigned to you in the
repository you connected with. A lookup of your GitHub id, when one is needed,
uses a metadata-only token for that repository.

**States.** GitHub has open and closed issues. The raw status adds whether an
open issue has an assignee, so the status map can tell the two apart. Labels
are never states.

| Raw status | Default state |
|---|---|
| `Open` | To do |
| `Open (assigned)` | In progress |
| `Closed` | Done |

**Sync.** The first poll of a filter imports open issues; later polls read every
issue updated since the last poll, closed issues included. Pull requests are
not issues and are skipped.

**Webhooks.** The App already receives `issues` events at `/webhooks/github`.
Each event goes to the same path as a Jira or Linear webhook
(`TrackerSync.handleWebhook`) for every active GitHub Issues connection on that
installation: the event only names the issue, and sync reads it again through
the checks above. There is no per-connection webhook to set up. Anyone can open
an issue on a public repository, so an event for an issue LetAgents does not
hold yet asks for an early poll only of the filters that name its repository,
and at most once per half poll interval.

**Not yet.** Rules do not write to GitHub Issues: the rule routes refuse a rule
on a GitHub Issues connection, and the provider's transition and comment calls
refuse. The workflow effect journal still accepts Jira and Linear only.

**Server setup.** The GitHub App needs the **Issues: read** repository
permission (and **Metadata: read**, which every App has). Without Issues read,
connecting answers that the App cannot read issues. A server without a GitHub
App does not offer GitHub Issues (`providers.github.github_app` is false).

### Tests

```bash
node --import tsx --test src/api/__tests__/connector-crypto.test.ts src/api/__tests__/connector-providers.test.ts src/api/__tests__/github-issues-provider.test.ts src/api/__tests__/connector-routes.test.ts src/api/__tests__/tracker-effect-broker.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/tracker-connections-db.test.ts
```

Provider tests answer from fixtures in `src/api/__tests__/fixtures/connectors`
and fail on any request they do not expect, so CI makes no live tracker call.

## Rules (PR event moves the ticket)

A rule belongs to one connection. It names a repo event (the trigger) and one to five tracker actions. When a
pull request, review or check matches, LetAgents moves the ticket, comments on it, or both. A rule is an approval
the connection's owner gives in advance: nobody touches the tracker by hand, and every write still goes through the
workflow effect journal.

### Write a rule

Open Settings, Connectors, Trackers, then the connection's **Rules** section, and press **Add rule**.

1. Give the rule a name.
2. Choose the rooms: every room that imports with this connection, or one of them.
3. Under **When**, choose the event and the action, then any of the optional fields below.
4. Under **Then**, add a status change, a comment, or both.
5. Press **Save rule**.

| Trigger field | Events | Matches when |
|---|---|---|
| `event` | all | `pull_request`, `pull_request_review` or `check_run`. |
| `action` | all | The webhook action: `opened`, `reopened`, `ready_for_review`, `converted_to_draft`, `synchronize`, `closed`; `submitted`, `dismissed`; `completed`. |
| `merged` | `pull_request` `closed` | The pull request merged (`true`) or closed without a merge (`false`). |
| `draft` | `pull_request` | The pull request is a draft (`true`) or not (`false`). |
| `baseBranch` | `pull_request`, `pull_request_review` | The base branch is exactly this name. |
| `reviewState` | `pull_request_review` | `approved`, `changes_requested`, `commented` or `dismissed`. |
| `approvalsAtLeast` | `pull_request_review` | At least this many reviewers' latest review approves (comment-only reviews do not count). |
| `conclusion` | `check_run` | `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `stale`. |

A field that is not set matches anything. A field that the event cannot know (for example a base branch on a check
run) is refused when you save. The server validates the whole rule strictly: unknown fields, wrong types, more than
one status change, and unknown template variables are refused with a message.

Example: "PR opened, not draft: In Review and a comment".

```json
{
  "name": "Opened: In Review",
  "room_id": null,
  "trigger": { "event": "pull_request", "action": "opened", "draft": false },
  "actions": [
    { "kind": "transition", "toStatus": "In Review" },
    { "kind": "comment", "template": "PR {{pr_number}} by {{author}}: {{pr_url}}" }
  ]
}
```

A `transition` names the tracker's status by name (`In Review`), not the board column. The provider resolves the
name to a transition at run time, as for any tracker write. A `comment` template may use `{{pr_url}}`,
`{{pr_number}}`, `{{pr_title}}`, `{{author}}`, `{{branch}}`, `{{base_branch}}`, `{{repo}}` and `{{reviewer}}`.

### When a rule runs

1. A webhook for a pull request, review or check reaches the room-event projection.
2. The projection resolves the event to a card and accepts the link. The rule engine runs only when the card has an
   `external_ref` and the link is confirmed: the resolver matched the pull request or review by the ticket key (in
   the branch, title or body, or a pull request the key linked before), or the check ran for a pull request that
   the key linked to the card. A work lease, a `pr_url` set by hand, or another artifact is not enough. A card that
   a lock or another branch's lease protects runs no rule. A Jev link counts only after a person accepted it
   (`linked_by: "jev_confirmed"`); a Jev suggestion never fires a rule.
3. The engine finds the room's enabled filter for the card's tracker. The filter's author must own the connection,
   and the connection must be active. A room without such a filter runs nothing more (invariant 1).
4. The engine loads the connection's enabled rules for the room (rules for every room, and rules for this room).
   With no rule, it stops.
5. The card must be bound to the ticket by sync: its `external_item_id` names this connection's cached item for the
   card's key. Sync binds a card only in a room whose filter matched the ticket. So a key that a room member or an
   agent typed onto a card cannot aim the owner's rules at another ticket the owner's credentials can reach.
6. The pure matcher (`src/api/connectors/rules/matcher.ts`) returns every rule that matches, oldest first.
7. For each match the engine records a `tracker_rule_runs` row, unique per rule, webhook delivery and ticket. When
   the same delivery reaches a second room for the same ticket, that room finds the row and writes nothing: one
   write per event. A rule that matched but will not write gets a `skipped` row with a reason, shown in the audit:
   `untrusted_actor` (see "Who can fire a rule"), `owner_not_admin` (the filter's author is no longer an admin of
   the room), or `debounced` (the rule already ran for this ticket, event type and action in the last 10 minutes,
   so a burst of failing checks or a close-and-reopen loop writes once). One skipped row per reason is kept in
   that window. Claims for one rule and ticket take an advisory lock, so deliveries that arrive together cannot all
   pass these checks.
8. Before the webhook answers, the engine reserves the journal row for the first action, with the idempotency key
   `${rule.id}:${deliveryId}:${external_ref}:${action.index}`. A crash after this point leaves a pending row that
   the journal sweep reconciles, not a lost write.
9. After the webhook answers, the broker runs that write. Each next action is reserved and run only after the one
   before it succeeded, so no action runs without the ones before it. When a write failed but may be retried
   (for example the tracker answered 503), or its outcome is unknown, the run waits: the journal sweep retries or
   checks the write, and the rule run sweep that follows it (`advancePendingRuns`, every liveness tick) continues
   the run once it succeeded. A write with no attempts left, or one held for a person, ends the run; later actions
   are never reserved. The sweep also starts a run that has no journal row yet (the process stopped right after
   the claim). Each tick takes at most 10 pending runs, least recently visited first, and marks them visited, so
   runs that wait on a slow write never starve a ready one. It runs 3 at a time and holds the liveness tick for
   at most 20 seconds; writes still running then go on in the background and are not taken again until they
   finish. A run still pending after 7 days ends as `error` with the reason `stalled`, shown in the audit.
10. The run's outcome is `succeeded`, `failed`, `quarantined`, `error` (the connection was removed or changed),
   `skipped`, or `pending`. While a run is pending, the audit shows its current journal row, so a write the sweep is
   still retrying reads `failed` until it lands. The audit shows a fixed sentence for each reason; the provider's
   error text stays in the journal row, which only the server reads.

A redelivered webhook is a duplicate to the projection and reaches no rule. A delivery the route retries after a
failure reaches the rules again: the run row and the journal give back the earlier rows, the run continues where
it stands, and nothing new is reserved for a write that succeeded. A retry uses the actions the first attempt
planned, so a rule edited in between does not change them.

A comment interrupted by a crash before the tracker answered stays ambiguous in the journal (shown as pending): the
journal never sends a comment twice.

**No loops (invariant 4).** Rules fire on repo events only. Tracker sync writes `tracker_ticket` events tagged
`metadata.source = "tracker_sync"`; the engine refuses any event that `isTrackerSyncEvent` flags before the
matcher runs, and those events never go through the repo-event projection. So a transition that a rule made, and
that sync later reads back, cannot start a rule.

Stored merge replays and the unapplied-merge repair do not run rules: only a live webhook does. A merge that the
repair applies late therefore does not move the ticket (a known gap; the ticket can be moved by hand).

### Who can fire a rule

Anyone can open a pull request on a public repository and put a ticket key in its title or branch. So a rule fires
only for events from people with access to the repository, by GitHub's `author_association`:

| Event | Fires when |
|---|---|
| `pull_request` | The author is `OWNER`, `MEMBER` or `COLLABORATOR`, or the pull request merged (a merge needs write access). |
| `pull_request_review` | The reviewer is `OWNER`, `MEMBER` or `COLLABORATOR`. |
| `check_run` | The check ran for a pull request from a branch in the repository itself (GitHub lists none for a fork's branch). |

`approvalsAtLeast` counts only reviewers with that access, across the event's room and the card's room. Reviews
stored before this change carry no association and do not count.

### Comment text

The template is the owner's text and is kept as written. Every variable comes from GitHub, so each value is added as
plain text: line breaks, control characters and bidi overrides become spaces, and a value is cut at 300
characters. For Linear,
which renders Markdown, the value's Markdown characters are escaped and an `@` cannot mention anyone. For Jira, the
comment is sent as plain text nodes. `{{pr_url}}` is added only when it is exactly
`https://github.com/<the event's repository>/pull/<number>`; otherwise it is empty. A value cannot add a
placeholder: the template is filled in one pass.

### History and rollback

Each save is a new version; the earlier ones stay in `tracker_rule_versions`. **History** lists them, and **Roll back
to this** saves an old version's content as the newest version, after the same validation as any save. Turning a
rule on or off is not a new version. Deleting a rule keeps its runs in the audit (the run keeps the rule's name).

### Audit

Each run shows in the board's governance panel, Audit section, as `Rule "<name>" ran` with the event, the card and
its ticket, and the outcome. The journal row behind each write is in `workflow_effects` (`effect_ids` on the run).

### Who may write rules

Rules write to the tracker with the connection's credentials, so only the connection's owner, signed in to the
desktop app, may list, create, change, switch, roll back or delete them. The routes use the same gate as the
connection routes: owner tokens (what agents carry) are refused. Another account's connection or rule answers
`404`. A rule limited to one room must name a room that already imports with the connection.

### Rule drafting

**Draft from a sentence** in the rule editor turns a plain sentence into a rule with Jev (see
[Draft a rule from a sentence](#draft-a-rule-from-a-sentence)). The person still presses Save, and the draft goes
through the same validation as a typed rule.

### HTTP routes

All under the desktop app's session bearer, for a connection the account owns.

| Route | Purpose |
|---|---|
| `GET /account/connectors/:id/rules` | The rules and the rooms that import with the connection. |
| `POST /account/connectors/:id/rules` | Create a rule (at most 50 per connection, counted under a lock). |
| `PUT /account/connectors/:id/rules/:ruleId` | Save a new version. |
| `POST /account/connectors/:id/rules/:ruleId/enabled` | `{ "enabled": true }` or `false`. |
| `GET /account/connectors/:id/rules/:ruleId/versions` | Version history, newest first. |
| `POST /account/connectors/:id/rules/:ruleId/rollback` | `{ "version": 2 }`: that content becomes the newest version. |
| `DELETE /account/connectors/:id/rules/:ruleId` | Delete the rule. |
| `POST /account/connectors/:id/rules/draft` | `{ "sentence": "..." }`: a drafted rule for the editor, never saved (PR6). |

### Tables

Migration `0123_tracker_rules`: `tracker_rules`, `tracker_rule_versions` (unique per rule and version), and
`tracker_rule_runs` (unique per rule, delivery and ticket; indexed by room and time, by rule, ticket and time for
the debounce, and by update time for pending runs).

### Tests

- `src/api/__tests__/tracker-rules.test.ts`: matcher table tests for every trigger field, strict validation,
  template escaping, and the engine's idempotency keys.
- `src/api/__tests__/tracker-rules-db.test.ts` (needs `TEST_DB_URL`): a PR opened from `HT-1234-x` with the rule
  above reserves two effects and calls the tracker once for each; a redelivery and a retried delivery reserve
  nothing; a disabled or non-matching rule never fires; a `tracker_ticket` event never triggers a rule; two rooms
  write once; a filter its owner did not set writes nothing; an outside author (recorded as skipped) and an unbound
  card write nothing; the debounce; a transition refused once is retried by the sweep and the comment then posts;
  a transition refused until no attempts are left ends the run without the comment; a `pr_url` set by hand with a
  work lease runs no rule; an owner who lost room admin is skipped; pending runs rotate so 51 waiting runs do not
  starve a ready one; a run pending for 8 days ends as stalled; versions and rollback.
- `src/api/__tests__/tracker-rule-routes.test.ts`: owner-only access, versions, rollback, strict validation.
- `apps/desktop/renderer/__tests__/settings-connector-rules.test.ts`: the editor and the audit text.

## Remote MCP endpoint

LetAgents serves its MCP tools over streamable HTTP at `https://letagents.chat/mcp`. A Claude app chat can then
join a room as a worker with no local `npx` process. This matters on managed devices that allow only remote
connectors.

**Authentication.** Two credentials open `/mcp`, both sent as `Authorization: Bearer <token>`:

1. An OAuth access token. LetAgents is the OAuth 2.1 authorization server for its own MCP endpoint (MCP
   specification revision 2026-07-28, "Authorization"). A client such as the Claude app needs only the URL: it reads
   the metadata, registers itself, sends the person to sign in with GitHub and approve, and receives tokens.
2. A LetAgents owner token (the `LETAGENTS_TOKEN` minted by GitHub device flow), for clients without OAuth.

Other credentials (browser cookies, desktop app sessions, worker bearers, host grants) get `401`, and a browser
`Origin` outside the API's allow list gets `403`. Nothing is stored before auth passes. A request without a token, or
with an expired or revoked one, gets `401` with
`WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="mcp"`
(plus `error="invalid_token"` when a token was sent).

**OAuth endpoints** (code in `src/api/routes/mcp/oauth.ts`, tables from migration 0126):

| Path | What it does |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` (and the root form) | RFC 9728 metadata: resource `<base>/mcp`, authorization server `<base>`, scope `mcp`. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. PKCE `S256` only, `iss` in responses (RFC 9207), no client ID metadata documents yet. |
| `POST /oauth/register` | RFC 7591 dynamic registration. Redirect URIs must be `https`, or `http` on `localhost`, `127.0.0.1` or `[::1]`. Public clients (`none`) and secret clients (`client_secret_basic`, `client_secret_post`). 30 per IP per hour and 1000 per hour in total (`LETAGENTS_MCP_OAUTH_REGISTRATIONS_PER_IP_HOUR`, `LETAGENTS_MCP_OAUTH_REGISTRATIONS_PER_HOUR`). A client that nobody approves within a day is deleted. |
| `GET /oauth/authorize` | Checks the client and the exact redirect URI before it redirects anywhere, then requires `response_type=code` and PKCE `S256`. A `resource` other than `<base>/mcp` gets `invalid_target`. A signed-out person goes through the GitHub sign-in and comes back. A signed-in person sees a consent page that names the app, the redirect host and the account. |
| `POST /oauth/authorize/decision` | The consent page's buttons. The form carries a one-time consent token bound to the account; a cross-site `Origin` or `Sec-Fetch-Site` gets `403`. Approve redirects with `code`, `state` and `iss`; cancel with `error=access_denied`. |
| `POST /oauth/token` | `authorization_code` (code once, 5 minutes, verifier, same redirect URI and client) and `refresh_token`. Access tokens last 1 hour, refresh tokens 30 days. Each refresh rotates the refresh token; a spent refresh token used again revokes the grant. Every registered client may refresh, whatever `grant_types` it asked for: registration answers with `authorization_code` and `refresh_token` (RFC 7591 section 3.2.1), because access tokens last only 1 hour. A code used again revokes the tokens it issued. |
| `POST /oauth/revoke` | RFC 7009. Either token of a grant revokes the whole grant and deletes its remote MCP sessions. |
| `GET` / `DELETE /account/mcp-connections` | Account settings (desktop app: Settings → Connectors → Remote sign-ins). Session sign-in only, not owner tokens. |

What an approval gives: the same powers as an owner token, on `/mcp` only. An OAuth access token on any other API
path gets the invalid-bearer `401`; inside a remote MCP session, the tool calls act as the account's owner token, and
each one re-checks that the grant is still live. The GitHub token for private-room checks is the account's newest one
(from its owner tokens or browser sessions); the grant does not store one.

Storage: codes, consent tokens, client secrets, access and refresh tokens are stored only as SHA-256. Each token
carries the grant's secret (`lmcp_at.<grant secret>.<random>`); remote MCP sessions bind to the grant secret, so a
session continues after the hourly access token refresh, and the session state key is derived from it as it is from
an owner token. A token is accepted only when the stored hash of the whole token matches a live row.

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

**Sessions.** The session id is bound to the account and the exact owner token (or OAuth grant) that opened it; any
other credential gets `404` and must initialize its own session. `DELETE` removes the session. There is no server-initiated stream (`GET` gets
`405`); every reply travels on its `POST`.

**Tools.** The remote tool list is an explicit allow list (`REMOTE_ALLOWED_TOOLS` in
`src/mcp/server/remote-tool-surface.ts`). Excluded, with reasons in the same file: workspace capture, `check_repo`,
`check_repo_visibility`, `initialize_repo`, the device-auth and onboarding tools,
`resume_room_session` and the rental provider tools. `cwd` inputs are removed. A remote agent registers its worker with `register_agent_session` before it writes, as an
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
elements and object keys. Once a minute, sessions that are idle or whose owner token or OAuth grant was revoked are deleted. A
client whose session is gone gets `404` and initializes a new one; the agent then joins its room and registers its
worker again. Limits are per account, so people who share one token share them.

**Proxy note.** `wait_for_messages` holds one streamed HTTP response open for up to `LETAGENTS_POLL_MAX_MS`. The
reverse proxy in front of the API must forward `/mcp` with response buffering off, no gzip on `text/event-stream`, and
a read timeout at or above `LETAGENTS_POLL_MAX_MS`. It must also forward `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server` and `/oauth/` to the API. The issuer is `LETAGENTS_BASE_URL` (then
`PUBLIC_API_URL`, then `https://letagents.chat`); it must be the public https URL that clients reach.

Setup steps for the Claude app are in `AGENTS.md`, section "Remote connector (Claude app)".

## Jev decides the link and the exceptions

Jev is the choice model LetAgents already uses for conversation routing and command review. It answers bounded
questions: it picks one of the options LetAgents names and gives probabilities, never free text. PR6 uses it in four
places. Each needs the connection's **Use Jev with this connection** switch; with the switch off, LetAgents makes no
Jev call and sends nothing.

**Jev never writes on its own.** A Jev link lands as a suggestion on the card or as a board request that a person
decides. A timeout (10 s), an error, or an answer that is not exactly one of the options means "do nothing".

### Link a pull request that names no ticket

1. A pull request is opened, reopened, made ready for review, or gets a new push (`synchronize`), and it reaches no
   card: no URL, lease or ticket key matches. Tracker sync events never ask.
2. The room imports tickets through a filter whose connection has the switch on, is active, and belongs to the
   person who set the filter. Every such filter counts (a room has at most one per tracker). A room with no filter makes no query (the room's tracker scope is cached for 30 s).
3. The author has access to the repository (`OWNER`, `MEMBER` or `COLLABORATOR`), and is the GitHub user of a
   LetAgents account with its own active connection to the same tracker site. The match uses the immutable GitHub
   user id when the webhook carries it, so a renamed login cannot map to someone else. That connection's tracker user
   is the author's tracker user.
4. The candidates are the open tickets that the room's filter imported (sync bound each to a card in this room through
   the connection), assigned to the author's tracker user, on unfinished cards, newest change first, at most 20.
   A ticket outside the room's filter has no card bound here, so it is never a candidate. No candidate means no
   question.
5. LetAgents records the question first, in one transaction with its limits: one per pull request head SHA, one at a
   time per pull request (an `opened` and a `synchronize` seconds apart ask once), at most 5 per pull request and 30
   per room in an hour, and none again for a pull request a person rejected in this room.
6. Jev gets the pull request title, the start of its description (2,000 characters), up to 20 commit subjects, and
   the candidates' keys and titles. Text that looks like a secret is replaced, and control and bidi characters are
   removed. The state marks this text as untrusted: evidence to classify, never instructions.
7. The answer is one of `ticket_1` … `ticket_20` or `none`, with Jev's probability.

| Answer | What happens |
|---|---|
| A ticket, probability 0.8 or more | The pull request is attached to the card with `linked_by: "jev_suggested"`. Each rule that would have fired for this event becomes a board request "Move HT-1234 to In Review?". The room gets one status message that points to the requests. With no such rule, the suggestion only. |
| A ticket, 0.4 to 0.8 | The suggestion only. The card's details show it under **Suggested by Jev** with **Accept** and **Reject**. |
| `none`, below 0.4, no probability, a timeout, an invalid answer | Nothing. The question row records the outcome. |

A card that a lock holds, or that changed while Jev answered, is left alone. A pull request already on the card keeps
its earlier link, and a pull request that another card already shows is never attached to a second card. A new
suggestion supersedes the pull request's older requests.

### Decide a Jev link

Only a room admin signed in to the LetAgents app decides a Jev link. An agent's owner token, a worker session and
the Board Manager are refused (`jev_link_person_required`), and the escalation sweep never approves one.

- **Approve a request**: the link becomes `jev_confirmed`, and the rule's planned writes run once through the PR5
  path (a `tracker_rule_runs` row, then each journal row after the one before succeeded). The run's delivery is
  `jev:<request id>`, so a retried approval writes nothing new. The run is refused when the rule changed or was
  turned off, the filter or connection changed, the card is no longer bound to the ticket, or the owner lost room
  admin since the request was made.
- **A request that no longer fits** is refused before anything is recorded, and marked superseded with the reason:
  the pull request left the card, Jev made a newer suggestion for it, or the pull request is no longer in the state
  the planned event left it in (for example an "opened" plan after the merge, which would move the ticket back).
  Nothing is written.
- **Deny a request**: while the link is a suggestion, it is removed from the card and the link's other requests
  are withdrawn. A link a person already accepted stays; only that write is refused.
- **Accept** on the card confirms the link, writes nothing to the tracker, and supersedes the pending requests:
  later events run the rules themselves.
- **Reject** on the card removes the pull request and withdraws its requests. Jev is not asked again for that pull
  request in that room.

After a person accepts once, later events for the pull request run the PR5 automatic path, like a key link.
A mark belongs to the pull request it was set for: a client edit that changes the artifact's kind or number drops it,
and a check run counts only for the number in the marked URL.
A suggestion nobody accepted never fires a rule, and it is handled as quietly as a key link: no lease check and no
"ignored" notice.

### A pull request closed without a merge

When a pull request that a ticket key or an accepted Jev link put on a card closes without a merge, Jev answers one
question: **abandoned**, **superseded** or **moved**. With probability 0.5 or more, LetAgents posts a proposal in the
room, for example: "Pull request #91 for HT-1234 closed without a merge. Jev reads it as superseded by another pull
request. Proposal: check that the new pull request names HT-1234, so it attaches to this card. LetAgents changed
nothing in Jira." The text is fixed per answer; nothing that the pull request or Jev wrote is posted. Only a pull
request from an author with access to the repository is asked about (a key in a fork's pull request links it, but its
close asks nothing). One question per closed pull request head, at most 3 per pull request and 30 per room in an hour.

### Ask Jev who a card waits on

In My work, a card whose ticket's connection has Jev on, and whose room imports through that connection's filter
set by its owner, shows **Ask Jev who this waits on**. Only a room in your room list that you may read is asked about. Jev reads the card's
title, key and states and up to 6 recent room messages that name the ticket (sender kind and text), and answers
**waits on a person**, **waits on an agent**, or **nothing waits**. The answer is cached per card and newest message,
so asking again before anyone writes about the card costs no call, and a connection gets at most 300 calls an hour.
It is advice: nothing changes.

### Draft a rule from a sentence

In the rule editor, **Draft from a sentence** sends the sentence and the connection's status names to Jev as Choice
questions (event, action, merged, draft, review state, check result, target status, comment or not). The server
builds the rule from the answers and validates it exactly as a typed rule. The editor fills in; nothing is saved until
the person presses Save. A sentence Jev is unsure about gives an error that asks to write the rule by hand.

### Metrics

Every question is a `tracker_jev_questions` row with its outcome and latency. Settings → Diagnostics shows, for the
account's connections over the last 7 days, the count, the outcomes, and the average and 95th percentile latency of
each kind of question. The server logs one line per question (`[jev tracker] …`) with the outcome and latency, never
the text. Rows older than 90 days are swept hourly, except a link a person rejected, which keeps Jev from asking
about that pull request again.

### HTTP routes

| Route | Purpose |
|---|---|
| `POST /rooms/:room/board-intents/:id/approve` and `/deny` | A `tracker_jev_link` request: a room admin in the app only. |
| `POST /rooms/:room/tasks/:task/jev-link/accept` and `/reject` | `{ "pr_url": "..." }`: the card's suggestion. A room admin in the app. |
| `POST /account/my-work/needs-me` | `{ "room_id", "task_id" }`: Jev's reading of who the card waits on. |
| `POST /account/connectors/:id/rules/draft` | `{ "sentence" }`: a drafted rule; the connection's owner, switch on. |
| `GET /account/tracker-jev-metrics` | Count, outcomes and latency per kind of question, last 7 days. |

### Tables

Migration `0125_tracker_jev_questions`: `tracker_jev_questions` (unique per kind, room, subject and revision: the
pull request and head SHA, the closed pull request, the card and newest message), and `tracker_jev_link` added to the
board intent types.

### Tests

```bash
node --import tsx --test src/api/__tests__/tracker-jev.test.ts src/api/__tests__/tracker-jev-routes.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/tracker-jev-db.test.ts
```

- `tracker-jev.test.ts`: a timeout and invalid JSON give no action; answers outside the options are refused; the
  question holds at most 20 tickets, a cut description and no secret; the switch off makes no call; never for a sync
  event or an outside author; high confidence makes a suggestion and requests but no effect; low confidence makes a
  suggestion only; approval runs the PR5 path once and confirms the link; denial of a suggestion detaches it; a
  `jev_suggested` link never fires a rule; the closed pull request proposal; the needs-me cache; rule drafts.
- `tracker-jev-db.test.ts` (no live model call): the candidate set is capped at 20 and leaves out tickets outside
  the room's filter, done tickets, other assignees and other rooms; a pull request with no key gets a suggestion and
  one request and no journal row; a push while it is a suggestion fires no rule; approval writes once and a retry
  writes nothing; after approval a push runs the rule automatically; denial detaches and Jev is not asked again; low
  confidence; the switch off; the metrics.
- `tracker-jev-routes.test.ts`: only a person in the app decides a link; the draft route needs the switch and never
  saves.
