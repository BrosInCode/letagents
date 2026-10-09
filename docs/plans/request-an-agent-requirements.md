# Request an Agent — needs, responsibilities, constraints, failures

Status: **draft for agreement**. This is the one shared document for the
"request an agent" idea discussed in room `focus_92`. Agents edit this file
on this branch instead of posting separate lists in the room. When everyone
agrees, the human signs off and we move one layer down the V.

How to contribute:

- Push commits to this branch, or leave a PR review comment on the line.
- Keep IDs stable. Add new rows at the end of a table; mark removed rows
  ~~struck~~ with a reason instead of deleting them.
- Put anything a human must decide in [Open decisions](#7-open-decisions).

## 1. The idea

Cash App made "request money from a friend" a social habit. The same for
agents: *"My quota ran out. Can someone put an agent in this room and finish
what I started?"* Someone with spare capacity says yes, their agent joins,
and the work continues.

This is the top-left of the V: what the system must do, who owns what, what
limits it, and how it fails. Every need and failure below gets an acceptance
check that the right-hand side of the V must pass.

## 2. Needs

| ID | Need | Acceptance check |
|----|------|------------------|
| N1 | **Ask.** A requester asks a person or a room for an agent, for a named room and piece of work, in one step. | A request with room, work summary, and wanted model/effort is created from one action and reaches the giver. |
| N2 | **Choose.** The giver sees who is asking, for what, and what accepting costs, and accepts or declines in one step. | The giver's request card shows requester, room, work, and the limits being asked for. Accept and decline are both one action. |
| N3 | **Continue the work.** The lent agent picks up where the requester stopped. | The agent can state the current state and next step from the handoff it receives, without the requester re-explaining. |
| N4 | **The giver stays safe.** Lending never exposes the giver's files, terminal, credentials, accounts, or other repos beyond what they chose to share. | A borrower prompt asking to read a file outside the shared workspace fails at the runtime, not by the model refusing. |
| N5 | **The requester stays in control of their repo.** The lent agent proposes changes; it cannot push or merge on its own. | Changes arrive as a patch or PR the requester approves. |
| N6 | **Bounded giving.** The giver decides how much they lend (time, budget, or tasks) and can stop at any moment. | Work stops at the limit, and within a defined time after the giver presses stop. |
| N7 | **Know the state.** Both people can see whether the request is waiting, accepted, starting, working, interrupted, or finished, and why. | Every state in §5 is shown to both sides with a plain reason. |
| N8 | **Keep the progress.** Work done before an interruption is not lost. | After any failure in §5, both people can see what was saved and where. |
| N9 | **Credit.** The room knows whose agent did what. | Messages, patches, and PRs from a lent agent name the giver. |

## 3. Responsibilities

| Party | Owns |
|-------|------|
| Requester | Writing the request and its scope; giving the context the agent needs; reviewing and accepting or rejecting the output; their repo. |
| Giver | The yes or no; the limits; the stop button; their machine and provider account. |
| LetAgents server | Delivering the request; identity and permissions; recording the grant; enforcing limits it can see; the record of what happened; reporting the true state. It never chooses the grant for the giver. |
| Giver's desktop runtime | Running the agent inside the granted workspace only; enforcing filesystem, network, and tool limits outside the model; stopping the agent when told; heartbeats. |
| Requester's desktop | Receiving and keeping results and checkpoints as they arrive. |
| Lent agent | Working only inside the grant; reporting progress in the room; returning changes as proposals. |

## 4. Constraints

| ID | Constraint |
|----|------------|
| C1 | The agent runs on the giver's computer and the giver's provider account. Their quota is limited and costs them money. |
| C2 | Provider terms may restrict sharing account access or quota. **Unverified. Could block the idea.** See D1. |
| C3 | A prompt from the borrower is untrusted input. Limits must be enforced by the runtime, not by instructing the model. |
| C4 | Sandbox strength is limited by what each CLI supports (for example, Codex permission profiles are beta; MCP tools and connectors need separate restrictions). |
| C5 | The giver's laptop can sleep, lose power, or lose network at any time. From the outside these look the same. |
| C6 | Work that never left the giver's machine cannot be recovered by anyone else. |
| C7 | Anything the agent posts into a normal room is readable there. |
| C8 | Requesting help grants no authority over someone else's files, accounts, or repos. Private repo access is checked against the requester's permissions. |
| C9 | Desktop releases are limited to about ten a month, so changes ship in batches. |

## 5. Failure scenarios

The human asked for failure handling to be treated as seriously as the happy
path. Each row says how we detect the failure, what must happen, and who
owns it. "Today" notes what the existing `rental` code already does, from
`src/api/rental/session-state-machine.ts` and `heartbeat.ts` on `staging`.

### 5.1 Request and consent

| ID | Failure | Detection | Required behavior | Owner | Today |
|----|---------|-----------|-------------------|-------|-------|
| F1 | Nobody answers the request. | Request age passes a timeout. | Request expires; requester is told and can re-ask someone else. | Server | **Gap:** `requested` can only go to `accepted` or `cancelled`. No expiry. |
| F2 | Giver declines. | Explicit decline. | Requester sees "declined" (not "cancelled"), can ask someone else. | Server | **Gap:** decline and cancel are the same state. |
| F3 | Two givers accept the same open request. | Second accept on a request already accepted. | First accept wins; second giver is told it was already taken. Nothing starts twice. | Server | Unverified. |
| F4 | Requester cancels after the giver accepted. | Cancel during `accepted` or `provisioning`. | Startup stops; nothing billed beyond what ran. | Server, giver runtime | Allowed by state machine. |
| F5 | Request spam or harassment. | Rate per requester/giver. | Rate limits; giver can block a requester. | Server | Not built. |
| F27 | Accept or start succeeds but the reply is lost, and the client retries. | Same request ID accepted/provisioned again. | Retry returns the existing session; one accept never becomes two running agents or double billing. | Server | Provisioning was made retry-safe (`cad70e71`); accept-path idempotency unverified. |

### 5.2 Startup

| ID | Failure | Detection | Required behavior | Owner | Today |
|----|---------|-----------|-------------------|-------|-------|
| F6 | Giver's provider is not set up or signed out. | Readiness check before accept. | Can't accept; giver sees what to fix. | Giver runtime | Provider readiness route exists. |
| F7 | Giver's quota is already too low for the request. | Quota check at accept. | Warn the giver before accepting; refuse if below the minimum. | Giver runtime, server | Quota declarations exist; check at accept unverified. |
| F8 | Workspace can't be prepared (repo access, clone, disk). | Provisioning error. | `failed` with a plain reason; requester can retry or ask someone else. | Giver runtime | `provisioning → failed` exists; **gap:** `failed` has no retry path. |
| F9 | Agent starts but never sends a first heartbeat. | No heartbeat within startup timeout. | Treat as failed startup, not as "working". | Server | Unverified. |

### 5.3 While working

| ID | Failure | Detection | Required behavior | Owner | Today |
|----|---------|-----------|-------------------|-------|-------|
| F10 | Giver's laptop sleeps, loses power, or loses network. | Missed heartbeats. | Show "giver unreachable" (cause unknown, per C5). Keep everything already saved. Resume if it returns; expire if it doesn't. | Server | Heartbeat 30s; stale 2 min; shown disconnected 5 min; expired 15 min. |
| F11 | Giver presses stop. | Explicit stop. | Agent and its child processes end within a defined time. Saved work stays with the requester. | Giver runtime | `active → cancelled` exists; kill-time guarantee unverified. |
| F12 | Budget runs out mid-step. | Meter / budget sentinel. | Stop before the next expensive step; offer the giver an extension; never silently overspend. | Server, giver runtime | Budget sentinel and `budget_exhausted` exist. |
| F13 | Provider rate limit or usage cap hit (not our budget). | Provider error. | Pause, show the reason, resume when the provider allows; do not report as a crash. | Giver runtime | Partly handled for Claude usage limits elsewhere. |
| F14 | Borrower (or injected text) asks the agent to read files, run commands, or reach the network outside the grant. | Runtime denial. | Denied by the sandbox; giver is shown the attempt. | Giver runtime | Scoped workspace, secret firewall, command broker exist. Enforcement per CLI unverified (C4). |
| F15 | Agent needs more access than granted to finish. | Agent requests escalation. | Request goes to the giver, never to the borrower. Work pauses (`blocked`) until answered. | Giver runtime | `blocked` exists; **gap:** `blocked` can only return to `active`, so a giver who never answers leaves it stuck. |
| F16 | Agent loops, crashes, or produces nothing useful. | No progress events / process exit. | Show it; let either side stop; keep partial work. | Giver runtime, server | Unverified. |
| F17 | Requester goes offline. | Requester presence. | Work continues within limits; results wait in the room/server for them. | Server | Unverified. |
| F18 | LetAgents server or daemon restarts. | Reconnect. | Session state and saved work survive; agent reconnects. | Server, giver runtime | Unverified for rentals. |
| F28 | Giver stops, or a limit is hit, while a tool call is half-done (file partly edited, command still running). | Stop arrives with a step in flight. | The in-flight step is aborted; half-applied workspace edits are never shipped as a patch. Requester sees the last complete checkpoint and that one step was discarded. | Giver runtime | Unverified. |
| F29 | Giver's machine comes back after the session expired, was cancelled, or was handed to a replacement. | Heartbeat or event for a session no longer `active`. | Agent re-checks its grant before doing anything. If the grant is gone it stops, and any unsent work is offered only as a proposal; it never publishes under stale authority. | Server, giver runtime | Unverified. |

### 5.4 Handing back the result

| ID | Failure | Detection | Required behavior | Owner | Today |
|----|---------|-----------|-------------------|-------|-------|
| F19 | Patch fails checks or the secret firewall. | Patch gate. | Rejected with reason; agent can revise. | Server | Patch gate and firewall exist. |
| F20 | Patch no longer applies (requester's branch moved). | Apply conflict. | Show the conflict; agent can rebase or requester resolves. | Server | Unverified. |
| F21 | Requester never reviews the patch. | Review age. | Patch is kept; session ends gracefully after a timeout so the giver isn't held. | Server | **Gap:** `patch_review` can only go to `active` or `pr_opened`. No expiry or cancel. |
| F22 | PR is closed without merging. | GitHub event. | Session ends as "not merged", not "completed". | Server | **Gap:** `pr_opened` can only go to `completed`. |
| F23 | Giver disconnects during patch review. | Missed heartbeats. | Review can still finish; patch is already on the server. | Server | Unverified. |

### 5.5 Trust and accounting

| ID | Failure | Detection | Required behavior | Owner | Today |
|----|---------|-----------|-------------------|-------|-------|
| F24 | Meter reports wrong or stale usage. | Snapshot age / confidence. | Treat stale as unknown; be conservative. | Server | Budget sentinel checks staleness. |
| F25 | Giver and requester disagree on what was used or delivered. | Dispute. | Both can see the same activity record. | Server | Activity events ledger exists. |
| F26 | Borrower re-lends what they borrowed. | Request from an active lent session. | Not allowed in v1. | Server | Not built. |

## 6. Gaps in the current state machine

From `src/api/rental/session-state-machine.ts` on `staging`. These are the
smallest concrete fixes the failure table points at:

1. `requested` has no expiry and no separate `declined` state (F1, F2).
2. `failed` has no retry path (F8).
3. `blocked` can only go back to `active` (F15).
4. `patch_review` has no timeout or cancel (F21).
5. `pr_opened` can only end as `completed` (F22).

No code changes until the human agrees on this document.

## 7. Open decisions

| ID | Decision | Who |
|----|----------|-----|
| D1 | Do provider terms allow lending quota or a seat? Checked first because it could block the whole idea (C2). | Human |
| D2 | What does "I'll help" commit the giver to: a bounded amount (time/budget), or finishing a task? | Human |
| D3 | Ask a specific person only (Cash App style), or also "anyone in the room"? | Human |
| D4 | Free / favor-based for v1, or design for payment now? | Human |
| D5 | Must both people stay online, or can results wait for the requester (F17)? | Human |
