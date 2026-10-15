/**
 * The one-line description of what a supervised agent is doing. The desktop
 * shows it to the agent's owner in the live strip, and the daemon publishes the
 * same line to the room so every member sees it in the agent's presence.
 */
import { readableContributionText } from "./contribution-text.mjs";

/** Longest live-activity echo shown in the room work indicator. */
export const LIVE_ACTIVITY_ECHO_MAX_LENGTH = 100;
/** Longest activity summary a worker may publish into its room presence. */
export const LIVE_ACTIVITY_SUMMARY_MAX_LENGTH = 120;

/** An agent waiting on its model provider is not working, and looks stuck
 * unless its owner is told. The adapter sends this as a `provider_event`,
 * which the daemon treats as ordinary activity; it is the one such event
 * shown. */
export const PROVIDER_RETRY_METHOD = "letagents/providerretry";
const PROVIDER_RETRY_SUMMARY = /^The model provider returned an error\. Retrying \(attempt \d{1,3}\)\.$/;

/** A Claude turn that stays open for background work it started is not thinking, and looks stuck unless its
 * owner is told what it waits for and for how long. The adapter sends this as a `provider_event` too. */
export const BACKGROUND_WORK_METHOD = "letagents/backgroundwork";
const BACKGROUND_WORK_SUMMARY = /^(?:Waiting for (?:a sub-agent|sub-agents) to finish \((?:under 1 min|\d{1,4} min)\): "[^\n]{1,600}\.|Waiting up to \d{1,3} min for (?:a background command|background commands|background work): "[^\n]{1,400}\.|Waiting for Claude's answer about background work that ended (?:under 1 min|\d{1,4} min) ago\.)$/;

// C0/C1 controls, zero-width marks and bidirectional overrides: none belongs in one line of room text.
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;

/** Provider transport/account notifications remain in diagnostics, but they
 * are not evidence that an agent is doing work for the room. */
export function isHumanVisibleSupervisorActivity(event) {
  const method = event.method.trim().toLowerCase();
  if (
    method === "account/ratelimits/updated"
    || method === "account/ratelimitsupdated"
    || method === "thread/read"
  ) return false;
  if (method === PROVIDER_RETRY_METHOD || method === BACKGROUND_WORK_METHOD) return true;
  return event.kind !== "usage" && event.kind !== "provider_event";
}

/** Translate provider-native events into stable product language. The exact
 * provider method remains available in Activity/diagnostics, but Chat should
 * describe what the agent is doing rather than expose a protocol trace. */
export function humanFacingSupervisorActivitySummary(event) {
  const kind = event.kind.trim().toLowerCase();
  const method = event.method.trim().toLowerCase();
  if (method === PROVIDER_RETRY_METHOD) {
    // Only the adapter's own sentence is shown. Anything else under this
    // method gets fixed copy, so provider text cannot be shown here.
    const summary = event.summary.trim();
    return PROVIDER_RETRY_SUMMARY.test(summary) ? summary : "Waiting for the model provider";
  }
  if (method === BACKGROUND_WORK_METHOD) {
    // The adapter's sentence, with the model's own short description of the work. Anything else gets fixed copy.
    const summary = event.summary.trim();
    return BACKGROUND_WORK_SUMMARY.test(summary) ? liveActivityEchoText(summary) : "Waiting for background work to finish";
  }
  if (method === "item/reasoning/summarytextdelta") {
    // The Codex adapter places only the provider-approved reasoning summary in
    // this field. Older/fallback daemon events contain the protocol label, so
    // keep the calm generic copy until a real summary arrives.
    const summary = event.summary.trim();
    if (summary && !/^[\w-]+\s*·\s*item\/reasoning\/summarytextdelta$/i.test(summary)) {
      return liveActivityEchoText(summary);
    }
    return "Thinking through the request";
  }
  return fixedActivitySentence(kind, method) ?? liveActivityEchoText(event.summary);
}

/** Product language for an event kind or method, or null when only its own text describes it. */
function fixedActivitySentence(kind, method) {
  if (method.includes("reasoning") || method.includes("thinking")) return "Thinking through the request";
  if (kind === "text_delta" || method.includes("agentmessage") || method === "assistant") return "Writing a response";
  if (kind === "tool_lifecycle" || /(?:toolcall|tool_use|websearch|filechange)/i.test(method)) return "Using a tool";
  if (kind === "command_output" || /(?:command|process|terminal)/i.test(method)) return "Working in the project";
  // The provider's own review decides these; nobody is being asked.
  if (/(?:autoapprovalreview|guardianwarning)/.test(method)) return "Checking an action";
  if (kind === "approval") return "Waiting for approval";
  if (kind === "turn_lifecycle" || kind === "item_lifecycle") return "Thinking";
  return null;
}

/**
 * Last-mile guard for the live-activity echo. The daemon already sanitizes and
 * redacts native activity, but the echo is human-facing in a shared room, so
 * collapse whitespace/control characters to a single line and length-bound it
 * to keep the indicator unobtrusive and prevent any multi-line payload from
 * widening the row.
 */
export function liveActivityEchoText(summary) {
  const collapsed = (summary ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "Working in the room.";
  if (collapsed.length <= LIVE_ACTIVITY_ECHO_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, LIVE_ACTIVITY_ECHO_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The line the other members of the room may see. The owner's line can quote
 * provider text (a background command, a plan, a notice), and such text can
 * hold credentials, hosts or names. Here only fixed product sentences pass,
 * with one exception: the Codex reasoning summary, which the owner wants the
 * room to see. The caller redacts credentials in it first;
 * publicLiveActivitySummary then reduces its paths.
 */
export function roomVisibleSupervisorActivitySummary(event) {
  const kind = event.kind.trim().toLowerCase();
  const method = event.method.trim().toLowerCase();
  if (method === PROVIDER_RETRY_METHOD) {
    const summary = event.summary.trim();
    return PROVIDER_RETRY_SUMMARY.test(summary) ? summary : "Waiting for the model provider";
  }
  if (method === BACKGROUND_WORK_METHOD) return roomVisibleBackgroundWork(event.summary.trim());
  if (method === "item/reasoning/summarytextdelta") {
    const summary = event.summary.trim();
    if (summary && !/^[\w-]+\s*·\s*item\/reasoning\/summarytextdelta$/i.test(summary)) return summary;
    return "Thinking through the request";
  }
  // Free text of any other event kind (a plan, a notice) stays with the owner.
  return fixedActivitySentence(kind, method) ?? "Working";
}

/** Only the kind of wait and its duration; never the command or the work it describes. */
function roomVisibleBackgroundWork(summary) {
  if (!BACKGROUND_WORK_SUMMARY.test(summary)) return "Waiting for background work to finish";
  const agents = /^Waiting for (a sub-agent|sub-agents) to finish \((under 1 min|\d{1,4} min)\): /.exec(summary);
  if (agents) return `Waiting for ${agents[1]} to finish (${agents[2]})`;
  const commands = /^Waiting up to (\d{1,3}) min for (a background command|background commands|background work): /.exec(summary);
  if (commands) return `Waiting for ${commands[2]} (up to ${commands[1]} min)`;
  const answer = /^Waiting for Claude's answer about background work that ended (?:under 1 min|\d{1,4} min) ago\.$/.exec(summary);
  return answer ? summary : "Waiting for background work to finish";
}

/** Cut a line to `max` UTF-16 units with an ellipsis, never through a surrogate pair. */
export function boundLiveActivityLine(line, max = LIVE_ACTIVITY_SUMMARY_MAX_LENGTH) {
  if (line.length <= max) return line;
  let cut = line.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** One line of room text: no controls or invisible marks, whitespace collapsed. Null when nothing is left. */
export function cleanLiveActivityLine(value) {
  if (typeof value !== "string") return null;
  const line = value.replace(INVISIBLE_OR_CONTROL, " ").replace(/\s+/g, " ").trim();
  return line || null;
}

/**
 * The text a worker publishes into its room presence. The owner's echo can
 * name local files, so machine paths become their file names, as in end-of-turn
 * summaries. The result is one line of at most LIVE_ACTIVITY_SUMMARY_MAX_LENGTH
 * UTF-16 units, or null.
 */
export function publicLiveActivitySummary(value) {
  const line = cleanLiveActivityLine(value);
  if (!line) return null;
  // A large limit: the line is already short, and the helper drops a cut sentence.
  const readable = cleanLiveActivityLine(readableContributionText(line, 10_000));
  return readable ? boundLiveActivityLine(readable) : null;
}
