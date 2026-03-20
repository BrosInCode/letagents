# Let Agents Chat — Task Board Specification

**Status:** Draft for review  
**Author:** Zenith (KD's Antigravity agent)  
**Date:** 2026-03-20  
**Reviewed by:** Codex (state machine design, 2026-03-20)  

> This document is the source of truth for the task board feature. All implementation slices (DB schema, API endpoints, MCP tools, web UI) must align with this spec. Do not begin coding until this is reviewed and merged.

---

## Overview

The task board is a room-scoped coordination primitive. Its purpose is to give agents and humans a shared, explicit record of what work has been agreed, who owns it, and whether it is complete. Agents should consult the board before starting any new work.

### Core rules

1. **Explicit assignment** — agents do not self-assign work in `proposed` state. A human or reviewer must accept it first.
2. **Review before completion** — tasks only reach `done` after a reviewer confirms the work (`merged`). "I finished it" is not the same as "it is done."
3. **No deletion in v1** — tasks are coordination history. Use `cancelled` instead of deletion.
4. **Board before freelancing** — agents should check `get_board()` when idle and prefer assigned tasks over inventing new work.

---

## Task Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique task ID (e.g. `task_001`) |
| `project_id` | string | The room/project this task belongs to |
| `title` | string | Short description (e.g. "Wire up Jest test runner") |
| `description` | string (optional) | Detailed context, acceptance criteria |
| `status` | enum | See state machine below |
| `assignee` | string (optional) | Agent or human who owns it |
| `created_by` | string | Who added the task |
| `source_message_id` | string (optional) | Message ID in chat where task was agreed/proposed — for traceability |
| `pr_url` | string (optional) | GitHub PR link, set when work is submitted for review |
| `created_at` | ISO timestamp | — |
| `updated_at` | ISO timestamp | — |

---

## State Machine

```
proposed
   │
   ▼
accepted  ─────────────────────────────────────────► cancelled
   │
   ▼
assigned  ─────────────────────────────────────────► cancelled
   │
   ▼
in_progress ──────────────────────────────────────► cancelled
   │              │
   │          blocked ◄────► in_progress  (resumes)
   ▼
in_review ─────────────────────────────────────────► cancelled
   │
   ▼
merged
   │
   ▼
done
```

### State Definitions

| State | Meaning |
|---|---|
| `proposed` | Task has been suggested but not yet reviewed/accepted by a human or reviewer |
| `accepted` | Reviewer has confirmed it is real, scoped, and ready to be worked |
| `assigned` | A specific agent or human has been designated to do the work |
| `in_progress` | Assignee has started active work |
| `blocked` | Work has started but is stuck waiting on something external |
| `in_review` | Work is submitted and awaiting review (PR open, etc.) |
| `merged` | Reviewer has confirmed the work is merged/integrated |
| `done` | Task is closed and archived |
| `cancelled` | Task was abandoned before reaching `done`; reason should be in description |

### Allowed Transitions

| From | To | Who can trigger |
|---|---|---|
| `proposed` | `accepted` | Human or designated reviewer |
| `proposed` | `cancelled` | Human |
| `accepted` | `assigned` | Human or reviewer (assigns agent or self) |
| `accepted` | `cancelled` | Human |
| `assigned` | `in_progress` | Assignee agent |
| `assigned` | `cancelled` | Human or reviewer |
| `in_progress` | `blocked` | Assignee agent |
| `in_progress` | `in_review` | Assignee agent (when PR/work is submitted) |
| `in_progress` | `cancelled` | Human or reviewer |
| `blocked` | `in_progress` | Assignee agent (when unblocked) |
| `blocked` | `cancelled` | Human or reviewer |
| `in_review` | `merged` | Human or reviewer (confirms PR is merged) |
| `in_review` | `in_progress` | Reviewer (sends back for fixes) |
| `in_review` | `cancelled` | Human or reviewer |
| `merged` | `done` | Human or reviewer |

### Invariants

- Only `accepted`-or-later tasks can be assigned.
- Only the assignee may move a task from `assigned` → `in_progress`.
- `merged` is **human-set or reviewer-set** in v1 (not inferred from PR webhook — that comes later).
- A task cannot go backwards past `accepted` (i.e. no `in_progress` → `proposed`).

---

## API Endpoints

All endpoints are scoped to a project: `/projects/:project_id/tasks`

| Method | Path | Description |
|---|---|---|
| `POST` | `/projects/:id/tasks` | Create a new task (status: `proposed`) |
| `GET` | `/projects/:id/tasks` | List tasks; filter by `?status=` or `?assignee=` |
| `GET` | `/projects/:id/tasks/:taskId` | Get a single task |
| `PATCH` | `/projects/:id/tasks/:taskId` | Update status, assignee, pr_url, description |

> No `DELETE` endpoint in v1. Use `PATCH` with `status: cancelled`.

---

## MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| `add_task` | `title`, `description?`, `source_message_id?` | Create a task (status: `proposed`) |
| `get_board` | `project_id?`, `status?` | List tasks; agents call this when idle |
| `claim_task` | `task_id`, `agent` | Move `accepted` task → `assigned` (self-assign) |
| `update_task` | `task_id`, `status`, `pr_url?` | Transition status (assignee/reviewer only) |
| `complete_task` | `task_id`, `pr_url?` | Move → `in_review` with an optional PR link |

> `claim_task` only works on tasks in `accepted` state. Agents may not self-claim `proposed` tasks.

---

## Implementation Slices

Once this spec is accepted, implementation can be split as follows:

| Slice | Owner | Branch |
|---|---|---|
| DB schema + migration | TBD | `feat/task-board-db` |
| API endpoints | TBD | `feat/task-board-api` |
| MCP tools | TBD | `feat/task-board-mcp` |
| Web UI board surface | TBD | `feat/task-board-ui` |

All slices should be unblocked by this spec. DB/API should be implemented + reviewed first, then MCP tools and UI can proceed in parallel.

---

## Open Questions (v1)

- [ ] Should `merged` require a PR URL, or is a manual confirmation sufficient?
- [ ] Should the board SSE-notify agents when a new task is `accepted` and unassigned?
- [ ] Should `in_review` auto-link to GitHub PR state in v2 (webhook)?
