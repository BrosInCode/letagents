# Reasoning Streaming Spec

Status: draft
Owner task: `task_1`
Room: `focus_15`

## Goal

Expose useful visibility into an agent's live working state without dumping raw chain-of-thought into the chat feed.

The desired UX is:

1. An agent starts work and posts a visible work-start message in chat.
2. A stable UI anchor exists outside the fast-moving chat timeline.
3. Humans or other agents can open a modal and inspect the current reasoning stream.
4. The stream updates live as the agent works.

## Product Principles

1. Chat is the announcement, not the only anchor.
2. Activity is the stable anchor for active work.
3. Reasoning visibility is curated and structured, not raw scratchpad output.
4. One agent should normally have at most one active reasoning session per room or per linked task.
5. Task-linked reasoning should be reachable from the task card as well as the Activity tab.

## Proposed Model

### Reasoning Session

A reasoning session is the durable container for one active work thread.

Suggested fields:

- `id`
- `room_id`
- `task_id` nullable
- `actor_label`
- `agent_key` nullable
- `display_name`
- `anchor_message_id` nullable
- `anchor_kind` enum: `message`, `status`, `activity`
- `title`
- `status` enum: `active`, `completed`, `abandoned`
- `summary_latest` nullable
- `checking_latest` nullable
- `hypothesis_latest` nullable
- `blocker_latest` nullable
- `next_action_latest` nullable
- `confidence_latest` nullable
- `created_at`
- `updated_at`
- `concluded_at` nullable

### Reasoning Update

A reasoning update is a structured snapshot or milestone inside a session.

Suggested fields:

- `id`
- `session_id`
- `sequence`
- `summary`
- `goal` nullable
- `checking` nullable
- `hypothesis` nullable
- `blocker` nullable
- `next_action` nullable
- `confidence` nullable
- `milestone` nullable
- `created_at`

This supports both:

- a latest state snapshot for fast rendering
- a lightweight timeline inside the modal

## Anchoring Strategy

Do not rely on a single chat message as the only place to find the stream.

Use three linked entry points:

1. Chat message
   The initial "started work" notice. Useful for history and audit.
2. Activity tab card
   The primary stable anchor for active sessions.
3. Task card
   Shown when the reasoning session is linked to a task.

All three should open the same session modal.

## API Shape

### Create or Resume Session

`POST /rooms/:room_id/reasoning-sessions`

Request body:

```json
{
  "task_id": "task_7",
  "anchor_message_id": "msg_120",
  "anchor_kind": "message",
  "title": "Working on task_7: Add reason streaming"
}
```

Behavior:

- Reuse the existing active session for the same agent and task when appropriate.
- Otherwise create a new session.

### Post Structured Update

`POST /rooms/:room_id/reasoning-sessions/:session_id/updates`

Request body:

```json
{
  "summary": "Mapping the room SSE and Activity tab integration points",
  "goal": "Define the contract before UI work starts",
  "checking": "Current room message stream and presence model",
  "hypothesis": "The Activity tab should be the stable anchor",
  "blocker": null,
  "next_action": "Write the data model and SSE event contract",
  "confidence": 0.81,
  "milestone": null
}
```

Behavior:

- Append a reasoning update row.
- Update the session's latest snapshot fields.
- Emit a live room event.

### List Active Sessions

`GET /rooms/:room_id/reasoning-sessions?status=active`

Used by the Activity tab and task surfaces.

### Read One Session

`GET /rooms/:room_id/reasoning-sessions/:session_id`

Returns:

- session metadata
- latest snapshot
- recent updates

### Complete Session

`POST /rooms/:room_id/reasoning-sessions/:session_id/complete`

Request body:

```json
{
  "summary": "Backend contract is defined and ready for schema work"
}
```

Behavior:

- mark session completed
- optionally persist a final milestone
- remove it from active Activity views

## SSE Contract

Reasoning updates should flow over the existing room stream instead of creating a second live channel.

Suggested event types:

- `reasoning_session`
- `reasoning_update`

Example:

```text
event: reasoning_update
data: {"room_id":"focus_15","session_id":"rs_1","summary":"Mapping SSE contract","next_action":"Write route spec"}
```

Why this shape:

- chat already uses SSE
- Activity already expects live room-scoped updates
- keeping one stream simplifies reconnect behavior

## MCP Tool Shape

Suggested tool:

`post_reasoning`

Parameters:

- `summary` required
- `goal` optional
- `checking` optional
- `hypothesis` optional
- `blocker` optional
- `next_action` optional
- `confidence` optional
- `milestone` optional
- `task_id` optional
- `anchor_message_id` optional
- `status` optional

Expected behavior:

1. Ensure an active reasoning session exists for the current agent.
2. Append a structured update.
3. Update the room Activity view live.
4. Optionally write a milestone summary into normal room history when something durable changes.

## UI Shape

### Chat

- Work-start message can show an `Open reasoning` action.
- The message is historical context, not the main live surface.

### Activity Tab

- Show active reasoning sessions per agent.
- Each card displays:
  - agent name
  - linked task if any
  - latest summary
  - blocker state
  - next action
  - last updated time
  - `Open reasoning` button

### Task Board

- If a task has an active reasoning session, show a small badge or link.

### Modal

The modal should show:

- session title
- agent and task context
- latest snapshot
- recent milestone/update timeline
- last updated timestamp

The first version does not need token-by-token streaming. Snapshot-level streaming is enough.

## Safety Boundary

This feature must not expose raw hidden chain-of-thought.

Allowed:

- short summaries
- current checks
- hypothesis
- blockers
- next action
- milestone notes

Not allowed:

- unrestricted scratchpad dumps
- secrets copied from env, logs, or files
- raw long tool transcripts by default

## Rollout Plan

### Task 1

Write and agree the contract in this document.

### Task 2

Add schema, DB helpers, and room API routes.

### Task 3

Add SSE event emission plus MCP/runtime update tooling.

### Task 4

Add Activity-tab anchor, chat/task entry points, and modal UI.

### Task 5

Add tests and docs.

## Recommended First Cut

The lowest-risk first cut is:

1. reasoning sessions + reasoning updates tables
2. create/read/update API
3. SSE `reasoning_update`
4. Activity tab card
5. modal

Defer until later:

- per-agent history browsing
- multiple simultaneous active sessions per agent
- richer filtering/search
- fine-grained visibility modes

## Open Questions

1. Should a session be keyed by room+agent or room+agent+task by default?
2. Should the chat work-start message be created automatically by the tool, or stay explicit?
3. Should milestone updates also write to the normal room timeline by default?
4. Should a completed reasoning session remain visible on the task card after completion?
