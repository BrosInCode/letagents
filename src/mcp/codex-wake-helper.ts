import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  getCurrentCodexWakeHelper,
  getStoredAuth,
  getStoredCodexWakeHelper,
  saveCodexWakeHelper,
  saveRoomSession,
  updateCodexWakeHelper,
  type CodexWakeHelperState,
} from "./local-state.js";
import { inspectLocalCodexSession, startLocalCodexSession, stopLocalCodexSession } from "./codex-session.js";
import {
  encodeRoomIdPath,
  looksLikeInviteCode,
  normalizeInviteCode,
  type JoinedVia,
} from "./room-id.js";

const DEFAULT_API_URL = process.env.LETAGENTS_API_URL || "https://letagents.chat";
export const DEFAULT_WAKE_PHRASE = "/wake-codex-room";
export const DEFAULT_STOP_PHRASE = "/stop-codex-room";
export const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

interface HelperRoomState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
}

interface HelperMessagesPage {
  room_id?: string;
  messages?: HelperRoomMessage[];
}

interface HelperRoomMessage {
  id: string;
  sender?: string;
  text?: string;
  timestamp?: string;
}

export interface StartCodexWakeHelperInput {
  room: string;
  cwd?: string;
  wake_phrase?: string;
  stop_phrase?: string;
  max_minutes?: number;
  poll_timeout_ms?: number;
  codex_bin?: string;
}

export interface StartCodexWakeHelperResult {
  helper: CodexWakeHelperState;
  reused: boolean;
}

export interface CodexWakeHelperStatusResult {
  helper: CodexWakeHelperState;
  pid_running: boolean;
  session_status?: string | null;
}

export function toPublicCodexWakeHelper(helper: CodexWakeHelperState): Record<string, unknown> {
  return {
    helper_id: helper.helper_id,
    room_id: helper.room_id,
    room_code: helper.room_code ?? null,
    room_display_name: helper.room_display_name ?? null,
    joined_via: helper.joined_via,
    cwd: helper.cwd,
    wake_phrase: helper.wake_phrase,
    stop_phrase: helper.stop_phrase,
    poll_timeout_ms: helper.poll_timeout_ms,
    max_minutes: helper.max_minutes,
    status: helper.status,
    mode: helper.mode,
    pid: helper.pid ?? null,
    session_id: helper.session_id ?? null,
    last_message_id: helper.last_message_id ?? null,
    last_error: helper.last_error ?? null,
    started_at: helper.started_at,
    updated_at: helper.updated_at,
  };
}

