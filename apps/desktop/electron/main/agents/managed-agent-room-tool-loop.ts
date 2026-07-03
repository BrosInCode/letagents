import type { DesktopRoomStorageState } from "../../ipc-types.js";
import {
  buildManagedAgentRoomToolResultPrompt,
  DESKTOP_EVENT_ROOM_TOOL_REQUEST_LIMIT,
  executeManagedAgentRoomToolRequestWithTimeout,
  hasManagedAgentRoomToolRequestLine,
  parseManagedAgentRoomToolRequest,
  type ManagedAgentRoomToolCache,
  type ManagedAgentRoomToolSession,
} from "./managed-agent-room-tools.js";
import type {
  ManagedAgentRoomToolRequest,
  ManagedAgentRoomToolResult,
} from "./managed-agent-room-tools-protocol.js";

export interface ManagedAgentRoomToolLoopTurn {
  text: string | null;
  status?: "success" | "error";
  error?: string | null;
  recentItems?: Array<Record<string, unknown>>;
}

export interface ManagedAgentRoomToolLoopState {
  cache: ManagedAgentRoomToolCache;
  requestCount: number;
}

export interface ManagedAgentRoomToolLoopResult<
  TSession extends ManagedAgentRoomToolSession,
  TTurn extends ManagedAgentRoomToolLoopTurn,
> {
  session: TSession;
  turn: TTurn;
  continuationId: string | null;
  state: ManagedAgentRoomToolLoopState;
  handledRequests: number;
  error: string | null;
}

export async function runManagedAgentRoomToolLoop<
  TSession extends ManagedAgentRoomToolSession,
  TTurn extends ManagedAgentRoomToolLoopTurn,
>(input: {
  providerLabel: string;
  session: TSession;
  storage: DesktopRoomStorageState;
  initialTurn: TTurn;
  initialContinuationId?: string | null;
  state?: ManagedAgentRoomToolLoopState;
  requestLimit?: number;
  getContinuationId?: (turn: TTurn) => string | null | undefined;
  getLatestSession?: (fallback: TSession) => TSession | null | undefined;
  isTurnError?: (turn: TTurn) => boolean;
  onRoomToolRequest?: (input: {
    request: ManagedAgentRoomToolRequest;
    requestIndex: number;
    session: TSession;
  }) => TSession | null | undefined | void | Promise<TSession | null | undefined | void>;
  executeRoomTool?: (input: {
    session: TSession;
    storage: DesktopRoomStorageState;
    request: ManagedAgentRoomToolRequest;
    cache: ManagedAgentRoomToolCache;
  }) => Promise<ManagedAgentRoomToolResult>;
  buildResultPrompt?: (result: ManagedAgentRoomToolResult) => string;
  runContinuationTurn: (input: {
    prompt: string;
    request: ManagedAgentRoomToolRequest;
    roomToolResult: ManagedAgentRoomToolResult;
    requestIndex: number;
    session: TSession;
    continuationId: string | null;
  }) => Promise<{ session?: TSession | null; turn: TTurn }>;
  onLoopError: (input: {
    error: string;
    session: TSession;
    lastTurn: TTurn;
    continuationId: string | null;
    recentItems: Array<Record<string, unknown>>;
  }) => TTurn | { session?: TSession | null; turn: TTurn } | Promise<TTurn | { session?: TSession | null; turn: TTurn }>;
}): Promise<ManagedAgentRoomToolLoopResult<TSession, TTurn>> {
  const state: ManagedAgentRoomToolLoopState = {
    cache: input.state?.cache ?? new Map(),
    requestCount: input.state?.requestCount ?? 0,
  };
  const requestLimit = input.requestLimit ?? DESKTOP_EVENT_ROOM_TOOL_REQUEST_LIMIT;
  const getLatestSession = input.getLatestSession ?? ((fallback: TSession) => fallback);
  const isTurnError = input.isTurnError ?? ((turn: TTurn) => turn.status === "error");
  const getContinuationId = input.getContinuationId ?? (() => null);
  const executeRoomTool = input.executeRoomTool
    ?? ((toolInput) => executeManagedAgentRoomToolRequestWithTimeout(toolInput));
  const buildResultPrompt = input.buildResultPrompt ?? buildManagedAgentRoomToolResultPrompt;

  let session = input.session;
  let turn = input.initialTurn;
  let continuationId = normalizedContinuationId(
    input.initialContinuationId ?? getContinuationId(turn),
  );
  let handledRequests = 0;

  const stopWithError = async (
    error: string,
  ): Promise<ManagedAgentRoomToolLoopResult<TSession, TTurn>> => {
    const handled = await input.onLoopError({
      error,
      session,
      lastTurn: turn,
      continuationId,
      recentItems: turn.recentItems ?? [],
    });
    const normalized = normalizeErrorTurn(handled);
    if (normalized.session) {
      session = normalized.session;
    }
    turn = normalized.turn;
    return {
      session,
      turn,
      continuationId,
      state,
      handledRequests,
      error,
    };
  };

  while (true) {
    continuationId = normalizedContinuationId(getContinuationId(turn) ?? continuationId);
    if (isTurnError(turn)) {
      return {
        session,
        turn,
        continuationId,
        state,
        handledRequests,
        error: null,
      };
    }

    const request = parseManagedAgentRoomToolRequest(turn.text);
    if (!request) {
      if (hasManagedAgentRoomToolRequestLine(turn.text)) {
        return await stopWithError(`${input.providerLabel} emitted a malformed desktop room tool request.`);
      }
      return {
        session,
        turn,
        continuationId,
        state,
        handledRequests,
        error: null,
      };
    }

    if (state.requestCount >= requestLimit) {
      return await stopWithError(
        `${input.providerLabel} requested more than ${requestLimit} desktop room tools for one room event.`,
      );
    }

    state.requestCount += 1;
    handledRequests += 1;
    const updatedSession = await input.onRoomToolRequest?.({
      request,
      requestIndex: state.requestCount,
      session,
    });
    if (updatedSession) {
      session = updatedSession;
    }
    session = getLatestSession(session) ?? session;

    const roomToolResult = await executeRoomTool({
      session,
      storage: input.storage,
      request,
      cache: state.cache,
    });
    const next = await input.runContinuationTurn({
      prompt: buildResultPrompt(roomToolResult),
      request,
      roomToolResult,
      requestIndex: state.requestCount,
      session,
      continuationId,
    });
    if (next.session) {
      session = next.session;
    } else {
      session = getLatestSession(session) ?? session;
    }
    turn = next.turn;
  }
}

function normalizedContinuationId(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeErrorTurn<
  TSession extends ManagedAgentRoomToolSession,
  TTurn extends ManagedAgentRoomToolLoopTurn,
>(
  value: TTurn | { session?: TSession | null; turn: TTurn },
): { session?: TSession | null; turn: TTurn } {
  if (
    value &&
    typeof value === "object" &&
    "turn" in value &&
    (value as { turn?: unknown }).turn &&
    typeof (value as { turn?: unknown }).turn === "object"
  ) {
    return value as { session?: TSession | null; turn: TTurn };
  }
  return { turn: value as TTurn };
}
