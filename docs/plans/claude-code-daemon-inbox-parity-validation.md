# Claude Code daemon-inbox parity validation

Status: **cut over to daemon-owned room delivery**

Date: 2026-07-29

## Result

Supervised Claude Code room agents now use the same durable ingress model as
Codex: `delivery_mode=daemon_inbox` is the only owner of room observation,
dispatch, retry, credential borrowing, and reply publication.

Claude uses its native headless CLI rather than the Codex app-server, so the
wire details differ:

- the adapter creates and resumes one exact Claude session;
- startup performs one no-tools bootstrap and returns the session idle;
- every daemon inbox item gets a caller-minted UUID before native dispatch;
- the UUID is checked against Claude's `user_message_uuid`;
- the normalized terminal reply is checkpointed before provider-local evidence
  is released;
- restart recovery reads only the exact session and exact UUID from Claude's
  JSONL transcript;
- absent or partial terminal evidence fails closed and never reruns the turn.

The former Electron-owned Claude Agent SDK runtime, desktop-event delivery,
private in-app session cache, and Claude `mcp_polling` launch option have been
removed. Loading desktop state drops the obsolete Claude cache keys, and the
next state write removes them from disk. Existing manifests that still request
Claude `mcp_polling` are rejected by adapter capability negotiation instead of
starting a second poller.

## Credential and effect boundary

The Claude process receives the same exact daemon coordinates used by Codex:
entry, socket, work attempt, execution generation, worker session, room, and
display name. It also receives:

```text
LETAGENTS_SUPERVISED_BOUNDED_TURNS=1
LETAGENTS_EXECUTION_PROFILE=supervised_room_turn
```

Ambient `LETAGENTS_TOKEN` and `LETAGENTS_AGENT_SESSION_BEARER` values are
removed. The strict ephemeral Claude MCP config contains the API URL but no
owner or fixed worker credential. LetAgents MCP effects therefore borrow the
current exact-generation grant from the daemon.

## Restart safety

Claude's stream-json stdio cannot be reattached after daemon death. A successor
daemon handles that native limitation safely:

1. It authenticates the recorded PID by process birth identity.
2. It gives the exact orphan a bounded window to receive EOF, finish, and flush
   its transcript.
3. If the orphan remains alive, it fences that exact process before resuming.
4. It resumes the same Claude session.
5. It recovers only the already-checkpointed turn UUID.

A terminal transcript produces the prior reply once. Missing terminal evidence
is ambiguous and blocks; it never creates a replacement turn.

## Live evidence

The opt-in smoke command remains available:

```bash
cd apps/desktop
LETAGENTS_RUN_LIVE_CLAUDE_SPIKE=1 \
LETAGENTS_CLAUDE_CODE_BIN=/absolute/path/to/claude \
npm run smoke:claude-daemon-inbox
```

Observed with Claude Code 2.1.220:

- caller UUID matched queued, started, completed, and terminal result identity;
- `--resume` preserved the exact session ID;
- the session JSONL preserved the exact caller UUID;
- forced death before a terminal transcript boundary remained unreadable, as
  required by the fail-closed rule.

Desktop preflight and the adapter both require Claude Code 2.1.70 or newer.

## Regression anchors

- `claude-code-provider-adapter.test.ts`: idle bootstrap, complete daemon
  environment, credential stripping, exact bounded dispatch, terminal
  checkpointing, no-reply semantics, interrupt behavior, process fencing,
  resume, and transcript-only recovery.
- `claude-daemon-inbox-evidence.test.ts`: exact stream correlation, terminal
  transcript boundaries, tool-result isolation, and fail-closed parsing.
- daemon delivery tests: provider-neutral claim/recovery/publication and
  rejection of delivery-mode mismatches.
- provider registry and desktop tests: Claude advertises only supervised
  `daemon_inbox`; the former app-owned Claude runtime is unavailable.

## Typed-observation and approval feasibility (2026-08-31)

