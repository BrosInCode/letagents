import { readFileSync } from "node:fs";

import { letagentsUserAgent } from "../../shared/client-user-agent.mjs";

/**
 * The version of the letagents package this code was loaded from. Two levels
 * up from this file is the package root, in the source tree and in the built
 * package alike. Empty when the file cannot be read or is another package's.
 */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === "letagents" && typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

/** Sent with every request of the MCP client to the room server, for example `LetAgents-MCP/0.12.57 (darwin; arm64)`. */
export const MCP_USER_AGENT = letagentsUserAgent("MCP", packageVersion());
