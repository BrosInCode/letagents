import {
  Agent,
  Runner,
  setTracingDisabled,
  type Model,
} from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionChoice,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionReference,
  DesktopAppAgentPendingAction,
  DesktopAppAgentRefreshTarget,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
} from "../../ipc-types.js";
import {
  AppActionRegistry,
  createAppActionRegistry,
  createAppAgentActionTrace,
  roomMatchesIdentifier,
  type AppAgentActionExecutionResult,
  type AppAgentActionRegistryDeps,
  type AppAgentActionTrace,
} from "./action-registry.js";
import {
  getAppAgentSettingsStatus,
  readAppAgentSettings,
} from "./settings.js";

const actionRiskSchema = z.enum(["low", "medium", "destructive"]);
const refreshTargetSchema = z.enum([
  "rooms",
  "settings",
  "active_room",
  "foreground",
]);
const actionInputSchema = z.object({
  roomIdentifier: z.string().nullable(),
  roomIdentifiers: z.array(z.string()).nullable(),
  excludeRoomIdentifiers: z.array(z.string()).nullable(),
  pinned: z.boolean().nullable(),
  archived: z.boolean().nullable(),
  mode: z.enum(["cloud", "local"]).nullable(),
});

const actionChoiceSchema = z.object({
  choiceId: z.string().nullable(),
  label: z.string(),
  description: z.string(),
  actionId: z.string(),
  input: actionInputSchema,
  risk: actionRiskSchema,
});

const actionReferenceSchema = z.object({
  actionId: z.string(),
  input: actionInputSchema,
  label: z.string(),
  description: z.string().nullable(),
  risk: actionRiskSchema,
  refreshTargets: z.array(refreshTargetSchema),
});

const pendingActionSchema = z.object({
  confirmationId: z.string().nullable(),
  label: z.string(),
  description: z.string(),
  actionId: z.string(),
  input: actionInputSchema,
  risk: actionRiskSchema,
  confirmLabel: z.string().nullable(),
  cancelLabel: z.string().nullable(),
});

const pendingPlanSchema = z.object({
  planId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  actions: z.array(actionReferenceSchema),
  risk: actionRiskSchema,
  confirmLabel: z.string().nullable(),
  cancelLabel: z.string().nullable(),
  refreshTargets: z.array(refreshTargetSchema),
});

const appAgentDecisionSchema = z.object({
  state: z.enum(["success", "choices", "confirmation_required", "error", "info"]),
  message: z.string(),
  roomIdentifier: z.string().nullable(),
  displayName: z.string().nullable(),
  pinned: z.boolean().nullable(),
  archived: z.boolean().nullable(),
  openRoomIdentifier: z.string().nullable(),
  refreshTargets: z.array(refreshTargetSchema),
  choices: z.array(actionChoiceSchema),
  pendingAction: pendingActionSchema.nullable(),
  pendingPlan: pendingPlanSchema.nullable(),
});

type StructuredAppAgentDecision = z.infer<typeof appAgentDecisionSchema>;
export interface AppAgentDecision {
  state: StructuredAppAgentDecision["state"];
  message: string;
  roomIdentifier?: string | null;
  displayName?: string | null;
  pinned?: boolean | null;
  archived?: boolean | null;
  openRoomIdentifier?: string | null;
  refreshTargets?: DesktopAppAgentRefreshTarget[];
  choices?: DesktopAppAgentActionChoice[];
  pendingAction?: DesktopAppAgentPendingAction | null;
  pendingPlan?: DesktopAppAgentActionPlan | null;
}

interface AppAgentRuntimeDeps extends AppAgentActionRegistryDeps {
  runAgent: (
    input: DesktopAppAgentRunInput,
    settings: { openRouterApiKey: string; model: string },
    registry: AppActionRegistry,
    trace: AppAgentActionTrace,
    options?: { timeoutMs: number },
  ) => Promise<AppAgentDecision>;
}

class AppAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The App Agent run timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "AppAgentTimeoutError";
  }
}

