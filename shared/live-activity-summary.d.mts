export const LIVE_ACTIVITY_ECHO_MAX_LENGTH: 100;
export const LIVE_ACTIVITY_SUMMARY_MAX_LENGTH: 120;
export const PROVIDER_RETRY_METHOD: "letagents/providerretry";
export const BACKGROUND_WORK_METHOD: "letagents/backgroundwork";
export type LiveActivityEventShape = { kind: string; method: string; summary: string };
/** Provider transport/account notifications are not evidence of room work. */
export function isHumanVisibleSupervisorActivity(event: Pick<LiveActivityEventShape, "kind" | "method">): boolean;
/** Provider-native events in stable product language. */
export function humanFacingSupervisorActivitySummary(event: LiveActivityEventShape): string;
/** The line other room members may see: fixed sentences, or the (caller-redacted) Codex reasoning summary. */
export function roomVisibleSupervisorActivitySummary(event: LiveActivityEventShape): string;
/** Cut to `max` UTF-16 units (default 120) with an ellipsis. */
export function boundLiveActivityLine(line: string, max?: number): string;
/** One bounded line for the owner's live strip. */
export function liveActivityEchoText(summary: string | null | undefined): string;
/** One line without control or invisible characters, or null when empty. */
export function cleanLiveActivityLine(value: unknown): string | null;
/** Path-stripped, one-line, length-bounded text for room presence, or null. */
export function publicLiveActivitySummary(value: unknown): string | null;
