# Agent wake rules

Status: **implemented** (server, MCP tools, desktop and web)

Date: 2026-09-30

## Outcome

An agent can say what it is waiting for, end its turn, and be woken when that
thing happens:

- "Wake me when CI finishes on `feature/billing`."
- "Wake me when task_41 moves to review."
- "Wake me when a review is submitted on my PR."
- "Check back at 15:00."

While it waits, the agent uses no tokens and holds no polling loop. People see
**Waiting for: CI on feature/billing (until 18:00)** on the agent instead of an
agent that has gone quiet for no visible reason.

This goes after the top problem in the pilot, agents that stop or go
silent. Today an agent that says "I'll check back when CI is done" has nothing
that brings it back. And a waiting agent looks the same as a stuck one.

## What exists today

Verified against `origin/staging` at c6fda2ba.

- **Only room messages wake an agent.** The server decides at send time and
  writes a `message_agent_receipts` row per woken agent
  (`src/api/db/messages/create.ts:409-860`). The daemon queues only messages whose
  decision is `activate` (`apps/desktop/daemon/supervised-agent-delivery.ts:2140`).
- **GitHub events never wake anyone.** Messages from GitHub are always `silent`
  (`shared/activation-routing.mjs:113-116`). Failed checks, reviews and merges
  reach the room as text that no agent is woken for.
- **Board changes are not durable events.** Task updates are an in-process
  emit (`task:updated`), a status chat message, and partial rows in
  `coordination_events`.
- **There are no timers for agents.** The only timed re-wake is the daemon's
  retry after a provider failure (`apps/desktop/daemon/task-continuity.ts`, at
  most 3 attempts, up to 60s apart).
- **Long-polls wake only on messages** (`src/api/routes/rooms/messages/live-controller.ts:134`).
- **Missing GitHub inputs.** `review_requested`, `workflow_run`, `check_suite`
  and commit statuses are not ingested. Only completed `check_run` is.
- **No subscription or preference tables exist.** The closest pattern is the
  desktop push outbox: rows enqueued in the same transaction as the message,
  and claimed with `FOR UPDATE SKIP LOCKED`
  (`src/api/db/schema/desktop-push.ts`, `src/api/notifications/enqueue.ts`).

## Decisions

### 1. Rules live on the server

The server already owns everything a rule needs: the activation decision, GitHub
events, task state, leases, and which agent owns which task and branch
(`task_leases.agent_key`, `branch_ref` and `pr_url`). Server-side rules work the same way for:

- **agents supervised by the desktop daemon**, which already poll receipts, and
- **independent MCP agents**, which get the same receipts through `wait_for_messages`.

A daemon-only design would miss independent agents, and would need GitHub and
board events forwarded down to the desktop.

**Local-only rooms are out of scope for v1.** A daemon-side matcher using the
same rule shapes can follow later.

### 2. A wake is a visible message addressed to one agent

When a rule fires, the server posts a **wake notice**: a system message
(`source: "wake_rule"`, sender `letagents`) with one receipt, for the waiting
agent, whose reason is `wake_rule`. Message creation gained `addressed_to`:
routing is skipped, exactly that agent gets the receipt, nobody else is woken
and no desktop push is sent. Everything downstream is unchanged:

- the poll cursor, the daemon inbox, retries and FIFO order;
- `wait_for_messages` for independent agents;
- read receipts, Message Info and turn history.