const defaultActionDeps: AppAgentActionRegistryDeps = {
  listAccountRooms: async (options) => {
    const rooms = await import("../rooms.js");
    return rooms.listDesktopAccountRooms(options);
  },
  updateAccountRoom: async (roomIdentifier, updates) => {
    const rooms = await import("../rooms.js");
    return rooms.updateDesktopAccountRoom(roomIdentifier, updates);
  },
  getChatStorageSettings: async () => {
    const settings = await import("../chat-storage/settings.js");
    return settings.readChatStorageSettings();
  },
  setChatStorageMode: async (mode) => {
    const settings = await import("../chat-storage/settings.js");
    return settings.setChatStorageMode(mode);
  },
  getAppAgentSettingsStatus: () => getAppAgentSettingsStatus(),
};

const defaultRuntimeDeps: AppAgentRuntimeDeps = {
  ...defaultActionDeps,
  runAgent: runOpenRouterAppAgent,
};

function roomEntryFromActiveInput(
  input: DesktopAppAgentRunInput,
): DesktopAccountRoomEntry | null {
  const roomIdentifier = input.activeRoomIdentifier?.trim();
  if (!roomIdentifier) return null;
  const displayName = input.activeRoomDisplayName?.trim() || roomIdentifier;
  return {
    roomIdentifier,
    displayName,
    name: displayName,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "admin",
    source: "current",
    pinned: input.activeRoomPinned === true,
    archived: false,
    canLeave: false,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    gitRoom: input.activeRoomGitRoom ?? null,
    focusRooms: [],
  };
}

function withActiveRoomContext(
  deps: AppAgentRuntimeDeps,
  input: DesktopAppAgentRunInput,
): AppAgentRuntimeDeps {
  const activeRoom = roomEntryFromActiveInput(input);
  if (!activeRoom) return deps;
  return {
    ...deps,
    listAccountRooms: async (options) => {
      const rooms = await deps.listAccountRooms(options);
      if (rooms.some((room) => roomMatchesIdentifier(room, activeRoom.roomIdentifier))) {
        return rooms;
      }
      return [...rooms, { ...activeRoom }];
    },
  };
}

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
  if (
    error instanceof AppAgentTimeoutError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "The App Agent run timed out. Try a more specific request or a faster OpenRouter model.";
  }
  if (error instanceof Error && error.message.trim()) {
    if (/api[_\s-]?key|authorization|bearer|token|secret/i.test(error.message)) {
      return "The App Agent could not complete that run. Check the OpenRouter configuration and try again.";
    }
    return error.message;
  }
  return "The App Agent could not complete that run.";
}

function safeTraceText(value: string): string {
  return value
    .replace(/(api[_\s-]?key|authorization|bearer|token|secret)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/(sk-or-v1-)[A-Za-z0-9_-]+/g, "$1[redacted]");
}

