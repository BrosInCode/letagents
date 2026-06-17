import {
  Agent,
  Runner,
  setTracingDisabled,
  tool,
  type Model,
} from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

import type {
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAppAgentRoomChoice,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
} from "../../ipc-types.js";
import {
  getAppAgentSettingsStatus,
  readAppAgentSettings,
} from "./settings.js";

const appAgentDecisionSchema = z.object({
  state: z.enum(["success", "choices", "error", "info"]),
  message: z.string(),
  roomIdentifier: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  pinned: z.boolean().nullable().optional(),
  choices: z
    .array(
      z.object({
        roomIdentifier: z.string(),
        displayName: z.string(),
        reason: z.string(),
        pinned: z.boolean(),
        desiredPinned: z.boolean(),
        lastOpenedAt: z.string().nullable(),
      }),
    )
    .optional(),
});

export type AppAgentDecision = z.infer<typeof appAgentDecisionSchema>;

interface AppAgentToolDeps {
  listAccountRooms: (options?: {
    includeArchived?: boolean;
    limit?: number;
  }) => Promise<DesktopAccountRoomEntry[]>;
  updateAccountRoom: (
    roomIdentifier: string,
    updates: { pinned?: boolean },
  ) => Promise<DesktopAccountRoomActionResult>;
}

interface AppAgentRuntimeDeps extends AppAgentToolDeps {
  runAgent: (
    input: DesktopAppAgentRunInput,
    settings: { openRouterApiKey: string; model: string },
    toolDeps: AppAgentToolDeps,
  ) => Promise<AppAgentDecision>;
}

const defaultToolDeps: AppAgentToolDeps = {
  listAccountRooms: async (options) => {
    const rooms = await import("../rooms.js");
    return rooms.listDesktopAccountRooms(options);
  },
  updateAccountRoom: async (roomIdentifier, updates) => {
    const rooms = await import("../rooms.js");
    return rooms.updateDesktopAccountRoom(roomIdentifier, updates);
  },
};

const defaultRuntimeDeps: AppAgentRuntimeDeps = {
  ...defaultToolDeps,
  runAgent: runOpenRouterAppAgent,
};

export function resolvePinnedIntent(prompt: string): boolean | null {
  const normalized = prompt.toLowerCase();
  if (/\bunpin\b|\bun-pinned\b|\bun pinned\b|\bremove\s+pin\b/.test(normalized)) {
    return false;
  }
  if (/\bpin\b|\bpinned\b/.test(normalized)) {
    return true;
  }
  return null;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    if (/api[_\s-]?key|authorization|bearer|token|secret/i.test(error.message)) {
      return "The App Agent could not complete that run. Check the OpenRouter configuration and try again.";
    }
    return error.message;
  }
  return "The App Agent could not complete that run.";
}

