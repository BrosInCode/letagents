# Handoff V1 Spec

Status: Approved in-room on 2026-04-12

This document is the canonical source of truth for the v1 handoff trust contract.
It defines the narrow launch lane for handing a repo-scoped task to another agent
without turning that into vague host access.

## Product Promise

Hand the next task to another agent. They get the repo job you share, not your
computer.

For v1, the product is explicitly not "continue my whole session on someone
else's machine." It is a structured task delegation flow that returns a bounded
artifact such as a draft PR, review comment, or research note.

## Handoff Shape

Every v1 handoff must be structured before execution starts. The minimum fields
are:

- task title
- acceptance criteria
- target repo
- target branch
- expected output type

Vague prompts such as "continue from here" are out of scope for the supported
v1 lane unless they are first turned into a structured task.

## Pillar 1: Single Safe Lane

V1 supports one public execution story:

- hosted or otherwise platform-managed isolated execution only
- no host shell access
- no host environment access
- no filesystem access outside the approved repo scope
- no direct push to protected branches

If supplier-local or other execution modes exist in code, they are out of the
v1 trust contract and must not be presented as the same security lane.

## Pillar 2: Output-Bound Permissions

Permissions are derived from the requested output type. The output type must map
directly to a permission profile at grant issuance time.

| Output type | Default capability profile |
| --- | --- |
| `research_note` | Read-only repo access |
| `review_comment` | Read-only repo access plus issue/PR comment ability |
| `draft_pr` | Branch write on a scoped branch |

Additional rules:

- zero secrets by default
- branch write is not the default for non-code outputs
- any secret beyond the default profile requires an explicit named grant
- grants must be short-lived and scoped to the specific handoff

## Pillar 3: Strict Boundaries

Every handoff runs with explicit lifecycle controls and revocation boundaries.

- one repo-scoped task per handoff
- one worker session per approved task
- heartbeat or progress signal required while a task is active
- grants expire automatically based on task lifetime
- timeout or cancellation automatically revokes active grants
- partial artifacts and logs remain visible for audit

The baseline v1 state machine is:

`queued -> accepted -> in_progress -> stalled | completed | cancelled`

The platform should never leave a task in an ambiguous "kind of running" state
with still-valid credentials.

## Pillar 4: Sovereign Platform Policy

Platform policy is authoritative. Repository content is task input, not
permission authority.

That means:

- repo instructions cannot expand access scope
- config files, markdown, prompts, or scripts cannot grant new capabilities
- the worker may report that the repo asked for denied access, but cannot
  self-escalate because the repo requested it
- denied escalation attempts should be logged for later audit

In short: the capability manifest wins over anything the repo says.

## Pillar 5: Instant Revocation

Stopping a handoff is a hard permission cut, not a polite request.

- revoke invalidates the active capability immediately
- revoked workers cannot fetch, push, comment, or request new grants
- local reasoning state may continue to exist, but external side effects must
  hard-fail after revoke
- audit must record who stopped the task, when it happened, and the last
  successful side effect

This is a core trust behavior, not a polish feature.

## Pillar 6: No Silent Sub-Delegation

Recursive delegation is off by default in v1.

- one approved task maps to one worker session
- a worker cannot silently create another delegated worker under the same grant
- any new handoff requires fresh user approval
- if nested delegation is ever supported later, parent-child linkage must be
  explicit in the audit trail

This prevents scoped approvals from silently fanning out underneath the user.

## Default V1 Summary

The supported v1 path is:

1. The user structures a repo-scoped task.
2. The platform assigns output-bound permissions.
3. A hosted or platform-managed isolated worker executes the task.
4. The worker produces a bounded artifact, typically a draft PR.
5. The user can stop the task at any time and revoke access immediately.

Everything outside that lane should be treated as out of scope for the launch
trust contract until it has a separately explained and separately approved
security story.
