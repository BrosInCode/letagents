export const LIVE_OUTPUT_TAIL_CHARS: number;
export const LIVE_BACKGROUND_COMMAND_METHOD: "item/backgroundCommand/updated";

/** How a background command stands. `lost`: its agent's runtime ended before the command reported an end. */
export type LiveBackgroundCommandStatus = "running" | "completed" | "failed" | "stopped" | "lost";

/** The payload of one `item/backgroundCommand/updated` event. */
export type LiveBackgroundCommandPayload = {
  taskId: string;
  toolUseId: string | null;
  command: string;
  description: string | null;
  status: LiveBackgroundCommandStatus;
  /** The newest part of the output, as plain text. */
  output: string;
  /** Earlier output is left out. */
  outputTruncated: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
};

export function plainTerminalText(text: string): string;
export function hidePartialPrivateKeys(text: string): string;
export function hideLeadingKeyBody(text: string): string;
export function plainShellCommand(command: unknown): string;
export function liveOutputTail(text: string, options?: { cut?: boolean; final?: boolean; maxChars?: number }): { text: string; cut: boolean };
export function liveOutputLatestKey(event: { method: string; payload: unknown } | null | undefined): string | null;
export function liveBackgroundLatestKey(event: { method: string; payload: unknown } | null | undefined): string | null;
