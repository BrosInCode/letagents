# Cursor Desktop Managed Agents - Phase 0 Findings

Date: 2026-06-30

This note records the local Cursor CLI probes used to decide how LetAgents should proceed with Cursor as a desktop-managed agent. The target product shape remains desktop-managed Cursor: the desktop app owns room I/O, delivers room events to Cursor, and publishes Cursor's final replies. Cursor must not join the room through the LetAgents MCP server in managed mode.

## Tested Runtime

- `cursor-agent` resolved to `~/.local/bin/cursor-agent`.
- `agent` resolved to `~/.local/bin/agent`.
- Both were symlinks to the same Cursor Agent build: `2026.06.26-7079533`.
- The managed runtime should still prefer `cursor-agent` because a bare `agent` binary is collision-prone. A bare `agent` fallback is acceptable only when preflight proves it is Cursor's CLI.

## Stream JSON Contract

`cursor-agent -p --output-format stream-json --mode ask --trust --workspace <dir> <prompt>` emitted newline-delimited JSON events:

- `system` with `subtype: "init"`, `apiKeySource`, `cwd`, `session_id`, `model`, and `permissionMode`.
- `user` with the submitted prompt.
- `assistant` with message content.
- `thinking` delta/completed events when the model reasons visibly.
- `tool_call` started/completed events for read, edit, shell, and MCP tool calls.
- `result` with `subtype`, `duration_ms`, `duration_api_ms`, `is_error`, `result`, `session_id`, `request_id`, and `usage`.

Every event observed carried the same `session_id` for the turn. A runner can parse stdout line-by-line and should publish only after a final `result` event is received.

## Session And Resume

- `--resume <session_id>` resumed the previous conversation context when given an observed `session_id`.
- A fresh run without `--resume` produced a different `session_id`.
- `cursor-agent create-chat` returned a UUID chat id.
- `--resume definitely-not-a-real-cursor-session` did not fail. Cursor accepted the arbitrary id, used it as the `session_id`, and persisted context across later turns with the same id.

Implication: LetAgents should allocate and store collision-resistant Cursor chat ids itself, or use `cursor-agent create-chat`, instead of treating `--resume` as validation that a chat already exists.

## Read-Only Modes

`--mode ask` and `--mode plan` refused file edits during probes. Both modes are suitable for a first read-only desktop-managed prototype.

Default Agent mode is not read-only:

- In a trusted workspace, default Agent mode created files successfully without `--force`.
- Explicit `--sandbox enabled` still allowed file edits in the workspace.

Implication: a write-capable managed Cursor runtime needs explicit permission-profile selection plus config/auth isolation. Avoiding `--force` alone is not sufficient.

## Shell And Sandbox Behavior

Default Agent mode without explicit sandbox rejected a `pwd` shell command in the observed headless run.

With `--sandbox enabled`:

- Shell commands executed in a workspace-readwrite sandbox.
- The stream included `requestedSandboxPolicy` with `TYPE_WORKSPACE_READWRITE`, `networkAccess: false`, and workspace read/write paths.
- A shell write to the user's home directory was denied.
- A shell write to `/tmp` succeeded.

Implication: Cursor's sandbox is useful but not a complete permission model. Writable paths and shell behavior must be treated as runtime contracts and covered by tests before sandboxed write is treated as lower-risk than full access.

## MCP Visibility And Room I/O

The local Cursor profile had a global LetAgents MCP server configured:

- `cursor-agent mcp list` reported `letagents: ready`.
- `cursor-agent mcp list-tools letagents` listed the LetAgents room/task tools.

In both `ask` mode and default Agent mode without `--force`, Cursor attempted to call `letagents.get_current_room`, but the MCP approval layer rejected it.

With `--force`, Cursor successfully called `letagents.get_current_room`.

`CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` alone did not hide the global LetAgents MCP config. Isolating `HOME` hid MCP config, but Cursor was no longer logged in and required `agent login` or `CURSOR_API_KEY`.

Implication: managed Cursor must never run with `--force` while global MCP config is visible unless the user explicitly chose normal Cursor MCP behavior and the permission profile is separately safe. The default managed policy should hide LetAgents MCP while still allowing non-LetAgents user MCP servers.

## Failure And Cancellation Semantics

Cancellation:

- Interrupting a long sandboxed shell turn with Ctrl-C exited the Cursor process with code `130`.
- No final `result` event was emitted.
- The child `sleep` process was not left running.

Nonzero tool failure:

- A `false` shell command produced a completed `tool_call` whose `shellToolCall.result.failure.exitCode` was `1`.
- The overall Cursor turn still ended with `result.subtype: "success"`.

Implication: runner code should treat process exit `130` without a final `result` as an expected interrupt/no-publish path, and should not mark the whole turn failed just because a tool call reports failure.

## Phase 0 Decision

Proceed with a read-only Cursor desktop-managed prototype:

- Use `cursor-agent -p --output-format stream-json --mode ask` or `--mode plan`.
- Prefer `cursor-agent`, with an explicit environment override for custom paths.
- Parse stream JSON events and capture the final `result`.
- Store and resume a managed Cursor chat id per session.
- Keep provider startability experimental/internal until gates below pass.

Original phase-0 decision: do not implement write-capable Cursor Agent mode until MCP/config isolation and runner behavior are proven. Gate 2 has since narrowed this: read-only remains default, `sandboxed_write` and `full_access` are explicit user choices, and `ask_before_write` remains gated until Cursor headless approval events can be bridged honestly.

## Gates Before Write-Capable Cursor

Write-capable Cursor was blocked until LetAgents had all of the following:

1. A provider-agnostic managed-agent permission path that can surface human Allow/Deny decisions in the desktop UI or room.
2. Config/auth isolation proving Cursor cannot see or call LetAgents room MCP tools directly.
3. A smoke test where the prompt asks Cursor to call LetAgents room tools and the run proves those tools are unavailable or denied.
4. Sandbox behavior tests covering workspace writes, home-directory denial, `/tmp` behavior, shell command execution, and cancellation.
5. Runner tests for stream parsing, malformed JSON lines, missing final result, nonzero process exit, tool-call failure, resume ids, and interrupt handling.

These gates remain the checklist for expanding Cursor beyond explicit write profiles. In particular, `ask_before_write` should not be exposed until the approval path is real rather than prompt copy.

## Gate 2 Follow-up

See `docs/cursor-desktop-managed-gate2.md` for the config/auth isolation probe. The short version: managed Cursor now has a Cursor MCP policy selector. The default `filter_letagents` mode uses an isolated home, copies the user's Cursor MCP config, removes LetAgents-looking MCP servers, and links the macOS login keychain into that managed home so normal Cursor auth works. `none` keeps the old empty-MCP behavior. `normal` uses the user's normal Cursor MCP setup as-is and warns that Cursor may access configured MCP tools directly. Cursor permission profiles are selected separately from MCP policy: `read_only` defaults to `--mode ask`, `sandboxed_write` maps to `--force --sandbox enabled`, and `full_access` maps to `--force --sandbox disabled`.