PR3 adds future-only structural observations alongside the legacy lifecycle;
it does not enable approvals, change permission profiles, or soften deadlines.
The exact native `command_lifecycle.command_uuid` identifies a user turn, not a
shell command. Assistant `tool_use` records a request, not proof it started;
only a matched native `tool_result` inside the exact native-started turn window
contributes an execution terminal. Tool messages have no caller turn UUID, so
pre-start tails are ignored. Missing start evidence stays missing. Subagent tool messages and unmatched results are
not attributed to a parent execution. Native text and tool payloads never enter
this structural observation stream. Failed tool/turn facts cannot kill a child.

The static feasibility check inspected local Claude Code **2.1.238** using
package metadata and `--help` only, with binary SHA-256
`1c196c456373b57818ae87df84aecee96cb659448c0d6a6bbb401ac5758431b2`.
No model turn or permission decision was dispatched. The minimum supported
version above is not a protocol pin or proof of approval support.

Anthropic's [SDK control implementation at af5ff1b9](https://github.com/anthropics/claude-agent-sdk-python/blob/af5ff1b9f2f279575f89b78f17572c6e35fbc2b6/src/claude_agent_sdk/_internal/query.py#L469)
provides a feasible native route: incoming `control_request/can_use_tool`,
responses matched by request ID, and cancellation of pending requests. Its
request includes `tool_use_id`, but not LetAgents' exact room-turn identity.
The adapter must establish that binding itself. The [permission contract](https://code.claude.com/docs/en/agent-sdk/permissions)
also requires a prompting mode: `dontAsk` does not invoke the approval callback.
The earlier daemon-inbox smoke test intentionally uses `dontAsk`, so it cannot
serve as an approval-conformance test.

Approval readiness remains **unsupported**. This spike establishes static
feasibility, not pinned-platform native approval conformance. The latter still
must prove allow-once, deny, cancellation races,
duplicate/stale IDs, subagent identity, stdin loss, and same-session resume
without replaying old responses. It must prohibit scope-widening permission
updates and establish pending-request survival boundaries. No pending-request
relist or non-mutating native control probe has been proved here. Both Claude
and Cursor therefore report `unprobeable` on their current control paths;
Claude reports loss only after observed process exit. Cursor's wrapper IPC is
not proof that its native model loop responds.

No existing local fixture can prove that the installed Claude binary emits and
resolves a real pending native permission request: SDK/mock tests prove the
client wire handler only. Producing such a request requires a native model/tool
turn; this PR deliberately ran no charged model turns. Claude remains
visibility-only for this release until that native conformance gate passes.

Cursor observation coverage is intentionally narrower than its display feed:
verified per-child init/result/exit, native `readToolCall`/`writeToolCall`
request/result correlation, and foreground `shellToolCall` results. Native
`toolCallStarted` is request evidence, not execution-start proof; neither an
unclosed request nor display-only interrupted-card cleanup invents a started,
interrupted, or lost execution. Foreground shell success/failure preserves its
numeric exit code; native rejection/permission denial has no side effects, and
spawn error is failed without observed start. Unknown variants, timeout outcomes,
and background handoffs remain gaps, not fabricated successful completion. Every
observation carries the child birth identity so a successor child cannot be
attributed to its predecessor's runtime; its continuation is captured per child.

The static Cursor schema check used **2026.07.09-a3815c0**, without launching a
turn. Its `index.js` SHA-256 is
`0312ba6ca62f6b18890745625e8a42513bd0002cd713beac4fb99e25e6ff7a92`;
`1683.index.js` is
`cb387aa0023d3fe2e8474a1c40a6744a61c26d825d0215aa30dc30fbe0a6cf07`.
The native stream serializes `ShellResult` protobuf JSON with default scalar
values: `success`/`failure` contain int32 `exitCode`, while `isBackground`
distinguishes a handoff. Other pinned oneof outcomes include `rejected`,
`permissionDenied`, and `spawnError`. This is evidence for the fixture contract,
not a claim of live-version conformance or approval-bridge support.
