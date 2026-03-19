// ---------------------------------------------------------------------------
// Task 4: .letagents.json Config Reader
// ---------------------------------------------------------------------------
// Searches for `.letagents.json` in CWD and parent directories (up to root).
// Parses the config and returns the room name if found.
//
// Config format:
//   { "room": "github.com/EmmyMay/letagents" }

import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";

export interface LetagentsConfig {
  room: string;
}

const CONFIG_FILENAME = ".letagents.json";

/**
 * Search for `.letagents.json` starting from `startDir` and walking up
 * to the filesystem root. Returns the parsed config or null if not found.
 */
export function findLetagentsConfig(
  startDir?: string
): LetagentsConfig | null {
  let dir = resolve(startDir || process.cwd());
  const root = dirname(dir) === dir ? dir : "/"; // filesystem root

  // Walk up directory tree looking for config file
  for (let depth = 0; depth < 50; depth++) {
    const configPath = join(dir, CONFIG_FILENAME);

    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);

        // Validate required fields
        if (typeof parsed.room === "string" && parsed.room.trim() !== "") {
          return { room: parsed.room.trim() };
        }

        // Config exists but is malformed — log and continue
        console.error(
          `[letagents] Found ${configPath} but missing valid "room" field`
        );
        return null;
      } catch (err) {
        console.error(`[letagents] Error reading ${configPath}:`, err);
        return null;
      }
    }

    // Move up one directory
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return null;
}

/**
 * Get the room name from `.letagents.json` config.
 * Returns the room string or null if no config found.
 */
export function getRoomFromConfig(startDir?: string): string | null {
  const config = findLetagentsConfig(startDir);
  return config?.room ?? null;
}
