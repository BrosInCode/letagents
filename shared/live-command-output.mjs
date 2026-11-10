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

// Other control characters a terminal does not print; a tab and a line end stay.
// eslint-disable-next-line no-control-regex
const UNPRINTED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Text as a terminal would show it: control sequences (colors, cursor moves)
 * are removed, and a line that a carriage return rewrote (a progress bar)
 * keeps only its last version. Other control characters are removed too.
 */
export function plainTerminalText(text) {
  return String(text)
    .replace(TERMINAL_CONTROL, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const start = line.lastIndexOf("\r");
      return (start >= 0 ? line.slice(start + 1) : line).replace(UNPRINTED_CONTROL, "");
    })
    .join("\n");
}

// PEM keys ("-----BEGIN RSA PRIVATE KEY-----") and armored PGP keys ("-----BEGIN PGP PRIVATE KEY BLOCK-----").
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END_LINE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
/** A line of a key's body: base64 characters only, perhaps indented (a key in a YAML or JSON file). */
const KEY_BODY_LINE = /^\s*[A-Za-z0-9+/]+={0,2}$/;
const HIDDEN_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";

/**
 * Redaction finds a private key only from its BEGIN line to its END line. A
 * tail can hold a key without one of them: the END line has not arrived yet,
 * or the cut left out the BEGIN line. Such a key is hidden here, from its
 * BEGIN line to the end of the text, or from the start of the text to its
 * END line. A whole key is left to the redaction that runs after this.
 */
export function hidePartialPrivateKeys(text) {
  let shown = String(text);
  const begins = [...shown.matchAll(PRIVATE_KEY_BEGIN)];
  const ends = [...shown.matchAll(PRIVATE_KEY_END)];
  const firstEnd = ends[0]?.index ?? -1;
  if (firstEnd >= 0 && !begins.some((begin) => begin.index < firstEnd)) {
    const lineEnd = shown.indexOf("\n", firstEnd);
    shown = `${HIDDEN_PRIVATE_KEY}\n${lineEnd >= 0 ? shown.slice(lineEnd + 1) : ""}`;
  }
  const lastBegin = [...shown.matchAll(PRIVATE_KEY_BEGIN)].at(-1)?.index ?? -1;
  if (lastBegin >= 0 && !PRIVATE_KEY_END_LINE.test(shown.slice(lastBegin))) {
    const lineStart = shown.lastIndexOf("\n", lastBegin) + 1;
    shown = `${shown.slice(0, lineStart)}${HIDDEN_PRIVATE_KEY}\n`;
  }
  return shown;
}

/**
 * A tail whose start was cut off can begin inside a key that is longer than
 * the tail: only body lines, without the BEGIN line and before the END line.
 * Such a run of body lines at the top of the tail is hidden. It counts as a
 * key body only with at least one long line of mixed-case base64, so a list
 * of hex hashes or short words stays.
 */
export function hideLeadingKeyBody(text) {
  const lines = String(text).split("\n");
  let run = 0;
  while (run < lines.length && KEY_BODY_LINE.test(lines[run])) run += 1;
  const looksLikeKey = lines.slice(0, run).some((line) => line.length >= 40 && /[A-Z]/.test(line) && /[a-z]/.test(line));
  if (!looksLikeKey) return String(text);
  return [HIDDEN_PRIVATE_KEY, ...lines.slice(run)].join("\n");
}

/**
 * The newest part of a command's output, as whole lines.
 * 1. While the command runs (`final` false), a line that is still being
 *    written is left out: it could hold the start of a secret that no
 *    redaction pattern can recognize until the line is complete.
 * 2. When anything before the tail is left out, the tail starts at the next
 *    line, for the same reason: a line that shows only its end could show
 *    only the end of a secret.
 * 3. A private key without its BEGIN or its END line is hidden (see
 *    hidePartialPrivateKeys), and so is a run of key body lines at the top
 *    of a cut tail (see hideLeadingKeyBody).
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
  return { text: hidePartialPrivateKeys(cut ? hideLeadingKeyBody(tail) : tail), cut };
}

/**
 * The command as the agent wrote it, without the login-shell wrapper that
 * some agents add: Codex reports `/bin/zsh -lc 'npm run dev'`. Single quotes
 * inside come back from the `'"'"'` form. A command that the wrapper quotes in
 * any other way stays whole.
 */
export function plainShellCommand(command) {
  const text = String(command ?? "");
  const match = /^(?:\/[\w./-]*\/)?(?:ba|z|da)?sh -l?c '((?:[^']|'"'"')*)'$/s.exec(text);
  return match ? match[1].replaceAll(`'"'"'`, "'") : text;
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
