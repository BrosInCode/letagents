#!/usr/bin/env node
import {
  createCodexWakeHelper,
  inspectCodexWakeHelper,
  launchCodexWakeHelperProcess,
  runCodexWakeHelperLoop,
  stopCodexWakeHelper,
} from "./codex-wake-helper.js";
import { getStoredCodexWakeHelper } from "./local-state.js";

type ParsedArgs = Record<string, string | boolean>;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part?.startsWith("--")) {
      continue;
    }

    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function getStringArg(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberArg(args: ParsedArgs, key: string): number | undefined {
  const value = getStringArg(args, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  letagents-codex-helper start --room <invite-code|room-name> [--cwd <path>] [--wake-phrase <text>] [--stop-phrase <text>] [--max-minutes <n>] [--poll-timeout-ms <n>] [--codex-bin <path>]",
      "  letagents-codex-helper status [--helper-id <id>]",
      "  letagents-codex-helper stop [--helper-id <id>]",
    ].join("\n")
  );
  process.exit(1);
}

async function handleStart(args: ParsedArgs): Promise<void> {
  const room = getStringArg(args, "room");
  if (!room) {
    usage();
  }

  const created = await createCodexWakeHelper({
    room,
    cwd: getStringArg(args, "cwd"),
    wake_phrase: getStringArg(args, "wake-phrase"),
    stop_phrase: getStringArg(args, "stop-phrase"),
    max_minutes: getNumberArg(args, "max-minutes"),
    poll_timeout_ms: getNumberArg(args, "poll-timeout-ms"),
    codex_bin: getStringArg(args, "codex-bin"),
  });

  if (!created.reused) {
    launchCodexWakeHelperProcess(created.helper.helper_id);
  }

  const latest = getStoredCodexWakeHelper(created.helper.helper_id) ?? created.helper;
  process.stdout.write(`${JSON.stringify({ success: true, reused: created.reused, helper: latest }, null, 2)}\n`);
}

async function handleStatus(args: ParsedArgs): Promise<void> {
  const status = await inspectCodexWakeHelper(getStringArg(args, "helper-id"));
  if (!status) {
    process.stdout.write(`${JSON.stringify({ success: false, error: "No Codex wake helper found." }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ success: true, ...status }, null, 2)}\n`);
}

async function handleStop(args: ParsedArgs): Promise<void> {
  const stopped = await stopCodexWakeHelper({
    helper_id: getStringArg(args, "helper-id"),
  });
  if (!stopped) {
    process.stdout.write(`${JSON.stringify({ success: false, error: "No Codex wake helper found." }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ success: true, helper: stopped }, null, 2)}\n`);
}

async function handleRun(args: ParsedArgs): Promise<void> {
  const helperId = getStringArg(args, "helper-id");
  if (!helperId) {
    usage();
  }

  await runCodexWakeHelperLoop(helperId);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "start":
      await handleStart(args);
      return;
    case "status":
      await handleStatus(args);
      return;
    case "stop":
      await handleStop(args);
      return;
    case "run":
      await handleRun(args);
      return;
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
