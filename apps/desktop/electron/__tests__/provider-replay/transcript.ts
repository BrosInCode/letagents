import { readFileSync } from "node:fs";

/**
 * A provider replay transcript is a recording of the traffic between
 * LetAgents and one real provider runtime, taken at the transport boundary.
 * A test plays it back in place of the provider, so every line of our own
 * adapter code runs against what the provider really sent.
 *
 * The file is NDJSON, one entry per line, in the order the frames crossed
 * the wire:
 *
 *   transcript_start  what was recorded, and how
 *   expect_outbound   a frame LetAgents sent
 *   emit_inbound      a frame the provider sent
 *   runtime_exit      the provider runtime ended
 *
 * A transcript is never written or edited by hand. Only a recorder writes
 * one, and redaction is the only change a recorder makes to a frame.
 */
export const PROVIDER_REPLAY_FORMAT = 1;

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface TranscriptStartEntry {
  type: "transcript_start";
  format: typeof PROVIDER_REPLAY_FORMAT;
  provider: string;
  /** The wire protocol of the frames, for example `codex.app-server/websocket`. */
  protocol: string;
  providerVersion: string;
  scenario: string;
  /** How the recording was made. Free-form, for the reader. */
  capture: JsonObject;
}

export interface ExpectOutboundEntry {
  type: "expect_outbound";
  /** A name for the reader. The replay does not use it to match. */
  label?: string;
  frame: JsonObject;
}

export interface EmitInboundEntry {
  type: "emit_inbound";
  label?: string;
  frame: JsonObject;
}

export interface RuntimeExitEntry {
  type: "runtime_exit";
  /** LetAgents asked the runtime to stop before it ended. */
  requested: boolean;
  /**
   * The adapter saw the connection close before it saw the process exit.
   * The two are a race in a real runtime, and an adapter reacts to each.
   */
  transportClosedBeforeExit: boolean;
  code: number | null;
  signal: string | null;
}

export type ProviderReplayFrameEntry = ExpectOutboundEntry | EmitInboundEntry;
export type ProviderReplayEntry = ProviderReplayFrameEntry | RuntimeExitEntry;
/** An entry and the line of the file it came from. */
export type Located<Entry> = Entry & { readonly line: number };

export interface ProviderReplayTranscript {
  readonly source: string;
  readonly start: TranscriptStartEntry;
  /** Every entry after the header. The last one is always `runtime_exit`. */
  readonly entries: readonly Located<ProviderReplayEntry>[];
}

export class ProviderReplayTranscriptError extends Error {
  constructor(source: string, line: number, detail: string) {
    super(`${source}:${line}: ${detail}`);
    this.name = "ProviderReplayTranscriptError";
  }
}

const ENTRY_KEYS: Record<string, readonly string[]> = {
  transcript_start: ["type", "format", "provider", "protocol", "providerVersion", "scenario", "capture"],
  expect_outbound: ["type", "label", "frame"],
  emit_inbound: ["type", "label", "frame"],
  runtime_exit: ["type", "requested", "transportClosedBeforeExit", "code", "signal"],
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read a transcript, and refuse one that is not exactly the format above.
 * A recording that is silently misread would test nothing.
 */
export function parseProviderReplayTranscript(text: string, source = "<transcript>"): ProviderReplayTranscript {
  const lines = text.split("\n");
  // A file ends with one newline; that is not an empty entry.
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) throw new ProviderReplayTranscriptError(source, 1, "the transcript is empty");

  let start: TranscriptStartEntry | null = null;
  const entries: Located<ProviderReplayEntry>[] = [];
  let exitLine = 0;

  lines.forEach((raw, index) => {
    const line = index + 1;
    const fail = (detail: string): never => { throw new ProviderReplayTranscriptError(source, line, detail); };
    if (!raw.trim()) fail("empty line");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!isObject(parsed)) return fail("an entry must be a JSON object");
    const type = parsed.type;
    if (typeof type !== "string" || !Object.hasOwn(ENTRY_KEYS, type)) {
      return fail(`unknown entry type ${JSON.stringify(type)}`);
    }
    const unknownKey = Object.keys(parsed).find((key) => !ENTRY_KEYS[type]!.includes(key));
    if (unknownKey) fail(`unknown key ${JSON.stringify(unknownKey)} in a ${type} entry`);
    if (exitLine) fail(`an entry follows runtime_exit on line ${exitLine}`);

    if (type === "transcript_start") {
      if (line !== 1) fail("transcript_start must be the first line, and there is only one");
      if (parsed.format !== PROVIDER_REPLAY_FORMAT) fail(`unsupported format ${JSON.stringify(parsed.format)}`);
      for (const key of ["provider", "protocol", "providerVersion", "scenario"] as const) {
        if (!nonEmptyString(parsed[key])) fail(`transcript_start needs a ${key}`);
      }
      if (!isObject(parsed.capture)) fail("transcript_start needs a capture object");
      start = parsed as unknown as TranscriptStartEntry;
      return;
    }
    if (line === 1) fail("the first line must be transcript_start");

    if (type === "runtime_exit") {
      for (const key of ["requested", "transportClosedBeforeExit"] as const) {
        if (typeof parsed[key] !== "boolean") fail(`runtime_exit needs a boolean ${key}`);
      }
      if (parsed.code !== null && !Number.isInteger(parsed.code)) fail("runtime_exit code must be an integer or null");
      if (parsed.signal !== null && !nonEmptyString(parsed.signal)) fail("runtime_exit signal must be a name or null");
      exitLine = line;
    } else {
      if (!isObject(parsed.frame)) fail(`${type} needs a frame object`);
      if (parsed.label !== undefined && !nonEmptyString(parsed.label)) fail(`${type} label must be a non-empty string`);
    }
    entries.push({ ...(parsed as unknown as ProviderReplayEntry), line });
  });

  if (!start) throw new ProviderReplayTranscriptError(source, 1, "the first line must be transcript_start");
  if (!exitLine) throw new ProviderReplayTranscriptError(source, lines.length, "the transcript must end with runtime_exit");
  return { source, start, entries };
}

export function loadProviderReplayTranscript(path: string): ProviderReplayTranscript {
  return parseProviderReplayTranscript(readFileSync(path, "utf8"), path);
}

/** The exact text a recorder writes: one entry per line, the header first. */
export function serializeProviderReplayTranscript(
  start: TranscriptStartEntry,
  entries: readonly ProviderReplayEntry[],
): string {
  return [start, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/** How many entries of each type a transcript holds, the header included. */
export function countProviderReplayEntries(transcript: ProviderReplayTranscript): Record<string, number> {
  const counts: Record<string, number> = { transcript_start: 1, expect_outbound: 0, emit_inbound: 0, runtime_exit: 0 };
  for (const entry of transcript.entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  return counts;
}