function normalizeRoomText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function roomAliasCandidates(room: DesktopAccountRoomEntry): string[] {
  return [
    room.roomIdentifier,
    room.displayName,
    room.name,
    ...room.focusRooms.flatMap((focusRoom) => [
      focusRoom.roomIdentifier,
      focusRoom.displayName,
      focusRoom.name,
    ]),
  ]
    .map(normalizeRoomText)
    .filter((value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
    );
}

function normalizeSearchText(value: string): string {
  return normalizeRoomText(value)
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ");
}

function roomMatchesIdentifier(
  room: DesktopAccountRoomEntry,
  roomIdentifier: string,
): boolean {
  const expected = normalizeRoomText(roomIdentifier);
  if (!expected) return false;
  return roomAliasCandidates(room).some((candidate) => candidate === expected);
}

function toRoomChoice(
  room: DesktopAccountRoomEntry,
  desiredPinned: boolean,
  reason: string,
): DesktopAppAgentRoomChoice {
  return {
    roomIdentifier: room.roomIdentifier,
    displayName: room.displayName,
    reason,
    pinned: room.pinned,
    desiredPinned,
    lastOpenedAt: room.lastOpenedAt,
  };
}

function toToolRoom(room: DesktopAccountRoomEntry): Record<string, unknown> {
  return {
    roomIdentifier: room.roomIdentifier,
    displayName: room.displayName,
    name: room.name,
    pinned: room.pinned,
    archived: room.archived,
    role: room.role,
    source: room.source,
    firstOpenedAt: room.firstOpenedAt,
    lastOpenedAt: room.lastOpenedAt,
    latestMessageAt: room.latestMessageAt,
    focusRooms: room.focusRooms.map((focusRoom) => ({
      roomIdentifier: focusRoom.roomIdentifier,
      displayName: focusRoom.displayName,
      name: focusRoom.name,
      sourceTaskId: focusRoom.sourceTaskId,
      focusKey: focusRoom.focusKey,
      lastOpenedAt: focusRoom.lastOpenedAt,
      latestMessageAt: focusRoom.latestMessageAt,
    })),
  };
}

async function runSelectedRoomMutation(
  input: DesktopAppAgentRunInput,
  deps: AppAgentToolDeps,
): Promise<DesktopAppAgentRunResult | null> {
  const selectedRoomIdentifier = input.selectedRoomIdentifier?.trim();
  if (!selectedRoomIdentifier) return null;
  const desiredPinned =
    typeof input.selectedPinned === "boolean"
      ? input.selectedPinned
      : resolvePinnedIntent(input.prompt);
  if (desiredPinned === null) {
    return {
      state: "error",
      message: "Tell the App Agent whether to pin or unpin that room.",
    };
  }

  const rooms = await deps.listAccountRooms({ includeArchived: true, limit: 100 });
  const room = rooms.find((entry) =>
    roomMatchesIdentifier(entry, selectedRoomIdentifier),
  );
  if (!room) {
    return {
      state: "error",
      message: "That room choice is no longer available.",
    };
  }

  const actionResult = await deps.updateAccountRoom(room.roomIdentifier, {
    pinned: desiredPinned,
  });
  return {
    state: "success",
    message: `${desiredPinned ? "Pinned" : "Unpinned"} ${room.displayName}.`,
    roomIdentifier: room.roomIdentifier,
    displayName: room.displayName,
    pinned: desiredPinned,
    actionResult,
  };
}

function promptMentionsAlias(prompt: string, alias: string): boolean {
  const normalizedPrompt = normalizeSearchText(prompt);
  const normalizedAlias = normalizeSearchText(alias);
  if (!normalizedAlias) return false;
  if (normalizedPrompt === normalizedAlias) return true;
  const escapedAlias = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escapedAlias}([^a-z0-9]|$)`, "i").test(
    normalizedPrompt,
  );
}

function resolveExactPromptRoomMatches(
  prompt: string,
  rooms: DesktopAccountRoomEntry[],
): DesktopAccountRoomEntry[] {
  return rooms.filter((room) =>
    roomAliasCandidates(room).some((alias) => promptMentionsAlias(prompt, alias)),
  );
}

async function runExactPromptRoomMutation(
  input: DesktopAppAgentRunInput,
  deps: AppAgentToolDeps,
): Promise<DesktopAppAgentRunResult | null> {
  const desiredPinned = resolvePinnedIntent(input.prompt);
  if (desiredPinned === null) return null;
  const rooms = await deps.listAccountRooms({ includeArchived: true, limit: 100 });
  const matches = resolveExactPromptRoomMatches(input.prompt, rooms);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return {
      state: "choices",
      message: "I found multiple matching rooms. Choose one to continue.",
      choices: matches.slice(0, 5).map((room) =>
        toRoomChoice(room, desiredPinned, "Exact name match"),
      ),
    };
  }

  const room = matches[0];
  const actionResult = await deps.updateAccountRoom(room.roomIdentifier, {
    pinned: desiredPinned,
  });
  return {
    state: "success",
    message: `${desiredPinned ? "Pinned" : "Unpinned"} ${room.displayName}.`,
    roomIdentifier: room.roomIdentifier,
    displayName: room.displayName,
    pinned: desiredPinned,
    actionResult,
  };
}

function buildAppAgentTools(deps: AppAgentToolDeps) {
  return [
    tool({
      name: "list_account_rooms",
      description:
        "List the user's LetAgents rooms with identifiers, names, pinned state, archived state, focus rooms, and timestamps.",
      parameters: z.object({
        includeArchived: z.boolean().default(false),
      }),
      strict: true,
      execute: async ({ includeArchived }) => {
        const rooms = await deps.listAccountRooms({
          includeArchived,
          limit: 100,
        });
        return { rooms: rooms.map(toToolRoom) };
      },
    }),
    tool({
      name: "set_room_pinned",
      description:
        "Pin or unpin exactly one account room by roomIdentifier. Use only when the user intent and room match are unambiguous.",
      parameters: z.object({
        roomIdentifier: z.string().min(1),
        pinned: z.boolean(),
      }),
      strict: true,
      execute: async ({ roomIdentifier, pinned }) => {
        const rooms = await deps.listAccountRooms({
          includeArchived: true,
          limit: 100,
        });
        const room = rooms.find((entry) =>
          roomMatchesIdentifier(entry, roomIdentifier),
        );
        if (!room) {
          return {
            ok: false,
            message: "Room not found.",
          };
        }
        const actionResult = await deps.updateAccountRoom(room.roomIdentifier, {
          pinned,
        });
        return {
          ok: true,
          message: `${pinned ? "Pinned" : "Unpinned"} ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          pinned,
          actionResult,
        };
      },
    }),
  ];
}

