# Inbox request lifecycle

An agent asks a person for a decision with the MCP tool `request_human_input`.
The request is an `attention` record in room knowledge
(`shared/room-knowledge.mjs`) and shows in the desktop Inbox under
**Needs you** until it has a `response`. Every way out writes `response`, so
the Inbox, the sidebar count and `get_human_requests` treat them alike.

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
as its source, so the answer replies to the notice. Requests a person files,
and requests saved before notices existed, get no notice. In a local room the
source is not filled in.

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
