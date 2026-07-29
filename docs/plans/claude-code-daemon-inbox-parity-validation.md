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
