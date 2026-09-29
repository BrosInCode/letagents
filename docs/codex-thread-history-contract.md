# Codex thread history contract

Verified on 2026-09-22 with installed `codex-cli 0.153.4` on macOS.

LetAgents explicitly requests `historyMode: "legacy"` when creating Codex
threads. The native default can create a paginated thread whose history APIs
return `list_turns is not supported yet`. LetAgents needs authoritative turn
history for reattachment, exact-turn recovery, approval dispatch, and idle
replacement. An unsupported history API cannot establish an empty conversation.

The same creation contract applies to adapter startup, missing-continuation
replacement, the standalone desktop launcher, and the MCP session starter.
The fixed contract takes precedence over launch-policy extras. Resume retains the
existing conversation's history mode. No observer cursor or stored conversation
is changed.

## Isolated native proof

A disposable `codex app-server --listen stdio://` used a new private `CODEX_HOME`
and scratch workspace. It inherited only PATH, the existing home directory,
and private temporary-directory settings; no login, token, room, or repository
configuration was copied. No model turn was started. The probe initialized with
`experimentalApi: true`, then created three threads with `approvalPolicy: "never"`
and `sandbox: "read-only"`. The exact spawned child was terminated afterward.

| Creation request | Returned mode | Metadata read | Read with turns / turns list | Resume, with and without `excludeTurns: true` |
| --- | --- | --- | --- | --- |
| Omitted `historyMode` | paginated | Exact thread, idle | `list_turns is not supported yet` | Same unsupported error |
| `historyMode: "legacy"` | legacy | Exact thread, idle | Explicit not-materialized-before-first-message error | No rollout found before the first message |
| `historyMode: "paginated"` | paginated | Exact thread, idle | `list_turns is not supported yet` | Same unsupported error |

The legacy response is the existing narrowly recognized empty-thread proof.
This no-model probe verifies creation and pre-first-turn attachment compatibility;
it does not claim a completed native model turn. Adapter regressions cover both
fresh creation and missing-continuation replacement against a runtime whose
default history mode is unsupported, including a conflicting launch-policy field.
The MCP startup regression reaches its immediate history inspection through the
same creation contract. Unsupported history still cannot authorize attachment,
recovery, or an idle proof.

## Existing paginated conversations

This change prevents new affected threads. It does not repair or migrate an
existing paginated continuation, including the agent that exposed this issue.
That recovery remains unresolved: it requires a native runtime with verified
support for the stored history or a separately authorized recovery path. Metadata
readability, an empty preview, and a sparse rollout file are not substitutes for
native history proof, and unsupported errors must remain fail-closed.
