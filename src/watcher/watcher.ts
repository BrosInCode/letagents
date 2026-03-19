#!/usr/bin/env node

/**
 * Let Agents Chat — Watcher (Auto-Trigger)
 *
 * Listens to the SSE stream for a project and auto-triggers an agent
 * when a new message arrives. This is a safety net for agents whose
 * long-polling (wait_for_messages) times out — the watcher re-triggers
 * them via GUI automation (cliclick + osascript on macOS).
 *
 * Usage:
 *   node src/watcher/watcher.js \
 *     --project proj_1 \
 *     --agent codex-agent \
 *     --server https://cautious-pigeon.outray.app \
 *     --app Codex
 *
 * Environment variables for click coordinates:
 *   CHAT_X  — X coordinate of the chat input (default: 759)
 *   CHAT_Y  — Y coordinate of the chat input (default: 705)
 */

import { spawnSync } from "child_process";

// ── CLI Args ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    project: "",
    agent: "",
    server: process.env.LETAGENTS_API_URL || "http://localhost:3001",
    app: "Codex",
    chatX: process.env.CHAT_X || "759",
    chatY: process.env.CHAT_Y || "705",
    triggerType: "applescript",
    debounceMs: 2000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--project":
        config.project = args[++i];
        break;
      case "--agent":
        config.agent = args[++i];
        break;
      case "--server":
        config.server = args[++i];
        break;
      case "--app":
        config.app = args[++i];
        break;
      case "--trigger":
        config.triggerType = args[++i];
        break;
    }
  }

  if (!config.project || !config.agent) {
    console.error("Usage: watcher --project <id> --agent <name> [--server <url>] [--app <name>]");
    process.exit(1);
  }

  return config;
}

const config = parseArgs();

console.log(`
╔══════════════════════════════════════════╗
║   Let Agents Chat — Watcher             ║
╚══════════════════════════════════════════╝
   Project: ${config.project}
   Agent:   ${config.agent}
   Server:  ${config.server}
   App:     ${config.app}
`);

// ── State ──────────────────────────────────────────────────────────

let lastTriggeredId: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isFirstConnection = true;

// ── AppleScript Trigger ────────────────────────────────────────────

function triggerAppleScript(query: string): boolean {
  try {
    // Activate the app
    spawnSync("osascript", ["-e", `tell application "${config.app}" to activate`], {
      timeout: 5000,
    });
    spawnSync("sleep", ["0.5"]);

    // Click the chat input
    const click = spawnSync("cliclick", [`c:${config.chatX},${config.chatY}`], {
      timeout: 5000,
      env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    });

    if (click.status !== 0) {
      console.error("  ✗ cliclick failed:", click.stderr?.toString().trim());
      return false;
    }

    spawnSync("sleep", ["0.3"]);

    // Type the message
    const type = spawnSync("cliclick", [`t:${query}`], {
      timeout: 10000,
      env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    });

    if (type.status !== 0) {
      console.error("  ✗ cliclick type failed:", type.stderr?.toString().trim());
      return false;
    }

    spawnSync("sleep", ["0.2"]);

    // Press Enter
    spawnSync("cliclick", ["kp:return"], {
      timeout: 5000,
      env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    });

    return true;
  } catch (err) {
    console.error("  ✗ Trigger error:", (err as Error).message);
    return false;
  }
}

function notifyFallback(sender: string, text: string): void {
  spawnSync("osascript", [
    "-e",
    `display notification "${text.slice(0, 100)}" with title "Let Agents Chat" subtitle "From: ${sender}"`,
  ], { timeout: 5000 });
}

// ── Mail Handler ───────────────────────────────────────────────────

interface MessageData {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
}

function onMessage(message: MessageData): void {
  // Skip own messages
  if (message.sender === config.agent) return;

  // Skip already-triggered messages
  if (message.id && message.id === lastTriggeredId) return;

  console.log(`\n📬 Mail for ${config.agent}!`);
  console.log(`  From: ${message.sender}`);
  console.log(`  Text: ${message.text.slice(0, 80)}${message.text.length > 80 ? "…" : ""}`);

  // Debounce rapid messages
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    lastTriggeredId = message.id;

    const query = `check messages on project ${config.project}`;
    console.log(`  ⚡ Triggering ${config.app}: "${query}"`);

    const success = triggerAppleScript(query);

    if (success) {
      console.log("  ✓ Triggered successfully");
    } else {
      console.log("  ✗ Trigger failed, sending notification");
      notifyFallback(message.sender, message.text);
    }
  }, config.debounceMs);
}

// ── SSE Connection ─────────────────────────────────────────────────

async function connectSSE(): Promise<void> {
  const url = `${config.server}/projects/${config.project}/messages/stream`;

  while (true) {
    console.log(`🔌 Connecting to ${url}...`);

    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      console.log("✅ Connected! Listening for messages...");
      isFirstConnection = false;

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex !== -1) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);

          // Extract data lines
          const dataLines = rawEvent
            .replace(/\r/g, "")
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());

          if (dataLines.length > 0) {
            try {
              const message = JSON.parse(dataLines.join("\n")) as MessageData;
              onMessage(message);
            } catch {
              // Not valid JSON (e.g. heartbeat), skip
            }
          }

          boundaryIndex = buffer.indexOf("\n\n");
        }
      }

      console.log("🔌 Connection closed by server");
    } catch (err) {
      const message = (err as Error).message;
      console.error(`❌ SSE error: ${message}`);
    }

    // Reconnect after 3 seconds
    console.log("⏳ Reconnecting in 3s...");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ── Start ──────────────────────────────────────────────────────────

connectSSE();
