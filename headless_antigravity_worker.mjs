#!/usr/bin/env node
/**
 * Headless Antigravity worker — targets CURSOR_HANDOFF.md "Final Test".
 *
 * 1) Find a usable language_server target:
 *      - workspace `--enable_lsp --workspace_id ...` LS when the repo is already open
 *      - otherwise the legacy core LS (no --enable_lsp)
 * 2) For core LS: StartCascade → SignalExecutableIdle({ conversationId }) → SendUserCascadeMessage
 *    (items + embedded cascadeConfig / model) → SendAllQueuedMessages
 *    For workspace LS: StartCascade → SendUserCascadeMessage (Deck-style stream POST)
 * 3) (Optional, core-only) Connect reactive stream while queueing — see ANTIGRAVITY_STREAM_METHODS
 * 4) Poll GetCascadeTrajectorySteps until steps appear or timeout
 * 5) Print the last assistant-style reply on stdout (rest on stderr if verbose)
 *
 * Model / quota (important):
 *   Values like `MODEL_GOOGLE_GEMINI_2_5_FLASH` are **protobuf `Model` enum names**
 *   compiled into `language_server_macos_arm_bin` — they are **not** the friendly
 *   names shown in the Antigravity chat picker (e.g. “Gemini 3.1”). The UI label and
 *   the enum string are related only by whatever Google’s server maps them to.
 *   `ANTIGRAVITY_MODEL` is exactly that enum string on the wire (`GetModelResponse`,
 *   `SendAllQueuedMessages`, etc.). `MODEL_PLACEHOLDER_M26` can route to a different
 *   SKU than your UI selection, which is why you can see a **429 on one model** while
 *   another still has quota. Use `--list-models` when the API returns configs; if it
 *   returns `{}`, inspect traffic from the real UI or ask Antigravity release notes for
 *   the enum that matches your picker entry.
 *
 * Usage:
 *   node headless_antigravity_worker.mjs
 *   node headless_antigravity_worker.mjs "What is 2+2? Only output the number."
 *   node headless_antigravity_worker.mjs --verbose "..."
 *   ANTIGRAVITY_MODEL=MODEL_PLACEHOLDER_M26 node headless_antigravity_worker.mjs
 *   ANTIGRAVITY_MAX_POLLS=60 ANTIGRAVITY_POLL_MS=2000 node headless_antigravity_worker.mjs
 *   ANTIGRAVITY_WORKSPACE_URI=file:///path/to/repo node headless_antigravity_worker.mjs
 *
 * Flags:
 *   --verbose   Log polls and JSON snippets to stderr
 *   --json      Print full last steps payload JSON to stdout (no text extraction)
 *   --direct    Skip cascade chat; call GetModelResponse (works headless today).
 *               Premium / third-party models still need the cascade path + stream.
 *   --workspace-ls Force the repo/workspace `--enable_lsp` server when available.
 *   --core-ls   Force the legacy core LS path.
 *   --no-stream Same as default today (Deck path has no StreamCascadeReactiveUpdates wrapper).
 *   --legacy-stream Re-enable experimental Connect wrap + multi-method loop (old handoff path).
 *   --list-models  Print live model configs for the selected target; then exit.
 *   --list-cascades  Print GetAllCascadeTrajectories for the selected LS; then exit.
 *   --resolve-cascade  If ANTIGRAVITY_CASCADE_ID is unset, pick an active cascade from
 *               GetAllCascadeTrajectories (Antigravity-Deck + Antigravity-Link patterns).
 *   --scan-all-ls  With ANTIGRAVITY_CASCADE_ID and/or --resolve-cascade: probe every LS
 *               process (ranked: matching workspace first) until the cascade appears or one
 *               is active — fixes wrong-port / wrong-instance sends.
 *
 * Env (cascade reuse / discovery):
 *   ANTIGRAVITY_CASCADE_ID   If set, skip StartCascade and send/poll this conversation.
 *   ANTIGRAVITY_RESOLVE_CASCADE=1  Same as --resolve-cascade when no cascade id in env.
 *   ANTIGRAVITY_SCAN_ALL_LS=1      Same as --scan-all-ls (requires id and/or resolve).
 *
 * Cascade payload (Antigravity-Deck — github.com/tysonnbt/Antigravity-Deck `src/cascade.js`):
 *   `plannerTypeConfig.case: "conversational"`, `planModel`, `requestedModel: { modelId }`.
 *   `SendUserCascadeMessage` is issued as a server-streaming HTTP POST (read full body), not
 *   unary + `SendAllQueuedMessages` unless `ANTIGRAVITY_ALSO_SEND_ALL_QUEUED=1`.
 *   Polling uses `GetCascadeTrajectorySteps` with `startIndex`/`endIndex` when supported.
 *
 * Long runs + LetAgents MCP/API polling + handoff for follow-up agents:
 *   docs/AGENT_HANDOFF_LONG_RUNS_AND_HEADLESS.md
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED =
  process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

import { fileURLToPath } from "node:url";
import path from "node:path";
import { main } from "./headless-antigravity/cli.mjs";

export { main } from "./headless-antigravity/cli.mjs";
export {
  extractAssistantReply,
  parseTrajectorySummaries,
  pickActiveCascadeIdFromMap,
} from "./headless-antigravity/cascade-parsing.mjs";

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