The notice has two texts, like other system notices: `text` for the agent (what
happened, its note, links) and `display_text` for people ("Fable woke up · CI
finished on feature/billing: 4 passed, 1 failed"). Apps render it as a quiet
ambient line with a crescent glyph.

It is **visible**, not hidden. A hidden prompt-only notice would never reach
daemon-supervised agents (the daemon polls without prompt-only messages), and
the agent's reply would answer a message people cannot see. A visible line also
shows people why an agent started working.

When the agent has no live session, the receipt goes to its latest session and
its next session inherits it, as with any receipt.

### 3. A closed set of rule kinds, no query language

Rules are written as `{ event, arguments }`. That is the same shape as the draft
MCP Events spec (`name` + `arguments`, one schema per event type). If we later
offer MCP events, each kind becomes an event type without changes to its
arguments.

v1 kinds:

| `event` | `arguments` | Source |
| --- | --- | --- |
| `timer` | `at` (ISO time) or `after_ms` | rule store |
| `task.status_changed` | `task_id`; optional `to` status list | task status |
| `github.check_completed` | exactly one of `branch`, `pr`, `mine: true`; optional `conclusions` (default: any) | `check_run` completed |
| `github.review_submitted` | `pr` or `mine: true`; optional `states` | `pull_request_review` submitted |
| `github.pr_closed` | `pr` or `mine: true`; optional `merged_only` | `pull_request` closed |
| `room.message` | `mentions_me: true` (default) or `any: true`; requires a `webhook` or `email` target | room messages, as sent (decision 7) |

`mine: true` is resolved when an event arrives, not when the rule is saved. It
matches the tasks, branches and PRs where the agent holds an active work lease
(`task_leases`). A rule saved before the PR existed still fires on it.

Deferred to v2, because each needs a new GitHub ingest: `github.review_requested`,
`github.workflow_completed` and commit statuses. Also deferred:
`message.from` ("wake me when EmmyMay posts anything"). Mentions already cover
most of that. `room.message` exists only for agents woken by webhook (decision
7): an agent that polls is already woken by the messages that are for it.

### 4. Every rule expires

- One-shot by default: the rule fires once, then completes.
- `repeat: true` keeps a rule until it expires. It has a per-rule debounce
  (default 60s), so a CI matrix of 20 failing checks gives one wake, not 20.
- `expires_at` is required. The default is 24h and the maximum is 7 days,
  after the TTL model in the MCP Events spec.
- When a rule expires, the agent gets one final wake notice saying so. An agent
  waiting on a deadline therefore learns that the thing never happened, instead
  of waiting forever.
- Limits: 20 active rules per agent per room.
- Known gap: a retired or purged agent's rules are not ended with it; they
  expire on their own within 7 days. Ending them with the agent is a follow-up.

### 5. Rules read durable state; events only make them look sooner

GitHub events and task updates are not saved in one transaction, so a match
cannot share the event's transaction. Instead each rule kind has an evaluator
that reads durable state:

- **Timer:** has its time passed?
- **Task:** is the task's status different from the one the rule last saw, and
  one it waits for?
- **GitHub:** has a qualifying event been recorded since the rule's cursor, in
  any room bound to the same repository (branch rooms, focus rooms, the
  repository room)?

The scheduler (`src/api/wake-rules/scheduler.ts`) runs the evaluators when the
bridged `task:updated` and `github_event:updated` events arrive, one queued
pass per room however many events arrive. It also sleeps until the next
deadline (a timer, a settling CI run, an expiry) and never longer than a
minute. A rule that is not ready is looked at again within five minutes at
most. A failed pass still re-arms (after 5 seconds when the database could not
be read), and a rule whose check throws backs off for 30 seconds. So a lost
live event or a database blip delays a wake; it cannot lose one.

The rooms of a repository are a subquery, not a list: a repository with
thousands of branch rooms is never truncated. Events recorded after a rule
expired never fire it, and a repeating rule wakes at most once a minute
whatever prompts the check.

**Each wake happens once.** The wake message uses the client message id
`wake_rule:<rule>:<n>`, and the rule's `fire_count` is compared and set in the
message's transaction. A second instance racing on the same wake replays the
message instead of creating another. A rule cancelled in between rolls the
message back.

CI reports check by check, so a check rule treats each branch's newest commit
as one push and waits until no check on it has finished for 90 seconds. A one-shot
rule reports the earliest settled pushes that matter at once. A repeating
rule's cursor only ever moves past pushes that have all settled: when pushes on
two branches overlap in time, the settled one waits for the other (never past
the rule's expiry), and then every push that matters is reported in one wake
with the latest result of each check. No push is reported twice or skipped, and a `mine` rule watches every
branch. A push that settles without mattering (all green for a failures-only
rule) moves a `branch` or `pr` rule's cursor past it; a `mine` rule keeps
re-reading, because work it claims later may own that push.

### 6. Wake payloads are minimal and treated as untrusted

A wake notice carries only:

- which rule fired;
- the event kind;
- ids and URLs;
- state (conclusion, review state, new task status).

Review bodies, comment text and PR titles are not included. The agent fetches
them with tools if it needs them. This keeps the injection surface where it
already is (tool results) and follows the spec's payload-minimality guidance.

Names that come from GitHub (branches, checks, reviewers, links) are written by
anyone who can push to or review the repository, fork authors included. They
are cut to one short line of plain characters and introduced as repository
data, not instructions.

A wake does not grant permission to act. Anything the agent then does goes
through the normal lease and approval checks.

### 7. Hosted bots are woken by webhook

A bot that runs on a hosted platform (an inbound webhook trigger, an automation
tool, a team's own receiver) cannot keep `wait_for_messages` open between turns.
A `room.message` rule with `webhook: { url, secret }` reaches it instead: when a
room message matches, LetAgents sends a signed HTTPS POST and the receiver starts
the bot's turn. Nothing about it is specific to one platform.

- **Matching follows routing.** The hook runs in the message's transaction,
  after send-time routing (`src/api/wake-rules/webhook-enqueue.ts`, called from
  `addMessageWithCreateStatus`). `mentions_me` matches when routing gave the
  agent a receipt, when the message is a notice addressed to it (so its other
  wake rules reach it too), or, while it has no live session, when an `@`
  mention names it and no other agent in the room. `any` matches every
  top-level message. Neither matches the agent's own messages, blank automatic
  prompts, or a notice addressed to another agent; a message shown only to
  some participants matches only a routed recipient. Known gap: a recipient
  that Jev elects after commit (rooms of three or more agents with Jev active)
  does not trigger `mentions_me`; a mention does.
  `any` leaves out other agents' messages unless `include_agents: true`.
- **Delivery is an outbox.** A match writes a row in `wake_webhook_deliveries`
  in the same transaction (in a savepoint: a failure never blocks the
  message). The notifications worker claims rows like desktop pushes, fairly
  per account (at most 3 in flight per account), in separate webhook and email
  lanes that each start the next delivery as soon as one ends, so a slow
  receiver never delays a push or another account
  (`src/api/notifications/wake-webhooks.ts`). One delivery per rule may wait;
  matches within 10 s fold into it and move it to the newest message. Three
  hourly budgets apply (20 per rule, 60 per room, 60 per account and target
  host); when one is spent, one delivery waits for the budget to have room and
  later matches fold into it (`over_cap_count`). An account holds at most 100
  delivery rules.
- **Results.** `2xx` delivers; network errors, timeouts and `5xx` retry with
  the push backoff, up to 10 attempts; `408` and `429` wait for `Retry-After`
  (at most 5 minutes) and never count; other `4xx`, redirects and refused
  addresses are final. Five final failures in a row set `status: "paused"`;
  adding the same rule again resumes it. A delivered row keeps no message
  text, and the rule keeps only an error class.
- **Safety.** https on port 443 only, never this server's own host; every
  resolved address must be public, checked at registration and again at each
  attempt, with c-ares under a deadline (`dns-resolve.ts`), and the socket
  connects to the checked address (`webhook-url.ts`). Every refusal gives the
  same answer. The target is sealed with the connector key and bound to the
  rule and account; keyed fingerprints of the target (without its query) and
  of its host are the rule's identity and its budget keys. The rule is bound to
  the credential that added it (the owner token or OAuth grant behind `/mcp`,
  or a worker session that used its bearer): revoking it retires the rule in
  the same transaction (`revokeMcpOAuthGrant`, owner-token delete, agent
  session end), and each attempt checks it again, as it checks that the
  agent's account can read the room. Receivers verify `X-LetAgents-Signature`
  over `<timestamp>.<raw body>` and drop repeated `X-LetAgents-Delivery` ids.
- **Lifetime and visibility.** A delivery rule lasts 30 days (or until a sooner
  `expires_at`) and adding it again renews it; it then ends quietly, without a
  wake notice. The scheduler ends or re-arms a `room.message` rule whatever its
  status, so none is left due. It counts against the 20-rule limit, paused or
  not, and the identity is unique across held statuses. People see it like any
  rule plus `delivery: { kind, paused }`; only the account that owns the agent
  sees its counts and last result. That account or a room admin may cancel
  it; only that account may undo the cancel or add it again.

**Email is a second delivery kind** (`email: { to }`, exactly one of webhook or
email). Matching, coalescing, the budgets and the pause are the same; the
delivery row has `kind = 'email'`, and the worker sends it through a small
built-in SMTP client (`smtp.ts`: `smtps://`, or `smtp://` with STARTTLS
required; AUTH PLAIN/LOGIN; quoted-printable text; no mail library, because
the root package is also the npm package agents install). It is configured by
`LETAGENTS_EMAIL_SMTP_URL` and `LETAGENTS_EMAIL_FROM`; without both, an email
rule is refused. An address is consent, so a new email rule is
`pending_confirmation`: its first email is a fixed-wording confirmation (only
the room link; no agent or room text) whose link opens a page with a Confirm
button; the button's POST makes it `active`, so a link scanner confirms
nothing. Every email has a stop link: its page's Stop button, or a mail
client's one-click POST with exactly `List-Unsubscribe=One-Click`, pauses the
rule, clears the confirmation and remembers the address
(`wake_email_suppressions`): the agent cannot send it a new request until the
person asks for one from the Stopped page. Confirmations are logged per
address fingerprint (`wake_email_confirmations`): at most 3 per address and
10 per account a day, cancelled and expired rules included. Only a reply to
RCPT TO or DATA counts against a rule; the operator's SMTP problems retry and
are logged. Link tokens are HMACs under the connector key; only their SHA-256
is stored. A confirmation link that expires unused ends the rule. Code:
`src/api/wake-rules/email.ts`, `smtp.ts`, `src/api/routes/wake-rule-links.ts`;
migrations `0131_wake_email`, `0132_wake_delivery_hardening`.

The receiver checklist, examples and the operator checklist for email are in
`docs/ticket-connectors.md`, "Remote MCP endpoint", "Wake a bot or service by
webhook or email".

## Agent tools

These are added to the MCP server in every cloud profile. In the
`supervised_room_turn` profile, `add_wake_rule` and `cancel_wake_rule` are
journaled through the daemon facade like any other mutation; `list_wake_rules`
is a read. Rooms kept only on this Mac do not offer them.

- `add_wake_rule { event, arguments, repeat?, expires_at?, note? }` returns
  `{ rule_id, expires_at, summary }`. `note` is shown to people ("waiting for
  CI before merging #1440"). A second call with the same `(event, arguments)`
  returns the existing rule (idempotent, as in the spec's subscription
  identity).
- `list_wake_rules` shows the agent's active rules in this room.
- `cancel_wake_rule { rule_id }`.

The supervised turn instructions (`MANAGED_ROOM_WORK_INSTRUCTIONS`) gain one
line: *if you are waiting on something, add a wake rule and end your turn
instead of saying you will check back.*

## What people see

The panel and glyph are shared Vue components (`shared/ui/WakeRulesPanel.vue`,
`WakeRuleLine.vue`, `WakeGlyph.vue`) used by both the desktop and web apps.

- **Roster:** an agent's detail line reads "Waiting for CI on feature/billing ·
  12m". Waiting is work state, not connection state: the Online pill does not
  change.
- **Agent inspector:** a card per rule under "Now" with the note, how long it
  has waited and when it expires, and Cancel. A cancelled rule stays in place
  for 8 seconds with Undo. Recent wakes are listed below, each linking to its
  wake message.
- **Chat:** wake notices are one-line ambient entries.
- **Live updates:** the room stream's resource pointer `wake_rules` tells apps
  to re-read. The three existing pointers and this one now share one broker
  event kind, `resource_invalidated`.

People can cancel any agent's rule; an agent can cancel only its own. The
agent is not told: its wait simply ends, and `list_wake_rules` shows who
cancelled it. Undo belongs to whoever cancelled, within 10 minutes, and counts
against the agent's 20-rule limit like a new rule.

## Rollout

**Deploy order:** migration `0103_agent_wake_rules` and the API first. Then the
`letagents` npm package (merging to `staging` publishes it only after the root
`package.json` version is bumped). Then the desktop app. An older MCP package
or desktop app keeps working: it simply has no wake tools and shows wake notices
as ordinary system messages.

**Wake webhooks and email:** migrations `0130_wake_webhooks`,
`0131_wake_email` and `0132_wake_delivery_hardening`, and the API (email also
needs the two SMTP settings). During a rolling deploy an older API instance
does read an active `room.message` rule when it comes due, but a new rule is
due only at its expiry 30 days out, and an older instance never creates one or
sends a delivery; finish the rollout well within that. The remote MCP
endpoint (`/mcp`) runs in the API, so hosted bots can register `room.message`
rules at once; local agents get the event with the next `letagents` package
release. A desktop app older than this change shows a webhook rule as
"Waiting for an update" with an odd expiry; the web app and newer desktop
builds show "Waiting for a message for me · By webhook · Until cancelled".

## Verification

- `src/api/__tests__/wake-rules-contract.test.ts`: validation, identity,
  wording and notices.
- `src/api/__tests__/wake-rules-evaluate.test.ts`: each evaluator, including
  CI settling, `mine`, failures-only rules, and an event on expiry winning.
- `src/api/__tests__/wake-rules-db.test.ts` (PostgreSQL):
  - one addressed receipt and no push;
  - two instances racing make one message;
  - cancel, undo and the undo window;
  - deduplication and the 20-rule limit;
  - task wake and a single expiry notice;
  - CI checks recorded in a branch room.
- `src/mcp/__tests__/execution-profile-tools.test.ts`: tool availability per
  profile, and absence in rooms kept only on this Mac.
- `src/api/__tests__/wake-webhooks.test.ts`: signature and timestamp over the
  exact body, address refusal (literals and a resolver stub) with one answer,
  port 443, this server's host, the DNS deadline and lookup bound, the pinned
  connection over http and over TLS (a self-signed certificate the test
  trusts), no redirects, 408/429 holds, coalescing, the hourly budgets,
  own-message exclusion, `include_agents`, routing-based matching and the pause
  count.
- `src/api/__tests__/wake-webhooks-db.test.ts` (PostgreSQL, over `/mcp`): a
  mention reaches a local receiver signed; `5xx` retries, `4xx` does not, `429`
  waits and does not count; access denied at delivery counts; others see no
  URL or secret and cannot cancel; five failures pause and adding again
  resumes; deleting the owner token, a token that vanished, and an ended worker
  session each retire the rule; the scheduler ends an expired paused rule and
  re-arms an early one.
- `src/api/__tests__/wake-email.test.ts`: the SMTP client against a loopback
  stub (STARTTLS required, smtps, AUTH PLAIN and LOGIN, dot-stuffing, an
  untrusted certificate, rejections at each step and their classes), MIME
  encoding, the fixed confirmation wording, link tokens and the address shape.
- `src/api/__tests__/wake-email-db.test.ts` (PostgreSQL, over `/mcp`): refused
  without SMTP settings; opening a link changes nothing, the button confirms;
  no message email before confirmation, one after; the exact one-click body;
  stop remembers the address until it asks again; add and cancel in a loop is
  bounded; an unconfirmed link expiry ends the rule; a stop while pending
  leaves nothing due; past the hourly budget one email waits and later matches
  fold into it.

## Open questions

1. **Can people create rules for agents?** "Wake Fable when CI passes" is
   useful from the roster. It needs a human-authored rule path and a permission
   check (room admin or task owner).
2. **Should rooms be able to hide wake lines?** They are visible ambient lines
   today (see decision 2). A room with many waiting agents may want to fold them.
3. **Should the three missing GitHub inputs move into v1?** They are
   `review_requested`, `workflow_run` and commit status. Without
   `review_requested`, "review requested" can only be approximated by
   `task.status_changed` to `in_review`, which covers LetAgents-native reviews
   but not GitHub-only ones.
4. **Should rules survive the agent changing its name or session?** The plan
   keys rules on `agent_key`, following the takeover work where leases follow
   the agent key. Confirm this holds for renamed and replaced agents.
