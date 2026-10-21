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
action. Until tracker connections exist, it stays empty. The card's work status
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
  LetAgents knows. Today those are the team keys of the room's own Linear
  cards. Tracker connections will add the connected teams.

## Rooms without ticket keys

A room where no card names a ticket shows no ticket labels or chips, makes no
extra request from the desktop app, and runs no key detector on its messages
or GitHub events. The server remembers for 30 seconds that the room has no
ticket cards, so most messages cost no extra query. Setting a key clears that
memory at once on the server that wrote it.
