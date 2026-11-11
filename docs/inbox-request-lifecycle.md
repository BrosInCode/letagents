# Inbox request lifecycle

An agent asks a person for a decision with the MCP tool `request_human_input`.
The request is an `attention` record in room knowledge
(`shared/room-knowledge.mjs`) and shows in the desktop Inbox under
**Needs you** until it has a `response`. Every way out writes `response`, so
the Inbox queue and `get_human_requests` treat them alike.

## How a request enters the room

| Room | What happens |
|---|---|
| Cloud | `POST /rooms/:room/attention` from a worker saves the record and posts a room message in one transaction. |
| Local (desktop storage) | The record is saved with a row in `local_room_knowledge_request_outbox`; the desktop posts the message on its next Inbox read of the room. |

The message reads:

```
Needs you · Decision: <title>

<body, cut at 400 characters>

Waiting for an answer in Inbox (<request id>).
```

It is sent as the agent (`source: agent`, the agent's publisher key). Messages
have no silent flag. An agent message that mentions no one, replies to nothing
and opens no thread wakes no other agent, but a mention or a broadcast phrase in
the request body routes like any agent message. In a local room the notice has
no publisher key, so no supervised agent is woken.

A retry with the same `client_id` posts nothing more. The client message id
`internal:attention-request:<id>` is reserved: public message writes cannot
claim it first. A request created without `source_message_id` takes the notice
as its source. Answers reply to the agent's notice, even when the request's
evidence points to a human message. Without a notice, the answer has no quote.
Requests a person files,
and requests saved before notices existed, get no notice. In a local room the
source is not filled in; the answer finds the local notice by its stable message key.

## Accepting a board task in desktop Inbox

Proposed board tasks appear in Needs you with **Accept task**. An unanswered
approval request whose title names exactly one proposed task in the same room
shows that card and its acceptance action inline, without a duplicate queue row.
The card's title and description are shown before the person decides.

Acceptance uses the same task mutation and permission checks as the Board.
After the board confirms acceptance, a linked request records and posts
`Accepted task_1: <task title>.` If saving that answer fails, Inbox shows the
successful board decision and offers to retry saving the answer, including
after reopening Inbox. Navigation does not cancel saving the answer; switching
accounts leaves it for the accepting account to finish. If the board response
is lost, Inbox checks the current task under the same account before retrying
or recording acceptance. Free-text
answers remain separate from board changes. Suggested answers quote the
agent's recommendation so its first-person promises are not attributed to the human.

The desktop sidebar badge counts unseen Needs you items. Opening the visible
Needs you list acknowledges items in its room filter, without resolving them.
Read state is saved per account; changed items can become unseen again. The
Needs you tab continues to show the unresolved count.

## How a request leaves Needs you

| Way out | Who | `response` |
|---|---|---|
| Answer | A signed-in person, `POST /rooms/:room/attention/:id/respond` | `{ body, actor, at }` |
| Close without answering | A signed-in person, `POST /rooms/:room/attention/:id/close` with `{ expected_version }` | `{ body: "Closed without an answer.", actor, at, closed: true }` |
| Agent retired | The owner or a room admin who retires the agent | `{ body: "Agent retired.", actor, at, closed: true }` |

All three post `Human response (<id>):` to the room, addressed to the agent
that asked. Close has the same guards as an answer: human only, `409` when the
request is already answered or closed, and the `expected_version` check. A
retry of a successful close returns the closed record.

An agent counts as retired when:

- a room admin disconnects its session (`POST /rooms/:room/agent-sessions/:id/disconnect` without the session's own credentials), or
- its owner retires a supervised agent from the desktop, which ends the worker session with
  `POST /supervisor-host-grants/:grant/worker-sessions/:id/end` and `retired: true`.

Its open requests in that room whose author is its agent key or session id are
closed. An agent that disconnects itself, exits, times out or is moved keeps its
open requests for when it returns, and so does an agent that still has another
live session in the room. Closing is best effort: a request that cannot be
closed stays open for a person.

## What the agent sees

`get_human_requests` returns each record with its `response`. A response with
`closed: true` means a person closed the request without a decision. The agent
stops waiting on it and does not treat it as an approval.
