# Cursor supervised approval gate

Verified: 2026-09-15, macOS, Cursor Agent `2026.07.09-a3815c0`.

`ask_before_write` remains unavailable. Cursor supports native ACP permission
requests, but enabling their transport does not make ordinary workspace edits
require approval. Existing Read-only, Workspace writes, and compatibility
profiles keep their current policies and defaults.

## Native evidence

A disposable native probe used the existing supervised Cursor profile and OS
containment, a private scratch workspace, and an inert local MCP fixture. The
LetAgents API URL pointed at an unused loopback port. No real room or project
was used. The normal Cursor login supplied provider authentication through the
existing supervised identity and credential proxy.

The experimental wrapper started `cursor-agent acp` with no `--force`, native
sandbox enabled, project configuration disabled, and an isolated permission
file containing only the exact fixture MCP allowlist. It performed:

1. `initialize` with protocol version 1 and client filesystem/terminal
   capabilities disabled.
2. `authenticate`, `session/new`, and `session/set_mode` to `agent`.
3. `session/prompt` asking the write tool to create only
   `approval-marker.txt` containing `CURSOR_APPROVED`.
4. Observation of every `session/request_permission`, without automatically
   answering one.

Cursor emitted an edit tool start and completion and created the marker.
**Permission requests observed before the edit: zero.** The overall probe was
stopped at its 90-second deadline without a terminal prompt response; this was
not a successful end-to-end supervised turn. The file write already disproved
approval-before-write enforcement.

The installed native `InteractivePermissionsService.shouldBlockWrite` checks
explicit denies, ignored/protected paths, and workspace boundaries. An ordinary
allowed workspace path falls through without requesting approval. Explicit
`Write` deny rules reject the operation outright; they are not an ask policy.

## Supported alternatives checked

- [ACP](https://prod.cursor.com/docs/cli/acp) provides
  `session/request_permission` with one-time allow and reject choices for
  operations that Cursor decides need approval.
- [CLI configuration](https://prod.cursor.com/docs/cli/reference/configuration)
  documents `allowlist`, `auto-review`, and `unrestricted`; none promises an
  approval for each workspace edit.
- [CLI permissions](https://prod.cursor.com/docs/cli/reference/permissions)
  expose allow and deny rules. Denial is not an interactive approval request.
- [The preToolUse hook](https://prod.cursor.com/docs/hooks#pretooluse) accepts
  `ask` in its schema, but Cursor explicitly documents that it is not enforced
  for this hook. `beforeShellExecution` cannot cover native file edits.

The experimental ACP bridge is not shipped. A mock proving that an approval
callback can be displayed and answered is insufficient to enable this profile.

## Requirement for enabling the profile

Native tests must demonstrate that ordinary file creation, modification,
deletion, and write-capable shell operations wait for an exact current approval;
that denial prevents the operation; and that stale decisions, interruption, and
restart cannot reuse approval. The same checks must retain the existing workspace,
credential, and room authority boundaries. Until then, both profile selection
and native spawn attestation must reject `ask_before_write`.
