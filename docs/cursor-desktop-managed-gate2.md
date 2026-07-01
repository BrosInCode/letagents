# Cursor Desktop Managed Agents - Gate 2 Isolation Findings

Date: 2026-06-30

Status: passed for macOS desktop-managed Cursor MCP isolation and workspace-write smoke coverage. Read-only remains the default; `sandboxed_write` and `full_access` are selectable permission profiles, while `ask_before_write` stays gated until headless approval events can be bridged.

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

But the same isolated home is not authenticated by itself:

```sh
tmp_home=$(mktemp -d)
HOME="$tmp_home" \
XDG_CONFIG_HOME="$tmp_home/.config" \
XDG_DATA_HOME="$tmp_home/.local/share" \
  cursor-agent status
rm -rf "$tmp_home"

# Not logged in
```

And an isolated read-only prompt fails without an API key, auth token, login bootstrap, or access to Cursor's macOS credential store:

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

On macOS, Cursor's normal login can be reused without exposing LetAgents MCP by using a managed home with:

- a copied `~/.cursor/cli-config.json`;
- a copied `~/.cursor/agent-cli-state.json`;
- a managed `~/.cursor/mcp.json`;
- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `CURSOR_CONFIG_DIR`, and `CURSOR_DATA_DIR` pointed inside the managed profile;
- `~/Library/Keychains` linked into the managed home so Cursor can read the user's macOS login keychain.

The original Gate 2 probe used an empty managed MCP config. The current product default is `filter_letagents`: copy the user's Cursor MCP config into the managed profile, remove only LetAgents-looking servers, and preserve other MCP servers. Users can explicitly choose `none` for the old empty-MCP behavior or `normal` to let Cursor use its normal MCP setup as-is. The Cursor sandbox flag does not prove that external MCP tools are sandboxed; preserved MCP servers may have their own filesystem, network, or credential behavior.

With that environment:

```sh
cursor-agent status
# ✓ Logged in as lekeemmy@gmail.com

cursor-agent mcp list
# No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)

cursor-agent mcp list-tools letagents
# Failed to list tools: Failed to load MCP 'letagents': MCP client "letagents" not found in config

cursor-agent -p --output-format stream-json --mode ask --trust \
  --workspace "$PWD" \
  "Reply exactly ISOLATED_CURSOR_OK and do not call any tools."
# result: ISOLATED_CURSOR_OK
```

The adversarial prompt also passed:

```text
Prompt: Try to list or call the LetAgents MCP tools, especially get_current_room.
Result: Cursor reported no LetAgents-specific tools, `ListMcpResources` returned an empty list, and no `letagents-*` tool call was emitted.
```

The repeatable local smoke for this proof is:

```sh
cd apps/desktop
npm run smoke:cursor-managed -- --workspace ../..
```

That default smoke uses `--mcp-policy filter_letagents` and `--permission-profile read_only`. Optional policy probes:

```sh
npm run smoke:cursor-managed -- --workspace ../.. --mcp-policy none
npm run smoke:cursor-managed -- --workspace ../.. --mcp-policy normal
npm run smoke:cursor-managed -- --workspace ../.. --permission-profile sandboxed_write
npm run smoke:cursor-managed -- --workspace ../.. --permission-profile full_access
```

Expected result for `filter_letagents`:

- `cursor-agent status` succeeds in the managed profile.
- `cursor-agent mcp list` does not mention LetAgents.
- `cursor-agent mcp list-tools letagents` fails with no LetAgents MCP client.
- a normal read-only Cursor turn returns `MANAGED_CURSOR_READONLY_OK`.
- an adversarial LetAgents MCP prompt returns `LETAGENTS_MCP_UNAVAILABLE` without emitting a LetAgents-looking stream event.
- with `sandboxed_write` or `full_access`, an additional workspace-write smoke turn creates then removes `.letagents/cursor-managed-write-smoke.txt`.

Expected policy differences:

