# Request an Agent — needs, responsibilities, constraints, failures

Status: **draft, nothing agreed yet**. This is the one shared document for
the "request an agent" idea discussed in room `focus_92`. Agents edit this
file on this branch instead of posting separate lists in the room. When
everyone agrees, the human signs off and we move one layer down the V.

Contributors so far: CloudThicket (base draft), ReefLantern, OliveLively,
MesaStar, RookTimber, SunBrook (room messages msg_82–msg_97).

## 0. How we agree

- Push commits to this branch, or leave a PR review comment on the line.
  Say "change F12" or "add after N4", not a whole new list.
- Keep IDs stable. Add new rows at the end of a table; strike removed rows
  ~~like this~~ with a reason instead of deleting them.
- Every row has a status:
  - **proposed**: written down, not yet reviewed.
  - **agreed**: every reviewer recorded approval against a named commit of
    this file, and no correction on the row is open. Silence is not
    agreement.
  - **open**: there is a disagreement or a human decision pending. Both
    positions stay written until it is resolved.
- Rows describe required behavior and checks. They do not claim the
  product already does it. "Today" columns say what the code does now.
- Anything a human must decide goes in [Open decisions](#7-open-decisions).

## 1. The idea

Cash App made "request money from a friend" a social habit. The same for
agents: *"My quota ran out. Can someone put an agent in this room and finish
what I started?"* Someone with spare capacity says yes, their agent joins,
and the work continues.

This is the top-left of the V: what the system must do, who owns what, what
limits it, and how it fails. Every need and failure below gets an acceptance
check that the right-hand side of the V must pass.

## 2. Needs

| ID | Need | Acceptance check | Status |
|----|------|------------------|--------|
| N1 | **Ask.** A requester asks a person or a room for an agent, for a named room and piece of work, in one step. | A request with room, work summary, and wanted model/effort is created from one action and reaches the giver. | proposed |
| N2 | **Choose.** The giver sees who is asking, for what, and what accepting costs, and accepts or declines in one step. | The giver's request card shows requester, room, work, and the limits being asked for. Accept and decline are both one action. | proposed |
| N3 | **Continue the work.** The lent agent picks up where the requester stopped. | The agent can state the current state and next step from the handoff it receives, without the requester re-explaining. | proposed |
| N4 | **The giver stays safe.** Lending never exposes the giver's files, terminal, credentials, accounts, or other repos beyond what they chose to share. | A borrower prompt asking to read a file outside the shared workspace fails at the runtime, not by the model refusing. | proposed |
| N5 | **The requester stays in control of their repo.** The lent agent proposes changes; it cannot push or merge on its own. | Changes arrive as a patch or PR the requester approves. | proposed |
| N6 | **Bounded giving.** The giver decides how much they lend (time, budget, or tasks) and can stop at any moment. | Work stops at the limit, and within a defined time after the giver presses stop. | proposed |
| N7 | **Know the state.** Both people can see whether the request is waiting, accepted, starting, working, interrupted, or finished, and why. Unknown is a valid state; the system never guesses a cause it can't see. | Every state in §5 is shown to both sides with a plain reason, and both sides see the same state. | proposed |
| N8 | **Keep the progress.** Work done before an interruption is not lost. "Saved" means saved and verified, not "sent". | After any failure in §5, both people can see what was saved, where, and what may be missing. | proposed |
| N9 | **Credit.** The room knows whose agent did what. | Messages, patches, and PRs from a lent agent name the giver. | proposed |

## 3. Responsibilities

| Party | Owns |
|-------|------|
| Requester | Writing the request and its scope; giving the context the agent needs; reviewing and accepting or rejecting the output; their repo. |
| Giver | The yes or no; the limits; the stop button; their machine and provider account. |
| LetAgents server | Delivering the request; identity and permissions; recording the grant; enforcing limits it can see; the record of what happened; reporting the true state. It never chooses the grant for the giver. |
| Giver's desktop runtime | Running the agent inside the granted workspace only; enforcing filesystem, network, and tool limits outside the model; stopping the agent when told; heartbeats; cleanup. |
| Requester's desktop | Receiving and keeping results and checkpoints as they arrive. |
| Lent agent | Working only inside the grant; reporting progress in the room; returning changes as proposals. |

## 4. Constraints

| ID | Constraint |
|----|------------|
| C1 | The agent runs on the giver's computer and the giver's provider account. Their quota is limited and costs them money. |
| C2 | Provider terms may restrict sharing account access or quota. **Unverified. Could block the idea.** See D1. |
| C3 | A prompt from the borrower is untrusted input. Limits must be enforced by the runtime, not by instructing the model. |
| C4 | Sandbox strength is limited by what each CLI supports (for example, Codex permission profiles are beta; MCP tools and connectors need separate restrictions). |
| C5 | The giver's laptop can sleep, lose power, or lose network at any time. From the outside these look the same, and silence does not prove the agent stopped. |
| C6 | Work that never left the giver's machine cannot be recovered by anyone else. |
| C7 | Anything the agent posts into a normal room is readable there. |
| C8 | Requesting help grants no authority over someone else's files, accounts, or repos. Private repo access is checked against the requester's permissions. |
| C9 | Desktop releases are limited to about ten a month, so changes ship in batches. |
| C10 | Some effects can't be undone (a pushed branch, a posted message, money spent). Stopping a session ends future actions; it does not reverse finished ones. |

## 5. Failure scenarios

The human asked for failure handling to be treated as seriously as the happy
path. Each row says which need it threatens, how we detect it, what must
happen (including what people see and what work survives), and who owns it.
"Today" notes what the existing `rental` code does, from
`src/api/rental/session-state-machine.ts` and `heartbeat.ts` on `staging`.

How we look for gaps: cross each stage below with five kinds of trouble:
**interruption, duplication, stale state, permission change, bad input**. A
stage with an empty cell for one of those is a place we haven't looked yet.

### 5.1 Request and consent

| ID | Failure | Need | Detection | Required behavior | Owner | Today | Status |
|----|---------|------|-----------|-------------------|-------|-------|--------|
| F1 | Nobody answers the request. | N1, N7 | Request age passes a timeout. | Shows "expired" (not "still waiting"). Requester can re-ask someone else. | Server | **Gap:** `requested` can only go to `accepted` or `cancelled`. No expiry. | proposed |
| F2 | Giver declines. | N2, N7 | Explicit decline. | Requester sees "declined" (not "cancelled") and can ask someone else. | Server | **Gap:** decline and cancel are the same state. | proposed |
| F3 | Two givers accept the same open request. | N7 | Second accept on a request already accepted. | First accept wins; second giver sees "already taken". Nothing starts twice. | Server | Unverified. | proposed |
| F4 | Requester cancels after the giver accepted. | N6 | Cancel during `accepted` or `provisioning`. | Startup stops; nothing billed beyond what ran. | Server, giver runtime | Allowed by state machine. | proposed |
| F5 | Request spam or harassment. | N2 | Rate per requester/giver. | Rate limits; giver can block a requester. | Server | Not built. | proposed |
| F6 | The request is edited while the giver is accepting it. | N2 | Request version at accept differs from current. | The yes applies only to the version the giver saw. A changed request needs a new yes. | Server | Not built. | proposed |
| F7 | The accept (or launch) worked, but the reply was lost and the client retries. | N6, N7 | Retry of an accept/launch already recorded. | Check whether the first one happened before doing anything. A retry returns the existing session. One accept never becomes two running agents or double billing. | Server, giver runtime | Provisioning was made retry-safe (`cad70e71`); accept-path idempotency unverified. | proposed |

### 5.2 Startup

| ID | Failure | Need | Detection | Required behavior | Owner | Today | Status |
|----|---------|------|-----------|-------------------|-------|-------|--------|
| F8 | Giver's provider is not set up or signed out. | N2 | Readiness check before accept. | Can't accept; giver sees what to fix. | Giver runtime | Provider readiness route exists. | proposed |
| F9 | Giver's quota is already too low for the request. | N6 | Quota check at accept. | Warn the giver before accepting; refuse below the minimum. | Giver runtime, server | Quota declarations exist; check at accept unverified. | proposed |
| F10 | Workspace can't be prepared (repo access, clone, disk). | N3 | Provisioning error. | `failed` with a plain reason; requester can retry or ask someone else. | Giver runtime | `provisioning → failed` exists; **gap:** `failed` has no retry path. | proposed |
| F11 | Agent starts but never becomes usable: no first heartbeat, can't reach the room, or reaches the room without the repo. | N3, N7 | No heartbeat / no room join / no workspace within a startup timeout. | Shows "setup incomplete", never "ready". Spending stops while it's repaired. A retry doesn't launch a second agent while the first may still be starting. | Server, giver runtime | Unverified. | proposed |
| F12 | Isolation or budget enforcement is unavailable or misconfigured on the giver's machine (including connected tools that bypass the shell sandbox). | N4, N6 | Runtime self-check before start. | Don't start. Never fall back to broader access or unlimited spending. Giver sees what's missing. | Giver runtime | Unverified. Depends on C4. | proposed |

### 5.3 While working

| ID | Failure | Need | Detection | Required behavior | Owner | Today | Status |
|----|---------|------|-----------|-------------------|-------|-------|--------|
| F13 | Giver's laptop sleeps, loses power, or loses network. | N7, N8 | Missed heartbeats. | Shows "giver unreachable", cause unknown (C5). Requester keeps only work that already left the machine. If it returns, it re-checks its grant before continuing; if not, the session expires. | Server | Heartbeat 30s; stale 2 min; shown disconnected 5 min; expired 15 min. | proposed |
| F14 | Giver presses stop or revokes, including while disconnected or mid-action (for example a half-applied change). | N6 | Explicit stop. | Two states: "stop requested" and "confirmed stopped". Agent and its child processes end within a set deadline. A step still in flight (file partly edited, command running) is aborted, and its half-applied edits are never shipped as a patch. The requester sees the last complete checkpoint and that one step was discarded. Finished external effects stay (C10) and are listed. | Giver runtime, server | `active → cancelled` exists; deadline and confirmation not built. | proposed; deadline **open** (D6) |
| F15 | Budget runs out mid-step. | N6 | Meter / budget sentinel. | Stop before the next expensive step; offer the giver an extension; never overspend silently. Spend so far stays visible. | Server, giver runtime | Budget sentinel and `budget_exhausted` exist. | proposed |
| F16 | Provider rate limit or usage cap hit (not our budget). | N6, N7 | Provider error. | Pause, show the reason, resume when the provider allows. Not reported as a crash. | Giver runtime | Partly handled for Claude usage limits elsewhere. | proposed |
| F17 | Borrower (or injected text) asks the agent to read files, run commands, or reach the network outside the grant. | N4 | Runtime denial. | Denied by the sandbox even if the model tries; giver is shown the attempt. | Giver runtime | Scoped workspace, secret firewall, command broker exist. Enforcement per CLI unverified (C4). | proposed |
| F18 | Agent needs more access than granted to finish. | N4, N6 | Agent requests escalation. | Request goes to the giver, never the borrower. Work pauses (`blocked`) until answered, with a timeout. | Giver runtime | `blocked` exists; **gap:** `blocked` can only return to `active`, so an unanswered request stays stuck. | proposed |
| F19 | Agent loops, crashes, or produces nothing useful. | N3, N7 | No progress events / process exit. | Show it; either side can stop; partial work kept. | Giver runtime, server | Unverified. | proposed |
| F20 | Requester goes offline. | N6 | Requester presence. | **Open.** One view: keep working within the grant, results wait on the server. Other view: pause so the giver's quota isn't spent with nobody watching. | Server | Unverified. | **open** (D5) |
| F21 | LetAgents server or daemon restarts. | N7, N8 | Reconnect. | Session state and saved work survive; agent reconnects. | Server, giver runtime | Unverified for rentals. | proposed |
| F22 | A checkpoint save fails, disk fills up, or data arrives incomplete or corrupt. | N8 | Write error / checksum mismatch. | Never show that checkpoint as saved. Keep the last verified one and show the gap. Pausing vs continuing with a stated loss limit is a decision. | Requester's desktop, server | Not built. | proposed |
| F23 | A direct (P2P) connection can't be set up, or drops mid-transfer. | N8 | Connection error / incomplete transfer. | Fall back to the server path, or retry. Partial transfer is not treated as saved (F22). | Both desktops | Not built. Only relevant if P2P is chosen. | proposed |
| F24 | A replacement agent takes over, then the original giver's agent comes back. | N5, N8 | Reconnect from a session that was replaced. | The original's grant is no longer valid; it can't publish. Its unsynced work is kept and offered, not thrown away. A replacement starts only after the first grant is released. | Server | Not built. | proposed |
| F25 | Giver and requester see different states for the same session. | N7 | State mismatch on reconnect. | The server's record wins; both sides refresh to it. | Server | Unverified. | proposed |

### 5.4 Handing back the result

| ID | Failure | Need | Detection | Required behavior | Owner | Today | Status |
|----|---------|------|-----------|-------------------|-------|-------|--------|
| F26 | Patch fails checks or the secret firewall. | N5 | Patch gate. | Rejected with reason; agent can revise. "Saved" is shown separately from "checks passed". | Server | Patch gate and firewall exist. | proposed |
| F27 | Patch no longer applies (requester's branch moved). | N5 | Apply conflict. | Show the conflict; agent can rebase or requester resolves. Neither side's work is lost. | Server | Unverified. | proposed |
| F28 | Requester never reviews the patch. | N6 | Review age. | Patch is kept; session ends after a timeout so the giver isn't held. | Server | **Gap:** `patch_review` can only go to `active` or `pr_opened`. No expiry or cancel. | proposed |
| F29 | PR is closed without merging. | N7 | GitHub event. | Session ends as "not merged", not "completed". | Server | **Gap:** `pr_opened` can only end as `completed`. | proposed |
| F30 | Giver disconnects during patch review. | N8 | Missed heartbeats. | Review can still finish; the patch is already on the server. | Server | Unverified. | proposed |
| F31 | Work is done but the PR never opens. | N5, N8 | No PR after patch approval. | If the branch is already on the remote, open the PR without the giver's laptop. If not, tell the requester the work is still on that machine. | Server | Unverified. | proposed |
| F32 | The save or PR worked, but the reply was lost and the client retries. | N7 | Retry of an already-recorded publish. | Treat as "outcome unknown", not "failed". Find the existing result before retrying; never open a duplicate PR. | Server | Unverified. | proposed |

### 5.5 Ending, trust and accounting

| ID | Failure | Need | Detection | Required behavior | Owner | Today | Status |
|----|---------|------|-----------|-------------------|-------|-------|--------|
| F33 | Meter reports wrong or stale usage. | N6 | Snapshot age / confidence. | Treat stale as unknown; be conservative. | Server | Budget sentinel checks staleness. | proposed |
| F34 | Giver and requester disagree on what was used or delivered. | N6, N9 | Dispute. | Both see the same activity record. | Server | Activity events ledger exists. | proposed |
| F35 | Borrower re-lends what they borrowed. | N4 | Request from an active lent session. | Not allowed in v1. | Server | Not built. | proposed |
| F36 | Cleanup fails after the session ends (workspace copy, logs, or processes left behind). | N4 | Retention sweep / process check. | Show what was kept and who fixes it. Never claim deletion that didn't happen. | Giver runtime | Workspace retention sweep exists; process check unverified. | proposed |

### 5.6 Coverage

This list is what six agents found by walking the stages above. It does not
claim to cover every possible failure. For anything not listed, the default
is: stop spending, keep all evidence and work, and show an honest "unknown"
state to both people.

## 6. Gaps in the current state machine

From `src/api/rental/session-state-machine.ts` on `staging`. These are the
smallest concrete fixes the failure table points at:

1. `requested` has no expiry and no separate `declined` state (F1, F2).
2. `failed` has no retry path (F10).
3. `blocked` can only go back to `active` (F18).
4. `patch_review` has no timeout or cancel (F28).
5. `pr_opened` can only end as `completed` (F29).
6. There is no "stop requested" vs "confirmed stopped" distinction (F14).

No code changes until the human agrees on this document.

## 7. Open decisions

| ID | Decision | Who |
|----|----------|-----|
| D1 | Do provider terms allow lending quota or a seat? Check first, because it could block the whole idea (C2). | Human |
| D2 | What does "I'll help" commit the giver to: a bounded amount (time/budget), or finishing a task? | Human |
| D3 | Ask a specific person only (Cash App style), or also "anyone in the room"? | Human |
| D4 | Free / favor-based for v1, or design for payment now? | Human |
| D5 | When the requester goes offline, does the lent agent keep working, pause, or expire (F20)? | Human |
| D6 | How fast must "stop" take effect, including when the giver's machine is unreachable (F14)? | Human |
| D7 | When a checkpoint save fails, pause, or continue with a stated loss limit (F22)? | Human |
