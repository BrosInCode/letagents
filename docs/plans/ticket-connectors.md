# Ticket connectors: one card answers "what is up with this ticket"

Status: plan, 2026-10-21. PR1 merged (#1711, migration `0117_task_external_refs`). PR2 merged (#1712, migration `0118_tracker_connections`). PR3 in review (migration `0119_room_tracker_filters`). Base branch for all work: `staging` (ada668683 at time of writing).
Owner: EmmyMay. Executing agents: one Opus session per PR set, reviewed by a different agent before merge.

## Goal

A LetAgents card can carry a ticket key from an external tracker (Jira, Linear, later GitHub Issues).
Everything that mentions that key attaches to the card without copying: the ticket's state from the
tracker, the pull request from GitHub, and the agent or Claude app session working on it in the room.
A new account-level "My work" page lists the tickets assigned to the signed-in person across rooms with
three columns: ticket state, agent work, PR. PR events can move the ticket through team-written rules.
Jev links a PR to a ticket when the branch carries no key.

## Non-goals

- No port of GitTicket code. Only the idea: PR event + team rule = ticket transition.
- No Slack or Teams notifications. The room is the notification.
- No change to GitHub's role as identity and Git Room source.
- No second board. Imported and native cards live on the same board.

## Invariants every PR must keep

1. **Zero-connector rooms are unchanged.** A room with no connection sees no chips, no ticket state,
   no new filters, no new agent behaviour. Every new code path checks for a connection first.
2. **Two states, two owners.** `ticket_state` (todo, in_progress, in_review, done) is owned by the tracker and
   LetAgents never writes it directly. The existing task `status` is the work state and stays owned by LetAgents.
3. **Every external write goes through `workflow_effects`.** Reserve a journal row with an idempotency key
   before any tracker call. Reuse the broker in `src/api/workflow-effects/broker.ts`; add new effect kinds,
   do not bypass it. See `docs/workflow-effect-journal.md`.
4. **Rules fire on repo events only.** Never on tracker sync events, so a transition cannot trigger itself.
5. **A Jev decision never writes on its own.** A Jev-made link lands as a suggestion or a board intent.
   A timeout or invalid answer means "do nothing", never a default write.
6. **Secrets stay encrypted at rest** with a server-side key from env. Never log tokens. Redaction hints as in
   `src/api/rental/secret-firewall-patterns.ts`.
7. **Per-connection consent for Jev.** Ticket titles and PR text leave the server for each Jev call.
   The connection setting defaults to off and discloses this, like `docs/jev-routing.md`.

## Vocabulary

| Term | Meaning |
|---|---|
| connection | One account's authorised link to one tracker (`jira`, `linear`). Holds credentials and a status map. |
| external item | One ticket cached from a tracker. |
| external ref | The string on a card that names its ticket, e.g. `jira:HT-1234`. |
| key detector | Per-provider regex that finds ticket keys in branch names, PR titles and bodies, and room messages. |
| room filter | Per room, per connection: which tickets to import (JQL for Jira, team/project for Linear). |
| rule | Per connection: a repo event trigger and the tracker actions it causes. |
| status map | Per connection: tracker status name -> generic `ticket_state`. User editable. |

## Build order and dependencies

```
PR1 external ref + key detectors ──┬── PR3 sync + room filters + board states ── PR4 My work + card detail
                                   │                                             │
PR2 connections + providers ───────┘── PR5 rules engine ── PR6 Jev link + exceptions
PR7 remote MCP endpoint (independent)
```

PR1 and PR2 can run in parallel. PR3 needs both. PR4 and PR5 need PR3. PR6 needs PR5. PR7 is independent.

---

## PR1: External ref on cards and key detectors

**Goal.** A card can name a ticket. PRs, branches and messages that mention the key attach to the card.
No tracker API in this PR. A human can type `HT-1234` into a card and get the PR and the thread in one place.

**Server**
- Migration (next free number after `drizzle/0116_room_history_summary.sql` on staging): add to `tasks`
  (`src/api/db/schema/tasks.ts`) `external_ref text null`, `ticket_state text null`, `external_item_id text null`.
  Unique partial index on `(room_id, external_ref) where external_ref is not null`.
- `src/api/connectors/key-detectors.ts`: `detectTicketKeys(provider, text): string[]`. Jira pattern
  `[A-Z][A-Z0-9]+-\d+`, Linear pattern `[A-Z][A-Z0-9]*-\d+` scoped by known team keys when a connection exists,
  else no match. Export `detectKeysInBranch`, `detectKeysInPullRequest`, `detectKeysInMessage`.
- Extend task artifact matching in `src/api/repo-workflow/task-artifacts.ts` and
  `src/api/github/room-event-projection/task-resolver.ts`: resolve a repo event to a task by key as well as by URL.
  Branch name, PR title and PR body are inputs. A key match attaches the PR artifact exactly as a URL match does today.
- Message linking: in the message write path, detect keys and record a `task_mentions` row (new table:
  room_id, task number, message_id, key) so the card can list threads. Keep the write cheap: one regex pass,
  only when the room has at least one card with an `external_ref` (invariant 1).
- MCP: `add_task` and `update_task` in `src/mcp/server/tools/tasks/mutation-tools.ts` accept `external_ref`.
  `get_board` returns `external_ref`, `ticket_state`. Board search in `board-tools.ts` matches on key.
- Agent protocol: the duplicate check before `add_task` includes the key. Update `AGENTS.md` task board etiquette.

**Desktop**
- `RoomBoardTaskCard.vue`: show the key as the card label when present. Provider chip shown only when
  `external_ref` is set.
- `RoomBoardTaskInspector.vue`: "Linked threads" list from `task_mentions`; "Link PR" manual action already
  exists via artifacts, keep it.
- `RoomBoardTaskEditor.vue`: optional external ref field.

**Tests**
- Detector unit tests: branch forms `feature/HT-12-x`, `HT-12`, `x-HT-12-y`, lowercase rejected, no false hits on
  words like `UTF-8`.
- Projection test: a PR opened from branch `HT-1234-proration` attaches to the card with `external_ref=jira:HT-1234`.
- Zero-connector test: a room with no external refs runs no detector on messages.

**Done when** a human sets `jira:HT-1234` on a card, opens a PR from branch `HT-1234-x`, and the card shows the
PR and the thread that mentions the key.

---

## PR2: Connections and work item providers

**Goal.** An account connects Jira or Linear once. The server can read tickets for that user.

**Server**
- Migration: `tracker_connections` (id, account_id, provider, display_name, auth_kind `oauth|api_token`,
  credentials_ciphertext, credentials_iv, tracker_user_id, tracker_user_label, status_map jsonb,
  jev_linking_enabled bool default false, status, created_at, updated_at).
  `external_items` (id, connection_id, provider, key, title, ticket_state, raw_status, assignee_id,
  assignee_label, url, payload jsonb, tracker_updated_at, synced_at). Unique `(connection_id, key)`.
- `src/api/connectors/crypto.ts`: AES-256-GCM with `LETAGENTS_CONNECTOR_SECRET_KEY` from env. Server refuses to
  start the connector routes without it. Rotation is out of scope; note it in the doc.
- `src/api/connectors/providers/types.ts`:
  ```ts
  interface WorkItemProvider {
    readonly name: "jira" | "linear";
    listItems(conn, filter, opts: { assigneeMe?: boolean; updatedSince?: string }): Promise<ExternalItem[]>;
    getItem(conn, key): Promise<ExternalItem | null>;
    listTransitions(conn, key): Promise<{ id: string; toStatus: string }[]>;
    transition(conn, key, toStatus, correlationKey): Promise<{ externalId: string }>;
    comment(conn, key, body, correlationKey): Promise<{ externalId: string; url?: string }>;
    verifyWebhook?(req): { ok: boolean; deliveryId: string };
    parseWebhook?(payload): ExternalItemChange[];
  }
  ```
- `providers/jira.ts`: Jira Cloud REST v3. Auth: OAuth 2.0 (3LO) for hosted accounts, email + API token for
  self-hosted deployments. Transition by target status name resolved through `/issue/{key}/transitions` at run time.
  Comments carry the `correlationKey` as a hidden marker so the journal can reconcile.
- `providers/linear.ts`: GraphQL. OAuth. Same interface.
- Default status maps: Jira `To Do -> todo`, `In Progress -> in_progress`, `In Review|Code Review -> in_review`,
  `Done|Closed -> done`. Linear by state type (`unstarted`, `started`, `completed`, `canceled -> done`).
  Unmapped statuses map to `in_progress` and are flagged in the connection settings for the user to fix.
- Routes under `src/api/routes/account/connectors/`: list, start OAuth, OAuth callback, save API token,
  test connection, update status map, delete. Owner-token only.
- Effect kinds: add `tracker_transition` and `tracker_comment` to `src/api/db/schema/effects.ts` and the broker,
  with provider lookup paths for reconciliation (list recent comments or the issue's changelog, find the marker).

**Desktop**
- New settings pane `settings/panes/SettingsConnectorsPane.vue` in `settings/navigation.ts`: list of connections,
  Add Jira, Add Linear, status map editor, Jev linking switch with the disclosure text, remove.

**Tests**
- Crypto round trip; start without key refuses routes.
- Provider tests against recorded fixtures (no live calls in CI).
- Broker tests for the two new effect kinds: success, failed retry, ambiguous reconciliation by marker.

**Done when** EmmyMay connects Jira in settings, the test button lists five tickets assigned to them, and
the status map shows their columns mapped.

---

## PR3: Sync, room filters, and the two states on the board

**Goal.** Tickets appear as cards in the right rooms and stay current.

**Server**
- Migration: `room_tracker_filters` (room_id, connection_id, filter text, enabled, last_synced_at).
- `src/api/connectors/sync.ts`: for each enabled filter, poll `listItems(updatedSince)` on a bounded interval
  (default 2 min, env `LETAGENTS_TRACKER_POLL_MS`), upsert `external_items`, then upsert cards:
  a new item creates a card with `external_ref`, `title`, `ticket_state`, work state `proposed`;
  an existing card gets `ticket_state` and title updated and nothing else.
  Webhooks (Jira, Linear) call the same upsert path, so poll and webhook never disagree.
- Auto import: when PR1's detector finds a key with no card in the room, and the room has a connection for that
  provider, fetch the item and create the card. This is how "tickets that concern this repo" fills itself in.
- Native card link: setting `external_ref` on an existing native card merges it with any imported card of the
  same key (keep the native card, move artifacts and mentions, delete the imported duplicate).
- Projection: ticket state changes post a quiet room event in the Events tab, not a chat message, through the
  existing gate in `src/api/github/room-event-projection/chat-event-gate.ts` pattern.

**Desktop**
- Room settings: filters section (pick connection, enter filter, test shows count).
- `RoomBoardKanban.vue` and `RoomBoardTaskCard.vue`: provider chip, ticket state pill next to the work state.
  `RoomBoardToolbar.vue`: filter all / tracker / native, shown only when the room has imported cards.
- `RoomBoardTaskInspector.vue`: Ticket section with raw status, assignee, link out.

**Tests**
- Poll and webhook deliver the same change: one upsert, no duplicate card.
- Merge of native and imported card keeps artifacts and mentions.
- A ticket moved to Done in the tracker updates `ticket_state` only; work state untouched.

**Done when** the `herotel/billing` room board shows the JQL filter's tickets with Jira chips and ticket states,
and an agent can claim one and move it to in_progress while the Jira state stays In Progress.

---

## PR4: My work page and card detail

**Goal.** One place for "what is up with my tickets".

**Server**
- Route `GET /account/my-work`: cards across rooms where the external item's assignee is the account's tracker
  user, or the native card is assigned to the account. Returns per card: key, title, room, provider,
  `ticket_state`, work state, assignee agent and last status, last thread activity, PR artifacts with
  review and check summary (reuse `src/web/src/components/room/task-merge-readiness` data shape on the server
  side if available, else compute from `room_shared_artifacts`).
- "Needs me" flag computed from existing signals only in this PR: review requested of me, a human request open
  on the card, ticket done while a PR is still open. Jev-based "needs me" is PR6.

**Desktop**
- Sidebar entry "My work" above Inbox and Messages in `sidebar/DesktopSidebar.vue`.
- `content/MyWorkView.vue`: table with four columns (Ticket, Ticket state, Agent work, PR), filters tracker,
  room, needs me. Row click opens the detail panel.
- `content/my-work/TicketDetailPanel.vue`: three columns Ticket | Agent work | PR with links out.
  Reuse `RoomBoardTaskInspector` pieces where they fit; do not fork them.
- Search: typing a key in room search opens the card.
- Zero-connector mode: the ticket state column is hidden and the page lists native cards assigned to me.

**Tests**
- Renderer tests with HOME on a scratch folder (see repo testing notes). Snapshot of the three-column panel.
- Route test: assignee mapping through the connection's `tracker_user_id`.

**Done when** EmmyMay opens My work and sees HT-1234 with ticket state In Review, Ada's last status, and PR #88's
review summary in one row.

---

## PR5: Rules engine (PR event moves the ticket)

**Goal.** Teams write rules; repo events move tickets without a human touching the tracker.

**Server**
- Migration: `tracker_rules` (id, connection_id, room_id null for all rooms, name, enabled, trigger jsonb,
  actions jsonb, version, created_by, created_at). `tracker_rule_versions` for rollback.
- Trigger shape: `{ event: "pull_request" | "pull_request_review" | "check_run", action, merged?, draft?,
  baseBranch?, reviewState?, approvalsAtLeast? }`. Actions: `transition { toStatus }`, `comment { template }`.
  Template variables `pr_url pr_number pr_title author branch base_branch repo reviewer`.
- `src/api/connectors/rules/matcher.ts`: pure function, all matching rules in order.
- Hook: after `room-event-projection` resolves a repo event to a card that has an `external_ref` from a key match
  or a confirmed link, run the matcher and reserve one `tracker_transition` or `tracker_comment` effect per action
  with idempotency key `${rule.id}:${deliveryId}:${action.index}`. Invariant 4: sync events never reach the matcher.
- Rule audit: each run writes a `tracker_rule_runs` row (rule, event, card, effect ids, outcome) shown in the
  board governance audit section.

**Desktop**
- Connector settings: Rules section with a list, enable switch, editor (trigger fields, actions), version history
  and rollback. Plain English draft button is PR6.

**Tests**
- Matcher table tests for every trigger field.
- End to end with fixtures: PR opened from `HT-1234-x` -> effect reserved -> provider called once ->
  webhook redelivery reserves nothing new.

**Done when** a rule "PR opened, not draft -> In Review + comment" moves HT-1234 in Jira within one poll interval
and the card's ticket state follows.

---

## PR6: Jev decides the link and the exceptions

**Goal.** The magic survives a branch without a key. Jev never writes.

**Server**
- `src/api/connectors/jev-link.ts`, modelled on `src/api/messages/jev-conversation-routing.ts` and the command
  review client: one bounded Choice question. Input: PR title, body (truncated), commit subjects, and the
  candidate set = open external items in the room's filters assigned to the PR author's mapped tracker user,
  capped at 20, plus the option `none`. Output: `{ key | none, confidence }`. 10 s timeout. On timeout or
  invalid answer: no action.
- Trigger: a PR event resolves to no card by key and the room has a connection with `jev_linking_enabled`.
- Outcomes:
  - high confidence: attach the PR to the card as artifact, and register a board intent
    (`src/api/db/coordination/board-intents.ts`) "Move {key} to {toStatus}?" for each rule that would have fired.
    Approval runs the effects; denial detaches the link.
  - low confidence: attach as `suggested` only, visible in the inspector with Accept / Reject.
  - After a human accepts once, the card holds the link and later events run the PR5 automatic path.
- Exceptions: PR closed without merge gets one Choice question (abandoned, superseded, moved) and posts a
  proposal in the room; no write.
- Rule drafting: `POST /connectors/:id/rules/draft` turns a sentence into a rule JSON for the editor; the human saves.
- "Needs me" refinement for My work: one Choice question per card on demand (waiting on human, waiting on agent,
  nothing), cached per last message id.
- Per-connection switch (PR2) gates every call. Metrics: count, latency, outcome, in the diagnostics pane.

**Tests**
- Timeout returns no action; invalid JSON returns no action.
- High confidence path creates an intent, never an effect, until approval.
- Candidate set is bounded and excludes items outside the room's filters.

**Done when** Kai opens PR #91 from `fix-proration-rounding`, the card HT-1234 shows the PR and one intent
"Move HT-1234 to In Review?", and after approval the ticket moves.

---

## PR7: Remote MCP endpoint (independent)

**Goal.** The Claude desktop app on a managed device joins a room as a worker over HTTP, with no local `npx`.

- Streamable HTTP MCP transport at `POST /mcp` on the API, authenticated with `LETAGENTS_TOKEN` as bearer,
  exposing the same tool set as the npm package's server (`src/mcp/server`) by sharing its registration code.
- Session state per connection; `wait_for_messages` honours `LETAGENTS_POLL_MAX_MS`.
- Doc in `AGENTS.md`: how to add LetAgents as a remote connector in the Claude app, and the enterprise admin note.

**Done when** a Claude app chat with the remote connector joins `herotel/billing`, posts a status mentioning
HT-1234, and that status appears in the card's Agent work column.

---

## Working agreement for executing agents

- Branch from `staging`, feature branch per PR, PRs target `staging`, squash merge, commit with the noreply identity.
- Never self-review. Ask another agent for review; security PRs (PR2, PR7) get a cross-model review.
- Run DB tests only on a scratch Postgres with a fresh, uniquely named database.
- Each PR adds its section to `docs/ticket-connectors.md` (user-facing doc, created in PR1) and keeps this plan's
  status line current.
- Post status in the room when claiming a PR, when tests pass, and when the PR is open.
