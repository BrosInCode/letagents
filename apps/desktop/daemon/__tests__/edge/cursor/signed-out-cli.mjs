// A stand-in for the `cursor-agent` program in the daemon edge tests: a Cursor
// that is installed and not signed in. The daemon finds it by
// LETAGENTS_CURSOR_AGENT_BIN.
//
// Before each Cursor turn the daemon proves the live Cursor account against
// the real Cursor service, and the host of that proof is fixed on purpose. So
// an offline test cannot run a Cursor turn. This stand-in gives the one result
// that needs no network: the daemon asks who is signed in, and the answer is
// "nobody". The turn must then not start.
//
// It answers the two checks the daemon makes before a turn, in the words of
// the real program:
//
//   mcp list              the one MCP server of the profile, as ready
//   status --format json  not signed in
//
// Any other start is a turn, which must never come. It ends with exit code 70.
//
// The daemon runs these checks in a sandbox that permits writes in the
// Cursor profile only, so the stand-in keeps its notes there, and only when
// it can: `$HOME/edge-cursor-calls.ndjson`, one line for each start.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Exit code for "the daemon started what this stand-in does not play". No cursor-agent exit uses it. */
const UNEXPECTED_START_EXIT_CODE = 70;

const argv = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE || "";

function note(kind) {
  try {
    appendFileSync(join(home, "edge-cursor-calls.ndjson"), `${JSON.stringify({ kind, argv })}\n`);
  } catch {
    // The sandbox or a missing profile refused the write. The test reads the daemon, not this file.
  }
}

const at = (name) => argv.indexOf(name);

if (at("mcp") >= 0 && argv[at("mcp") + 1] === "list") {
  note("mcp_list");
  // The daemon accepts exactly one line: the server it wrote into this profile, reported as ready.
  let alias = "letagents";
  try {
    const config = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    alias = Object.keys(config.mcpServers ?? {})[0] ?? alias;
  } catch {
    // No profile config: answer with the default name, and the daemon decides.
  }
  process.stdout.write(`${alias}: ready\n`);
} else if (at("status") >= 0) {
  note("status");
  process.stdout.write(`${JSON.stringify({ status: "unauthenticated", isAuthenticated: false })}\n`);
} else {
  note("unexpected_start");
  process.stderr.write("cursor stand-in: the daemon started a turn for a Cursor that is not signed in\n");
  process.exitCode = UNEXPECTED_START_EXIT_CODE;
}