export function matchesWakeIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const patterns = [
    /\bjoin(?:\s+the)?\s+room\b/,
    /\brejoin\b/,
    /\bwake(?:\s+up)?\b/,
    /\bcome\s+back\b/,
    /\breturn(?:\s+to)?(?:\s+the)?\s+room\b/,
    /\bare you(?:\s+guys)?\s+online\b/,
    /\bare you there\b/,
    /\bwhere are you\b/,
    /\banyone (?:here|online)\b/,
    /\bwho(?:'s| is)\s+here\b/,
    /\bhello\b/,
    /\bhey\b/,
    /\bhi\b/,
    /\bback\s+online\b/,
    /\bback\s+on\s+room\s+watch\b/,
    /\?$/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function getAuthorizationHeader(): string | null {
  const token = process.env.LETAGENTS_TOKEN || getStoredAuth()?.token || "";
  return token ? `Bearer ${token}` : null;
}

async function apiCall<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };

  const authorization = getAuthorizationHeader();
  if (authorization && !headers.Authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetch(`${DEFAULT_API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error(`LetAgents API request failed with status ${response.status}: ${await response.text()}`);
  }

  const body = await response.text();
  return body ? JSON.parse(body) as T : (null as T);
}

async function joinHelperRoomIdentifier(
  identifier: string,
  joinedVia: JoinedVia
): Promise<HelperRoomState> {
  const roomId = joinedVia === "join_code" ? normalizeInviteCode(identifier) : identifier.trim();

  try {
    const response = await apiCall<Record<string, unknown>>(
      `/rooms/${encodeRoomIdPath(roomId)}/join`,
      { method: "POST" }
    );

    return {
      room_id: typeof response.room_id === "string" ? response.room_id : roomId,
      project_id: typeof response.project_id === "string" ? response.project_id : null,
      code:
        typeof response.code === "string"
          ? response.code
          : looksLikeInviteCode(roomId)
            ? roomId
            : null,
      display_name: typeof response.display_name === "string" ? response.display_name : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/status 404|status 405|Cannot GET|Cannot POST|Not Found/i.test(message)) {
      throw error;
    }
  }

  if (joinedVia === "join_code") {
    const response = await apiCall<Record<string, unknown>>(
      `/projects/join/${encodeURIComponent(roomId)}`
    );
    return {
      room_id: typeof response.code === "string" ? response.code : roomId,
      project_id: typeof response.id === "string" ? response.id : null,
      code: typeof response.code === "string" ? response.code : roomId,
      display_name: typeof response.display_name === "string" ? response.display_name : null,
    };
  }

  const response = await apiCall<Record<string, unknown>>(
    `/projects/room/${encodeURIComponent(roomId)}`,
    { method: "POST" }
  );

  return {
    room_id:
      typeof response.name === "string" && response.name.trim()
        ? response.name
        : roomId,
    project_id: typeof response.id === "string" ? response.id : null,
    code:
      typeof response.code === "string"
        ? response.code
        : looksLikeInviteCode(roomId)
          ? roomId
          : null,
    display_name: typeof response.display_name === "string" ? response.display_name : null,
  };
}

function buildWakeHelperState(input: {
  helper_id: string;
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd: string;
  wake_phrase: string;
  stop_phrase: string;
  poll_timeout_ms: number;
  max_minutes: number;
  codex_bin: string;
}): CodexWakeHelperState {
  const now = new Date().toISOString();
  return {
    helper_id: input.helper_id,
    room_id: input.room_id,
    room_identifier: input.room_identifier,
    room_code: input.room_code ?? null,
    room_display_name: input.room_display_name ?? null,
    joined_via: input.joined_via,
    cwd: input.cwd,
    wake_phrase: input.wake_phrase,
    stop_phrase: input.stop_phrase,
    poll_timeout_ms: input.poll_timeout_ms,
    max_minutes: input.max_minutes,
    codex_bin: input.codex_bin,
    mode: "active",
    status: "starting",
    pid: null,
    session_id: null,
    last_message_id: null,
    last_error: null,
    started_at: now,
    updated_at: now,
  };
}

function isPidRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchRoomMessagesPollPage(
  roomId: string,
  afterMessageId: string | null | undefined,
  timeoutMs: number
): Promise<HelperMessagesPage> {
  const params = new URLSearchParams();
  if (afterMessageId) {
    params.set("after", afterMessageId);
  }
  params.set("timeout", String(timeoutMs));
  params.set("include_prompt_only", "1");
  return apiCall<HelperMessagesPage>(`/rooms/${encodeRoomIdPath(roomId)}/messages/poll?${params.toString()}`);
}

async function ensureLiveSession(helper: CodexWakeHelperState): Promise<CodexWakeHelperState> {
  const status = helper.session_id
    ? await inspectLocalCodexSession(helper.session_id, helper.room_id)
    : await inspectLocalCodexSession(undefined, helper.room_id);

  if (
    status &&
    resolve(status.session.cwd) === resolve(helper.cwd) &&
    (status.session.status === "running" || status.session.status === "starting")
  ) {
    return updateCodexWakeHelper(helper.helper_id, (current) => ({
      ...current,
      session_id: status.session.session_id,
      status: "running",
      last_error: null,
      updated_at: new Date().toISOString(),
    })) ?? helper;
  }

  const started = await startLocalCodexSession({
    room_id: helper.room_id,
    room_identifier: helper.room_identifier,
    room_code: helper.room_code ?? null,
    room_display_name: helper.room_display_name ?? null,
    joined_via: helper.joined_via,
    cwd: helper.cwd,
    stop_phrase: helper.stop_phrase,
    max_minutes: helper.max_minutes,
    codex_bin: helper.codex_bin,
  });

  return updateCodexWakeHelper(helper.helper_id, (current) => ({
    ...current,
    session_id: started.session.session_id,
    status: "running",
    last_error: null,
    updated_at: new Date().toISOString(),
  })) ?? helper;
}

async function pauseLiveSession(helper: CodexWakeHelperState): Promise<CodexWakeHelperState> {
  await stopLocalCodexSession({
    session_id: helper.session_id ?? undefined,
    room_id: helper.room_id,
  });

  return updateCodexWakeHelper(helper.helper_id, (current) => ({
    ...current,
    mode: "paused",
    status: "running",
    last_error: null,
    updated_at: new Date().toISOString(),
  })) ?? helper;
}

async function processMessages(
  helper: CodexWakeHelperState,
  messages: HelperRoomMessage[]
): Promise<CodexWakeHelperState> {
  let current = helper;

  for (const message of messages) {
    const text = (message.text ?? "").trim();
    if (!text) {
      continue;
    }

    if (text === current.stop_phrase) {
      current = await pauseLiveSession(current);
      continue;
    }

    // When the helper is paused, any new room traffic is enough to revive the
    // worker. That keeps wake behavior flexible without depending on a fixed
    // phrase list or a specific worker codename.
    if (
      current.mode === "paused" &&
      text !== current.stop_phrase &&
      (text === current.wake_phrase || matchesWakeIntent(text) || text.length > 0)
    ) {
      current = await ensureLiveSession(updateCodexWakeHelper(current.helper_id, (existing) => ({
        ...existing,
        mode: "active",
        updated_at: new Date().toISOString(),
      })) ?? current);
    }
  }

  return current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function createCodexWakeHelper(
  input: StartCodexWakeHelperInput
): Promise<StartCodexWakeHelperResult> {
  const room = input.room.trim();
  const cwd = resolve(input.cwd || process.cwd());
  const joinedVia: JoinedVia = looksLikeInviteCode(room) ? "join_code" : "join_room";
  const existing = getCurrentCodexWakeHelper(looksLikeInviteCode(room) ? normalizeInviteCode(room) : room, cwd);
  if (existing && isPidRunning(existing.pid) && existing.status !== "stopped") {
    return { helper: existing, reused: true };
  }

  const joined = await joinHelperRoomIdentifier(room, joinedVia);
  saveRoomSession({
    room_id: joined.room_id,
    project_id: joined.project_id ?? null,
    code: joined.code ?? null,
    display_name: joined.display_name ?? null,
    joined_via: joinedVia,
  });

  const exactCurrent = getCurrentCodexWakeHelper(joined.room_id, cwd);
  if (exactCurrent && isPidRunning(exactCurrent.pid) && exactCurrent.status !== "stopped") {
    return { helper: exactCurrent, reused: true };
  }

  const helper = saveCodexWakeHelper(
    buildWakeHelperState({
      helper_id: randomUUID(),
      room_id: joined.room_id,
      room_identifier: joinedVia === "join_code" ? normalizeInviteCode(room) : room,
      room_code: joined.code ?? null,
      room_display_name: joined.display_name ?? null,
      joined_via: joinedVia,
      cwd,
      wake_phrase: input.wake_phrase || DEFAULT_WAKE_PHRASE,
      stop_phrase: input.stop_phrase || DEFAULT_STOP_PHRASE,
      poll_timeout_ms:
        Number.isFinite(input.poll_timeout_ms) && (input.poll_timeout_ms ?? 0) > 0
          ? Math.floor(input.poll_timeout_ms as number)
          : DEFAULT_POLL_TIMEOUT_MS,
      max_minutes:
        Number.isFinite(input.max_minutes) && (input.max_minutes ?? 0) > 0
          ? Math.floor(input.max_minutes as number)
          : 0,
      codex_bin: input.codex_bin || process.env.LETAGENTS_CODEX_BIN || "codex",
    })
  );

  return { helper, reused: false };
}

export function launchCodexWakeHelperProcess(helperId: string): CodexWakeHelperState {
  const scriptPath = fileURLToPath(new URL("./codex-wake-helper-cli.js", import.meta.url));
  const child = spawn(process.execPath, [scriptPath, "run", "--helper-id", helperId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const helper = getStoredCodexWakeHelper(helperId);
  if (!helper) {
    throw new Error(`No wake helper found for id ${helperId}`);
  }

  return updateCodexWakeHelper(helperId, (current) => ({
    ...current,
    pid: child.pid ?? null,
    status: "starting",
    updated_at: new Date().toISOString(),
  })) ?? helper;
}

export async function inspectCodexWakeHelper(
  helperId?: string | null,
  roomId?: string | null,
  cwd?: string | null
): Promise<CodexWakeHelperStatusResult | null> {
  const helper = helperId
    ? getStoredCodexWakeHelper(helperId)
    : roomId && cwd
      ? getCurrentCodexWakeHelper(roomId, resolve(cwd))
      : getCurrentCodexWakeHelper();

  if (!helper) {
    return null;
  }

  const pidRunning = isPidRunning(helper.pid);
  const sessionStatus = helper.session_id
    ? await inspectLocalCodexSession(helper.session_id, helper.room_id)
    : null;

  const updated = updateCodexWakeHelper(helper.helper_id, (current) => ({
    ...current,
    status:
      current.status === "stopped"
        ? current.status
        : pidRunning
          ? current.status === "starting" ? "running" : current.status
          : current.status === "stopping" ? "stopped" : "failed",
    last_error:
      !pidRunning && current.status !== "stopped" && current.status !== "stopping"
        ? current.last_error ?? "wake helper process is not running"
        : current.last_error ?? null,
    updated_at: new Date().toISOString(),
  })) ?? helper;

  return {
    helper: updated,
    pid_running: pidRunning,
    session_status: sessionStatus?.session.status ?? null,
  };
}

export async function stopCodexWakeHelper(options?: {
  helper_id?: string | null;
  room_id?: string | null;
  cwd?: string | null;
  stop_session?: boolean;
}): Promise<CodexWakeHelperState | null> {
  const helper = options?.helper_id
    ? getStoredCodexWakeHelper(options.helper_id)
    : options?.room_id && options?.cwd
      ? getCurrentCodexWakeHelper(options.room_id, resolve(options.cwd))
      : getCurrentCodexWakeHelper();

  if (!helper) {
    return null;
  }

  if (options?.stop_session !== false) {
    await stopLocalCodexSession({
      session_id: helper.session_id ?? undefined,
      room_id: helper.room_id,
    });
  }

  if (isPidRunning(helper.pid)) {
    try {
      process.kill(helper.pid!, "SIGTERM");
    } catch {
      // Ignore already-dead helpers.
    }
  }

  return updateCodexWakeHelper(helper.helper_id, (current) => ({
    ...current,
    status: "stopped",
    pid: null,
    updated_at: new Date().toISOString(),
  })) ?? helper;
}

export async function runCodexWakeHelperLoop(helperId: string): Promise<void> {
  let helper = getStoredCodexWakeHelper(helperId);
  if (!helper) {
    throw new Error(`No wake helper found for id ${helperId}`);
  }

  let stopping = false;
  const stopSignals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of stopSignals) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  helper = updateCodexWakeHelper(helper.helper_id, (current) => ({
    ...current,
    pid: process.pid,
    status: "running",
    last_error: null,
    updated_at: new Date().toISOString(),
  })) ?? helper;

  try {
    while (!stopping) {
      const latest = getStoredCodexWakeHelper(helper.helper_id);
      if (!latest || latest.status === "stopped" || latest.status === "stopping") {
        break;
      }
      helper = latest;

      try {
        if (helper.mode === "active") {
          helper = await ensureLiveSession(helper);
        }

        const page = await fetchRoomMessagesPollPage(
          helper.room_id,
          helper.last_message_id,
          helper.poll_timeout_ms
        );

        const messages = page.messages ?? [];
        if (messages.length > 0) {
          const lastMessageId = messages[messages.length - 1]?.id ?? helper.last_message_id ?? null;
          helper = updateCodexWakeHelper(helper.helper_id, (current) => ({
            ...current,
            last_message_id: lastMessageId,
            last_error: null,
            updated_at: new Date().toISOString(),
          })) ?? helper;

          helper = await processMessages(helper, messages);
        }
      } catch (error) {
        helper = updateCodexWakeHelper(helper.helper_id, (current) => ({
          ...current,
          last_error: error instanceof Error ? error.message : String(error),
          status: "running",
          updated_at: new Date().toISOString(),
        })) ?? helper;
        await sleep(DEFAULT_RETRY_DELAY_MS);
      }
    }
  } finally {
    updateCodexWakeHelper(helper.helper_id, (current) => ({
      ...current,
      pid: null,
      status: current.status === "stopped" ? "stopped" : "stopped",
      updated_at: new Date().toISOString(),
    }));
  }
}
