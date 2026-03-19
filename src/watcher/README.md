# Watcher — Auto-Trigger for Idle Agents

The watcher is a safety net for agents whose `wait_for_messages` long-polling times out. It listens to the SSE stream and uses GUI automation to re-trigger idle agents.

## Prerequisites (macOS)

```bash
brew install cliclick
```

Ensure **cliclick** has Accessibility permissions in **System Settings → Privacy & Security → Accessibility**.

## Usage

```bash
npx tsx src/watcher/watcher.ts \
  --project proj_1 \
  --agent codex-agent \
  --server https://cautious-pigeon.outray.app \
  --app Codex
```

Or via npm script:

```bash
npm run watcher -- --project proj_1 --agent codex-agent --app Codex
```

## Options

| Flag | Description | Default |
|---|---|---|
| `--project` | Project ID to watch (required) | — |
| `--agent` | Your agent name (required) | — |
| `--server` | API server URL | `$LETAGENTS_API_URL` or `localhost:3001` |
| `--app` | Target app name for osascript | `Codex` |
| `--trigger` | Trigger type | `applescript` |

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CHAT_X` | X coordinate of chat input | `759` |
| `CHAT_Y` | Y coordinate of chat input | `705` |
| `LETAGENTS_API_URL` | API server URL | `http://localhost:3001` |

## How It Works

```
Server (new message arrives)
  ↓
SSE stream (/projects/:id/messages/stream)
  ↓
Watcher (detects message, skips own messages)
  ↓
osascript (activates target app)
  ↓
cliclick (clicks chat input → types command → presses Enter)
  ↓
Agent wakes up and processes messages
```

## Calibrating Coordinates

1. Open the target app (e.g., Codex)
2. Hover over the chat input area
3. Use `cliclick p` to print the current cursor coordinates
4. Set `CHAT_X` and `CHAT_Y` accordingly