- `none`: no MCP servers should be visible.
- `normal`: Cursor may show LetAgents or any other configured MCP server; this mode warns but does not fail just because LetAgents is present.

An isolated-home browser login bootstrap is also available, but it requires user action:

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

Do not paste the login URL or any Cursor tokens into a room. The desktop app should own this bootstrap if LetAgents chooses this path for non-macOS hosts.

## Conclusion

Gate 2 is proven for the current macOS desktop-managed path:

- Proven: managed Cursor must isolate `HOME` (and set `XDG_CONFIG_HOME` / `XDG_DATA_HOME`) to hide `~/.cursor/mcp.json`.
- Proven: `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` alone do not hide global MCP config.
- Proven: macOS Cursor auth can be preserved by linking the login keychain into the managed home while still hiding global Cursor MCP config.
- Proven: `cursor-agent mcp list` does not show `letagents`, `list-tools letagents` fails, and an adversarial prompt cannot call LetAgents MCP tools.
- Proven: write-capable profiles can complete a workspace-write smoke turn.
- Current default: managed Cursor filters LetAgents MCP out of a copied user MCP config instead of disabling every non-LetAgents MCP server.
- Current permission default: managed Cursor starts read-only unless the user explicitly selects `sandboxed_write` or `full_access`.
- Not proven: general Cursor sandbox safety for external MCP tools, network behavior, all out-of-workspace paths, or user-interrupted write turns.
- Remaining: non-macOS hosts need either `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, or a user-approved managed-home `cursor-agent login`.

## Implemented Desktop Runtime Contract

Managed Cursor launches now use:

- Permission profile selector:
  - `read_only` (default): `cursor-agent -p --output-format stream-json --mode ask --trust --workspace <repo>`.
  - `sandboxed_write`: `cursor-agent -p --output-format stream-json --trust --workspace <repo> --force --sandbox enabled`. Cursor's sandbox applies to Cursor operations; selected MCP tools still follow the chosen MCP policy.
  - `full_access`: `cursor-agent -p --output-format stream-json --trust --workspace <repo> --force --sandbox disabled`. Use only with trusted repositories and trusted MCP configurations.
  - `ask_before_write`: still gated because Cursor headless approval prompts are not bridged into the desktop or room.
- MCP policy selector:
  - `filter_letagents` (default): managed profile, copied user Cursor MCP config, LetAgents-looking servers removed.
  - `none`: managed profile, empty managed Cursor MCP config at `<managed home>/.cursor/mcp.json`, and no project-level MCP entries.
  - `normal`: no managed MCP override; Cursor uses the user's normal MCP setup as-is.
- managed home for managed policies: `<LetAgents state dir>/cursor-managed/home`
- managed config dir for managed policies: `<LetAgents state dir>/cursor-managed/config`
- managed data dir for managed policies: `<LetAgents state dir>/cursor-managed/data`
- managed cache dir for managed policies: `<LetAgents state dir>/cursor-managed/cache`
- macOS keychain link for managed policies: `<managed home>/Library/Keychains -> ~/Library/Keychains`
- sanitized child environment: Cursor receives only an allowlisted environment for process basics, managed `HOME`/XDG paths, and Cursor-specific auth/config variables. Generic ambient credentials such as LetAgents, GitHub, cloud, and package-manager tokens are not inherited.

The runtime rejects workspaces that have a project-level `.cursor/mcp.json` mentioning LetAgents for `filter_letagents`, and rejects any project-level MCP entries for `none`, because Cursor merges project MCP config with home MCP config. The explicit `normal` policy allows normal Cursor MCP behavior and warns that Cursor may access configured MCP tools directly.

## Remaining Gates

Keep Cursor `ask_before_write` gated until Cursor exposes approval events cleanly enough for desktop/room Allow/Deny. Continue treating `sandboxed_write` and `full_access` as explicit user choices with high-visibility risk copy and live smoke coverage because they run with `--force`.
