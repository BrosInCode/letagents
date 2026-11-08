/**
 * Live command output: the newest lines of a command that an agent runs, as
 * the owner's Live tab shows them while the command runs. The daemon, the
 * provider adapters and the renderer read these with the same code.
 *
 * Two kinds of event carry it on the agent's live feed:
 * 1. `item/toolCall/updated` with `outputProgress: true`: a shell tool call
 *    that still runs, with the newest part of its output.
 * 2. `item/backgroundCommand/updated`: a command that the agent started in
 *    the background, with its state and the newest part of its output.
 * Each event is a latest value: a newer event of the same command takes its
 * place (see AgentStreamRegistry.pushLatest).
 */

/** The longest output tail one event carries, in UTF-16 units. */
export const LIVE_OUTPUT_TAIL_CHARS = 6_000;

/** The state of a command that an agent started in the background. */
export const LIVE_BACKGROUND_COMMAND_METHOD = "item/backgroundCommand/updated";

// CSI and OSC sequences, and the remaining two-byte escapes.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * Text as a terminal would show it: control sequences (colors, cursor moves)
 * are removed, and a line that a carriage return rewrote (a progress bar)
 * keeps only its last version.
 */
export function plainTerminalText(text) {
  return String(text)
    .replace(TERMINAL_CONTROL, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const start = line.lastIndexOf("\r");
      return start >= 0 ? line.slice(start + 1) : line;
    })
    .join("\n");
}

/**
 * The newest part of a command's output, as whole lines.
 * 1. While the command runs (`final` false), a line that is still being
 *    written is left out: it could hold the start of a secret that no
 *    redaction pattern can recognize until the line is complete.
 * 2. When anything before the tail is left out, the tail starts at the next
 *    line, for the same reason: a line that shows only its end could show
 *    only the end of a secret.
 */
export function liveOutputTail(text, options = {}) {
  const maxChars = options.maxChars ?? LIVE_OUTPUT_TAIL_CHARS;
  let tail = String(text);
  if (!options.final) {
    const lastLineEnd = tail.lastIndexOf("\n");
    tail = lastLineEnd >= 0 ? tail.slice(0, lastLineEnd + 1) : "";
  }
  let cut = options.cut === true;
  if (tail.length > maxChars) {
    tail = tail.slice(-maxChars);
    cut = true;
  }
  if (cut) {
    const lineEnd = tail.indexOf("\n");
    tail = lineEnd >= 0 ? tail.slice(lineEnd + 1) : "";
  }
  return { text: tail, cut };
}

/** The feed key of a live output event, or null for any other event. */
export function liveOutputLatestKey(event) {
  const payload = event?.payload;
  if (event?.method !== "item/toolCall/updated" || !payload || typeof payload !== "object") return null;
  if (payload.outputProgress !== true || typeof payload.callID !== "string" || !payload.callID) return null;
  return `output:${payload.callID}`;
}

/** The feed key of a background command event, or null for any other event. */
export function liveBackgroundLatestKey(event) {
  const payload = event?.payload;
  if (event?.method !== LIVE_BACKGROUND_COMMAND_METHOD || !payload || typeof payload !== "object") return null;
  return typeof payload.taskId === "string" && payload.taskId ? `background:${payload.taskId}` : null;
}