function summarizePrompt(prompt: string): string {
  const value = safeTraceText(prompt.trim().replace(/\s+/g, " "));
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function summarizeDecision(decision: AppAgentDecision): string {
  const parts = [
    `state=${decision.state}`,
    decision.openRoomIdentifier ? `open=${decision.openRoomIdentifier}` : null,
    decision.roomIdentifier ? `room=${decision.roomIdentifier}` : null,
    decision.choices?.length ? `choices=${decision.choices.length}` : null,
    decision.pendingAction ? `pending=${decision.pendingAction.actionId}` : null,
    decision.pendingPlan ? `plan=${decision.pendingPlan.actions.length}` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

function traceToolCallCount(trace: AppAgentActionTrace): number {
  return trace.entries().filter((entry) => entry.label.startsWith("Call ")).length;
}

function traceActionCallCount(
  trace: AppAgentActionTrace,
  actionIds: string[],
): number {
  const actionIdSet = new Set(actionIds);
  return trace
    .entries()
    .filter(
      (entry) =>
        (entry.label.startsWith("Call ") ||
          entry.label.startsWith("Execute ") ||
          entry.label === "Confirmation needed") &&
        Boolean(entry.actionId) &&
        actionIdSet.has(entry.actionId as string),
    )
    .length;
}

function promptLooksLikeAppAction(prompt: string): boolean {
  return /\b(open|show|switch|go\s+to|pin|unpin|archive|restore|unarchive|hide|change|set)\b/i.test(
    prompt,
  );
}

function promptLooksLikeRoomAction(prompt: string): boolean {
  return /\b(room|rooms|focus|repo)\b/i.test(prompt);
}

function promptLooksLikeMultipleRoomAction(prompt: string): boolean {
  return (
    /\brooms?\b/i.test(prompt) &&
    (
      /\b(all|every|each|matching|that\s+(have|has|end|ends|contain|contains|include|includes)|with|ending|end\s+of|suffix|prefix)\b/i.test(prompt) ||
      /\b(and|plus)\b|,|&/i.test(prompt)
    )
  );
}

function promptLooksLikeUnpinnedRoomArchive(prompt: string): boolean {
  return (
    /\barchive|hide|remove\s+from\s+list\b/i.test(prompt) &&
    /\b(unpinned|not\s+pinned|not-pinned)\b/i.test(prompt) &&
    /\brooms?\b/i.test(prompt)
  );
}

function promptLooksLikePinMutation(prompt: string): boolean {
  return /\bunpin\b|\bun-pinned\b|\bun pinned\b|\bremove\s+pin\b|\bpin\b/i.test(
    prompt,
  );
}

function expectedActionIdsForPrompt(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const multipleRooms = promptLooksLikeMultipleRoomAction(prompt);
  const actions: string[] = [];
  if (promptLooksLikePinMutation(prompt)) {
    actions.push(multipleRooms ? "rooms.pin_many" : "rooms.pin");
  }
  if (/\b(open|show|switch|go\s+to|navigate)\b/.test(normalized)) {
    actions.push("rooms.open");
  }
  if (/\barchive|restore|unarchive|hide|remove\s+from\s+list\b/.test(normalized)) {
    actions.push(
      promptLooksLikeUnpinnedRoomArchive(prompt)
        ? "rooms.archive_unpinned"
        : multipleRooms
          ? "rooms.archive_many"
          : "rooms.archive",
    );
  }
  if (/\b(chat\s+storage|storage\s+mode|local\s+storage|cloud\s+storage)\b/.test(normalized)) {
    actions.push("settings.set_chat_storage_mode");
  }
  return actions;
}

function actionMatchesExpectedActionIds(
  actionId: string,
  expectedActionIds: string[],
): boolean {
  return (
    expectedActionIds.includes(actionId) ||
    (
      actionId === "rooms.archive_many" &&
      expectedActionIds.includes("rooms.archive_unpinned")
    )
  );
}

function messageLooksLikeDeferredToolUse(message: string): boolean {
  return (
    /\b(i('|’)ll|i\s+will|let\s+me|need\s+to|first)\b/i.test(message) &&
    /\b(list|find|look\s+up|pull\s+up|check|inspect|search)\b/i.test(message)
  );
}

function decisionNeedsToolRetry(
  input: DesktopAppAgentRunInput,
  decision: AppAgentDecision,
  expectedActionIds: string[],
  toolCallsDuringRun: number,
  expectedActionCallsDuringRun: number,
  listCallsDuringRun: number,
): boolean {
  if (!promptLooksLikeAppAction(input.prompt)) return false;

  if (decision.state === "info") return true;
  if (messageLooksLikeDeferredToolUse(decision.message)) return true;
  if (decision.state === "error" && toolCallsDuringRun === 0) return true;
  if (decision.pendingPlan?.actions.length) return false;
  if (decision.pendingAction) {
    return (
      expectedActionIds.length > 0 &&
      !actionMatchesExpectedActionIds(
        decision.pendingAction.actionId,
        expectedActionIds,
      )
    );
  }
  if (
    (decision.state === "success" || decision.state === "confirmation_required") &&
    expectedActionIds.length > 0 &&
    expectedActionCallsDuringRun === 0
  ) {
    return true;
  }
  if (decision.state === "choices" && listCallsDuringRun === 0) return true;

  if (
    decision.state === "success" &&
    promptLooksLikeRoomAction(input.prompt) &&
    !decision.roomIdentifier &&
    !decision.openRoomIdentifier &&
    !decision.choices?.length &&
    !decision.pendingAction
  ) {
    return true;
  }

  return false;
}

function toolRetryPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Correction: your previous response stopped before using tools.",
    "This is an app action request. Do not say you will look things up.",
    "Call the appropriate tool now. For room requests, call list_account_rooms first, then call the matching room action tool.",
    "Return final output only after the tool call path completes.",
  ].join("\n");
}

function appAgentRunTimeoutMs(): number {
  const raw = Number(process.env.LETAGENTS_APP_AGENT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 45_000;
  return Math.min(Math.max(Math.round(raw), 250), 180_000);
}

async function withAppAgentTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new AppAgentTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

function mergeRefreshTargets(
  ...targetGroups: Array<DesktopAppAgentRefreshTarget[] | null | undefined>
): DesktopAppAgentRefreshTarget[] {
  const targets = new Set<DesktopAppAgentRefreshTarget>();
  for (const group of targetGroups) {
    for (const target of group || []) {
      targets.add(target);
    }
  }
  return [...targets];
}

function normalizeActionReference(
  input: DesktopAppAgentRunInput,
  registry: AppActionRegistry,
): {
  action: DesktopAppAgentActionReference;
  confirmed: boolean;
} | null {
  if (input.confirmedAction) {
    return { action: input.confirmedAction, confirmed: true };
  }
  if (input.selectedAction) {
    return { action: input.selectedAction, confirmed: false };
  }

  const selectedRoomIdentifier = input.selectedRoomIdentifier?.trim();
  if (!selectedRoomIdentifier) return null;
  const desiredPinned =
    typeof input.selectedPinned === "boolean"
      ? input.selectedPinned
      : resolvePinnedIntent(input.prompt);
  if (desiredPinned === null) {
    throw new Error("Tell the App Agent whether to pin or unpin that room.");
  }
  const action = registry.actionReference("rooms.pin", {
    roomIdentifier: selectedRoomIdentifier,
    pinned: desiredPinned,
  });
  return action ? { action, confirmed: false } : null;
}

function toActionChoice(
  choice: DesktopAppAgentActionChoice,
  index: number,
): DesktopAppAgentActionChoice {
  return {
    choiceId: choice.choiceId || `${choice.actionId}:${index}`,
    label: choice.label,
    description: choice.description,
    actionId: choice.actionId,
    input: choice.input,
    risk: choice.risk,
  };
}

async function toDecisionPendingAction(
  pendingAction: DesktopAppAgentPendingAction,
  registry: AppActionRegistry,
): Promise<DesktopAppAgentPendingAction> {
  try {
    const validated = await registry.pendingActionForDisplay(
      pendingAction.actionId,
      pendingAction.input,
    );
    return {
      ...validated,
      confirmationId: pendingAction.confirmationId || validated.confirmationId,
      label: validated.label || pendingAction.label,
      description: validated.description || pendingAction.description,
      confirmLabel: pendingAction.confirmLabel || validated.confirmLabel,
      cancelLabel: pendingAction.cancelLabel || validated.cancelLabel,
    };
  } catch {
    return {
      confirmationId: pendingAction.confirmationId || `${pendingAction.actionId}:pending`,
      label: pendingAction.label,
      description: pendingAction.description,
      actionId: pendingAction.actionId,
      input: pendingAction.input,
      risk: pendingAction.risk,
      confirmLabel: pendingAction.confirmLabel || "Confirm",
      cancelLabel: pendingAction.cancelLabel || "Cancel",
    };
  }
}

async function toDecisionPendingPlan(
  pendingPlan: DesktopAppAgentActionPlan,
  registry: AppActionRegistry,
): Promise<DesktopAppAgentActionPlan> {
  return registry.preparePlanForDisplay({
    title: pendingPlan.title,
    description: pendingPlan.description,
    actions: pendingPlan.actions,
  });
}

async function pendingPlanFromAction(
  registry: AppActionRegistry,
  action: DesktopAppAgentActionReference,
): Promise<DesktopAppAgentActionPlan> {
  return registry.pendingPlanForAction(action);
}

function normalizeStructuredDecision(
  decision: StructuredAppAgentDecision,
): AppAgentDecision {
  return {
    ...decision,
    choices: decision.choices.map((choice, index) => ({
      ...choice,
      choiceId: choice.choiceId || `${choice.actionId}:${index}`,
    })),
    pendingAction: decision.pendingAction
      ? {
          ...decision.pendingAction,
          confirmationId:
            decision.pendingAction.confirmationId ||
            `${decision.pendingAction.actionId}:pending`,
          confirmLabel: decision.pendingAction.confirmLabel || "Confirm",
          cancelLabel: decision.pendingAction.cancelLabel || "Cancel",
        }
      : null,
    pendingPlan: decision.pendingPlan
      ? {
          ...decision.pendingPlan,
          planId: decision.pendingPlan.planId || "app-agent-plan",
          confirmLabel: decision.pendingPlan.confirmLabel || "Confirm",
          cancelLabel: decision.pendingPlan.cancelLabel || "Cancel",
        }
      : null,
  };
}

function resultFromExecution(
  result: AppAgentActionExecutionResult,
  trace: AppAgentActionTrace,
): DesktopAppAgentRunResult {
  const refreshTargets = mergeRefreshTargets(result.refreshTargets, trace.refreshTargets());
  const executedActions = result.executedActions?.length
    ? result.executedActions
    : trace.executions();
  return {
    state: result.ok === false ? "error" : "success",
    message: result.message,
    roomIdentifier: result.roomIdentifier || null,
    displayName: result.displayName || null,
    pinned:
      typeof result.pinned === "boolean"
        ? result.pinned
        : null,
    archived:
      typeof result.archived === "boolean"
        ? result.archived
        : null,
    openRoomIdentifier: result.openRoomIdentifier || null,
    refreshTargets,
    trace: trace.entries(),
    actionResult: result.actionResult || null,
    executedActions: executedActions.length ? executedActions : undefined,
  };
}

async function runSelectedAction(
  input: DesktopAppAgentRunInput,
  registry: AppActionRegistry,
  trace: AppAgentActionTrace,
): Promise<DesktopAppAgentRunResult | null> {
  if (input.confirmedPlan) {
    const result = await registry.executePlan(input.confirmedPlan, {
      confirmed: true,
      trace,
    });
    return resultFromExecution(result, trace);
  }

  const actionRequest = normalizeActionReference(input, registry);
  if (!actionRequest) return null;
  const registeredAction = registry.get(actionRequest.action.actionId);
  if (!registeredAction) {
    return {
      state: "error",
      message: "That App Agent action is no longer available.",
      trace: trace.entries(),
    };
  }
  if (
    registry.actionRequiresConfirmation(actionRequest.action) &&
    !actionRequest.confirmed
  ) {
    const pendingAction = await registry.pendingActionForDisplay(
      actionRequest.action.actionId,
      actionRequest.action.input,
    );
    const pendingPlan = await pendingPlanFromAction(registry, actionRequest.action);
    trace.add("Confirmation needed", {
      status: "info",
      detail: pendingAction.label,
      actionId: pendingAction.actionId,
    });
    return {
      state: "confirmation_required",
      message: pendingPlan.description,
      pendingAction,
      pendingPlan,
      trace: trace.entries(),
    };
  }
  const result = await registry.execute(actionRequest.action, {
    confirmed: actionRequest.confirmed,
    trace,
  });
  return resultFromExecution(result, trace);
}

async function mapDecisionToResult(
  decision: AppAgentDecision,
  registry: AppActionRegistry,
  trace: AppAgentActionTrace,
): Promise<DesktopAppAgentRunResult> {
  if (decision.pendingPlan) {
    const pendingPlan = await toDecisionPendingPlan(decision.pendingPlan, registry);
    if (!registry.planRequiresConfirmation(pendingPlan)) {
      const result = await registry.executePlan(pendingPlan, {
        confirmed: true,
        trace,
      });
      return resultFromExecution(result, trace);
    }
    trace.add("Plan confirmation needed", {
      status: "info",
      detail: pendingPlan.title,
      actionId: "app.plan",
    });
    return {
      state: "confirmation_required",
      message: pendingPlan.description,
      pendingPlan,
      refreshTargets: mergeRefreshTargets(pendingPlan.refreshTargets, trace.refreshTargets()),
      trace: trace.entries(),
    };
  }

  if (decision.pendingAction) {
    const pendingAction = await toDecisionPendingAction(decision.pendingAction, registry);
    const pendingPlan = await pendingPlanFromAction(registry, {
      actionId: pendingAction.actionId,
      input: pendingAction.input,
      label: pendingAction.label,
      description: pendingAction.description,
      risk: pendingAction.risk,
    });
    return {
      state: "confirmation_required",
      message: pendingPlan.description,
      pendingAction,
      pendingPlan,
      refreshTargets: mergeRefreshTargets(pendingPlan.refreshTargets, trace.refreshTargets()),
      trace: trace.entries(),
    };
  }

  const refreshTargets = mergeRefreshTargets(decision.refreshTargets, trace.refreshTargets());
  const executedActions = decision.state === "success" ? trace.executions() : [];
  return {
    state: decision.state,
    message: decision.message,
    roomIdentifier: decision.roomIdentifier || null,
    displayName: decision.displayName || null,
    pinned:
      typeof decision.pinned === "boolean"
        ? decision.pinned
        : null,
    archived:
      typeof decision.archived === "boolean"
        ? decision.archived
        : null,
    openRoomIdentifier: decision.openRoomIdentifier || null,
    choices: decision.choices?.map(toActionChoice),
    pendingAction: null,
    pendingPlan: null,
    refreshTargets,
    trace: trace.entries(),
    executedActions: executedActions.length ? executedActions : undefined,
  };
}

async function runOpenRouterAppAgent(
  input: DesktopAppAgentRunInput,
  settings: { openRouterApiKey: string; model: string },
  registry: AppActionRegistry,
  trace: AppAgentActionTrace,
  options: { timeoutMs: number } = { timeoutMs: appAgentRunTimeoutMs() },
): Promise<AppAgentDecision> {
  const traceApiKey = process.env.OPENAI_TRACE_API_KEY?.trim();
  setTracingDisabled(!traceApiKey);
  trace.add("Model setup", {
    status: "info",
    detail: `${settings.model}, timeout ${Math.round(options.timeoutMs / 1000)}s`,
  });
  const agent = new Agent({
    name: "LetAgents App Agent",
    model: createOpenRouterModel(settings.openRouterApiKey, settings.model),
    tools: registry.tools(trace),
    outputType: appAgentDecisionSchema,
    instructions: [
      "You operate LetAgents Desktop through typed tools only. You are the planner; Electron main performs every side effect.",
      "Supported actions: list rooms, pin or unpin rooms, archive or restore rooms, open rooms, read safe settings, and change chat storage mode.",
      "Always call list_account_rooms before deciding which room the user means, including when the user gives an exact room name.",
      "Call get_app_settings before answering or changing settings.",
      "If exactly one high-confidence room matches, call the tool for the requested action.",
      "Use set_room_pinned for pin and unpin requests. These are low-risk and can run immediately.",
      "Use set_rooms_pinned when the user asks to pin or unpin multiple rooms in one request. If the tool returns pendingPlan, return state confirmation_required with that pendingPlan.",
      "Use prepare_app_action_plan for multi-step requests, mixed actions, broad filters, or whenever you need Electron main to validate a grouped plan before mutation.",
      "Low-risk plans of 5 or fewer actions may be returned with pendingPlan; Electron main will decide whether to run them immediately. Do not add your own confirmation rule.",
      "Use set_room_archived for archive, hide, remove from list, unarchive, and restore requests. If the tool returns confirmationRequired, return state confirmation_required with pendingAction and pendingPlan from the tool and do not claim the mutation happened.",
      "Use set_rooms_archived when the user asks to archive or restore multiple rooms. If the tool returns confirmationRequired, return state confirmation_required with pendingPlan from the tool.",
      "Use archive_unpinned_rooms for requests to archive all unpinned rooms or all rooms that are not pinned. Put named exceptions in excludeRoomIdentifiers, or pin those rooms first if the user explicitly asks to pin them.",
      "For group or pattern requests such as all rooms ending with a word, rooms containing text, or every matching room, call list_account_rooms, filter by displayName/name/roomIdentifier, then call the matching batch tool. Do not ask the user to pick if the filter is deterministic.",
      "Use open_room for requests to show, open, switch to, or navigate to a room.",
      "Use set_chat_storage_mode for requests to change chat storage to local or cloud. If the tool returns confirmationRequired, return state confirmation_required with pendingAction and pendingPlan from the tool.",
      "If multiple plausible room matches exist, do not mutate anything. Return state choices with 2-5 generic action choices using actionId and input.",
      "For every action input object in final output, include roomIdentifier, roomIdentifiers, excludeRoomIdentifiers, pinned, archived, and mode. Use null for fields that do not apply.",
      "When final output does not need a pendingPlan, set pendingPlan to null.",
      "If no room matches, return state error with a short safe message.",
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
  const abortController = new AbortController();
  const timeoutError = new AppAgentTimeoutError(options.timeoutMs);
  const timeout = setTimeout(() => {
    trace.add("Model timeout reached", {
      status: "error",
      detail: `${Math.round(options.timeoutMs / 1000)}s`,
    });
    abortController.abort(timeoutError);
  }, options.timeoutMs);
  try {
    trace.add("Model run started", {
      status: "info",
      detail: summarizePrompt(input.prompt),
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
        maxTurns: 8,
        signal: abortController.signal,
      },
    );
    if (result.finalOutput) {
      const decision = normalizeStructuredDecision(result.finalOutput);
      trace.add("Model returned decision", {
        status: decision.state === "error" ? "error" : "success",
        detail: summarizeDecision(decision),
      });
      return decision;
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw timeoutError;
    }
    trace.add("Model run failed", {
      status: "error",
      detail: safeErrorMessage(error),
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  trace.add("Model returned no decision", {
    status: "error",
  });
  return {
    state: "error",
    message: "The App Agent did not return an action.",
    roomIdentifier: null,
    displayName: null,
    pinned: null,
    archived: null,
    openRoomIdentifier: null,
    refreshTargets: [],
    choices: [],
    pendingAction: null,
    pendingPlan: null,
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
  const registryDeps = withActiveRoomContext(runtimeDeps, input);
  const registry = createAppActionRegistry(registryDeps);
  const trace = createAppAgentActionTrace();

  try {
    const settingsStatus = await getAppAgentSettingsStatus();
    const settings = await readAppAgentSettings();
    if (!settingsStatus.configured || !settings.openRouterApiKey || !settings.model) {
      return {
        state: "configuration_required",
        message:
          "Add an OpenRouter API key and a tool-capable model in Settings before running the App Agent.",
        settingsStatus,
        trace: trace.entries(),
      };
    }

    const selectedResult = await runSelectedAction(
      { ...input, prompt },
      registry,
      trace,
    );
    if (selectedResult) return selectedResult;

    const timeoutMs = appAgentRunTimeoutMs();
    let decision: AppAgentDecision | null = null;
    let modelInput: DesktopAppAgentRunInput = { ...input, prompt };
    const originalModelInput: DesktopAppAgentRunInput = { ...input, prompt };
    const expectedActionIds = expectedActionIdsForPrompt(prompt);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      trace.add(attempt === 1 ? "Asked model to plan" : "Retried model with tool correction", {
        status: "info",
        detail: settings.model,
      });
      const toolCallsBefore = traceToolCallCount(trace);
      const expectedActionCallsBefore = traceActionCallCount(trace, expectedActionIds);
      const listCallsBefore = traceActionCallCount(trace, ["rooms.list"]);
      decision = await withAppAgentTimeout(
        runtimeDeps.runAgent(
          modelInput,
          {
            openRouterApiKey: settings.openRouterApiKey,
            model: settings.model,
          },
          registry,
          trace,
          { timeoutMs },
        ),
        timeoutMs,
      );
      const toolCallsDuringRun = traceToolCallCount(trace) - toolCallsBefore;
      const expectedActionCallsDuringRun =
        traceActionCallCount(trace, expectedActionIds) - expectedActionCallsBefore;
      const listCallsDuringRun =
        traceActionCallCount(trace, ["rooms.list"]) - listCallsBefore;
      if (trace.executions().some((execution) => execution.status === "success")) {
        break;
      }
      if (
        !decisionNeedsToolRetry(
          originalModelInput,
          decision,
          expectedActionIds,
          toolCallsDuringRun,
          expectedActionCallsDuringRun,
          listCallsDuringRun,
        )
      ) {
        break;
      }
      trace.add("Model stopped before tool use", {
        status: "error",
        detail: decision.message,
      });
      if (attempt === 2) {
        decision = {
          state: "error",
          message:
            "The model stopped before completing the app tool path. Try again with a stronger tool-calling model.",
          roomIdentifier: null,
          displayName: null,
          pinned: null,
          archived: null,
          openRoomIdentifier: null,
          refreshTargets: [],
          choices: [],
          pendingAction: null,
          pendingPlan: null,
        };
        break;
      }
      modelInput = {
        ...modelInput,
        prompt: toolRetryPrompt(prompt),
      };
    }
    if (!decision) {
      throw new Error("The App Agent did not return an action.");
    }
    return await mapDecisionToResult(decision, registry, trace);
  } catch (error) {
    trace.add("App Agent failed", {
      status: "error",
      detail: safeErrorMessage(error),
    });
    return {
      state: "error",
      message: safeErrorMessage(error),
      trace: trace.entries(),
      executedActions: trace.executions().length ? trace.executions() : undefined,
    };
  }
}

export function listDesktopAppAgentActions(): DesktopAppAgentActionMetadata[] {
  return createAppActionRegistry(defaultActionDeps).listMetadata();
}

export const appAgentTestUtils = {
  createAppActionRegistry,
  createAppAgentActionTrace,
  roomMatchesIdentifier,
};
