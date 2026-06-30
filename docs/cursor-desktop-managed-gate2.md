# Cursor Desktop Managed Agents - Gate 2 Isolation Findings

Date: 2026-06-30

Status: blocked on Cursor auth bootstrap. Cursor write-capable profiles must stay gated.

This note records the Gate 2 probes for managed Cursor config/auth isolation. The goal is to prove that a desktop-managed Cursor session can run without seeing or calling LetAgents MCP room/control-plane tools. The desktop app should own room I/O; Cursor should only receive desktop-delivered prompts and return text to the supervisor.

## Tested Runtime

- `cursor-agent` resolved to `~/.local/bin/cursor-agent`.
- Cursor Agent version: `2026.06.26-7079533`.
- `cursor-agent about` reported the local account as Pro under the normal user home.
- `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_CONFIG_DIR`, and `CURSOR_DATA_DIR` were not set in the shell environment during this probe.

## Probe Results

Default user home still exposes LetAgents MCP:

```sh
cursor-agent mcp list
# letagents: ready
```

`CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` are not sufficient isolation boundaries. Cursor still found the global `~/.cursor/mcp.json`:

```sh
tmp_config=$(mktemp -d)
tmp_data=$(mktemp -d)
CURSOR_CONFIG_DIR="$tmp_config" \
CURSOR_DATA_DIR="$tmp_data" \
  cursor-agent mcp list
rm -rf "$tmp_config" "$tmp_data"

# letagents: ready
```

Isolating `HOME` and XDG paths hides the global MCP config:

```sh
tmp_home=$(mktemp -d)
HOME="$tmp_home" \
XDG_CONFIG_HOME="$tmp_home/.config" \
XDG_DATA_HOME="$tmp_home/.local/share" \
  cursor-agent mcp list
code=$?
rm -rf "$tmp_home"
exit $code

# No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)
```

But the same isolated home is not authenticated:

```sh
tmp_home=$(mktemp -d)
HOME="$tmp_home" \
XDG_CONFIG_HOME="$tmp_home/.config" \
XDG_DATA_HOME="$tmp_home/.local/share" \
  cursor-agent status
rm -rf "$tmp_home"

# Not logged in
```

And an isolated read-only prompt fails without an API key, auth token, or a login bootstrap:

```sh
tmp_home=$(mktemp -d)
HOME="$tmp_home" \
XDG_CONFIG_HOME="$tmp_home/.config" \
XDG_DATA_HOME="$tmp_home/.local/share" \
  cursor-agent -p --output-format stream-json --mode ask --trust \
  --workspace "$PWD" \
  "Reply exactly ISOLATED_CURSOR_OK"
code=$?
rm -rf "$tmp_home"
exit $code

# Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.
```

Cursor also reports `CURSOR_AUTH_TOKEN` as an accepted auth path:

```sh
tmp_home=$(mktemp -d)
HOME="$tmp_home" \
XDG_CONFIG_HOME="$tmp_home/.config" \
XDG_DATA_HOME="$tmp_home/.local/share" \
  cursor-agent models
code=$?
rm -rf "$tmp_home"
exit $code

# Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
```

An isolated-home browser login bootstrap is available, but it requires user action:

```sh
tmp_home=$(mktemp -d)
NO_OPEN_BROWSER=1 \
HOME="$tmp_home" \
XDG_CONFIG_HOME="$tmp_home/.config" \
XDG_DATA_HOME="$tmp_home/.local/share" \
  cursor-agent login

# Starting login process...
# Authenticating with Cursor...
# Waiting for browser authentication...
# Open a browser and navigate to this link: https://cursor.com/loginDeepControl?...
```

Do not paste the login URL or any Cursor tokens into a room. The desktop app should own this bootstrap if LetAgents chooses the managed-home auth path.

## Conclusion

Gate 2 is only half-proven:

- Proven: managed Cursor must isolate `HOME` (and set `XDG_CONFIG_HOME` / `XDG_DATA_HOME`) to hide `~/.cursor/mcp.json`.
- Proven: `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` alone do not hide global MCP config.
- Not proven: an isolated managed Cursor session can complete an authenticated turn, because this environment has no `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`, and the isolated-home login flow needs user authorization.

## Required Next Decision

Pick one supported auth bootstrap before write-capable Cursor can proceed:

1. **Environment-token path:** require `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` for managed Cursor and pass it only to the Cursor child process.
2. **Managed-home login path:** create a dedicated LetAgents Cursor home, run `cursor-agent login` inside that isolated home, and reuse that home for managed Cursor sessions.

Either path still needs a smoke test that runs with isolated `HOME` and proves:

- `cursor-agent mcp list` does not show `letagents`.
- `cursor-agent mcp list-tools letagents` fails.
- A prompt asking Cursor to enumerate or call LetAgents room tools reports that they are unavailable.
- A normal read-only prompt still succeeds.

Until that end-to-end smoke passes, keep Cursor `ask_before_write`, `sandboxed_write`, and `full_access` permission profiles gated.