function createOpenRouterModel(apiKey: string, modelSlug: string): Model {
  const provider = createOpenRouter({
    apiKey,
    compatibility: "strict",
    appName: "LetAgents Desktop",
    appUrl: "https://letagents.chat",
  });
  return aisdk(provider.chat(modelSlug));
}

async function runOpenRouterAppAgent(
  input: DesktopAppAgentRunInput,
  settings: { openRouterApiKey: string; model: string },
  toolDeps: AppAgentToolDeps,
): Promise<AppAgentDecision> {
  const traceApiKey = process.env.OPENAI_TRACE_API_KEY?.trim();
  setTracingDisabled(!traceApiKey);
  const agent = new Agent({
    name: "LetAgents App Agent",
    model: createOpenRouterModel(settings.openRouterApiKey, settings.model),
    tools: buildAppAgentTools(toolDeps),
    outputType: appAgentDecisionSchema,
    instructions: [
      "You operate LetAgents Desktop through typed tools only.",
      "You currently support only pinning and unpinning rooms.",
      "Use list_account_rooms before deciding which room the user means.",
      "If exactly one high-confidence room matches, call set_room_pinned.",
      "If multiple plausible rooms match, do not call set_room_pinned. Return state choices with 2-5 choices.",
      "If no room matches, return state error with a short safe message.",
      "For choices, include desiredPinned based on the user's requested pin/unpin action.",
      "Consider activeRoomIdentifier as context, but do not assume it overrides a named room.",
      "Never mention API keys, tokens, hidden settings, internal stack traces, or raw tool errors.",
    ].join("\n"),
    modelSettings: {
      toolChoice: "auto",
      temperature: 0,
    },
  });

  const runner = new Runner({
    tracingDisabled: !traceApiKey,
    traceIncludeSensitiveData: false,
    tracing: traceApiKey ? { apiKey: traceApiKey } : undefined,
    workflowName: "LetAgents App Agent",
  });
  const result = await runner.run(
    agent,
    [
      `User prompt: ${input.prompt}`,
      input.activeRoomIdentifier
        ? `Active room identifier: ${input.activeRoomIdentifier}`
        : "No active room identifier.",
    ].join("\n"),
    {
      maxTurns: 6,
    },
  );
  return result.finalOutput || {
    state: "error",
    message: "The App Agent did not return an action.",
  };
}

export async function runDesktopAppAgent(
  input: DesktopAppAgentRunInput,
  deps: Partial<AppAgentRuntimeDeps> = {},
): Promise<DesktopAppAgentRunResult> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return {
      state: "error",
      message: "Enter an App Agent request first.",
    };
  }

  const runtimeDeps: AppAgentRuntimeDeps = {
    ...defaultRuntimeDeps,
    ...deps,
  };

  try {
    const settingsStatus = await getAppAgentSettingsStatus();
    const settings = await readAppAgentSettings();
    if (!settingsStatus.configured || !settings.openRouterApiKey || !settings.model) {
      return {
        state: "configuration_required",
        message:
          "Add an OpenRouter API key and a tool-capable model in Settings before running the App Agent.",
        settingsStatus,
      };
    }

    const selectedResult = await runSelectedRoomMutation(input, runtimeDeps);
    if (selectedResult) return selectedResult;

    const exactPromptResult = await runExactPromptRoomMutation(
      { ...input, prompt },
      runtimeDeps,
    );
    if (exactPromptResult) return exactPromptResult;

    const decision = await runtimeDeps.runAgent(
      { ...input, prompt },
      {
        openRouterApiKey: settings.openRouterApiKey,
        model: settings.model,
      },
      runtimeDeps,
    );
    return {
      state: decision.state,
      message: decision.message,
      roomIdentifier: decision.roomIdentifier || null,
      displayName: decision.displayName || null,
      pinned:
        typeof decision.pinned === "boolean"
          ? decision.pinned
          : null,
      choices: decision.choices?.map((choice) => ({
        ...choice,
        reason: choice.reason || "Possible room match",
      })),
    };
  } catch (error) {
    return {
      state: "error",
      message: safeErrorMessage(error),
    };
  }
}

export const appAgentTestUtils = {
  toRoomChoice,
  roomMatchesIdentifier,
  resolveExactPromptRoomMatches,
  buildAppAgentTools,
  runExactPromptRoomMutation,
  runSelectedRoomMutation,
};
