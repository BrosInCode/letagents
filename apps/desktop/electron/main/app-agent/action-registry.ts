import { tool } from "@openai/agents";
import { z } from "zod";

import type {
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopAppAgentActionChoice,
  DesktopAppAgentActionExecutionSummary,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionReference,
  DesktopAppAgentActionRisk,
  DesktopAppAgentPendingAction,
  DesktopAppAgentRefreshTarget,
  DesktopAppAgentSettingsStatus,
  DesktopAppAgentTraceEntry,
  DesktopChatStorageSettings,
} from "../../ipc-types.js";

export interface AppAgentActionRegistryDeps {
  listAccountRooms: (options?: {
    includeArchived?: boolean;
    limit?: number;
  }) => Promise<DesktopAccountRoomEntry[]>;
  updateAccountRoom: (
    roomIdentifier: string,
    updates: { pinned?: boolean; archived?: boolean },
  ) => Promise<DesktopAccountRoomActionResult>;
  getChatStorageSettings: () => Promise<DesktopChatStorageSettings>;
  setChatStorageMode: (
    mode: DesktopChatStorageSettings["mode"],
  ) => Promise<DesktopChatStorageSettings>;
  getAppAgentSettingsStatus: () => Promise<DesktopAppAgentSettingsStatus>;
}

export interface AppAgentActionExecutionResult {
  ok?: boolean;
  message: string;
  roomIdentifier?: string | null;
  displayName?: string | null;
  pinned?: boolean | null;
  archived?: boolean | null;
  openRoomIdentifier?: string | null;
  refreshTargets?: DesktopAppAgentRefreshTarget[];
  actionResult?: Record<string, unknown> | null;
  executedActions?: DesktopAppAgentActionExecutionSummary[];
}

export interface AppAgentActionTrace {
  add: (
    label: string,
    options?: {
      status?: DesktopAppAgentTraceEntry["status"];
      detail?: string | null;
      actionId?: string | null;
    },
  ) => void;
  addRefreshTargets: (targets: DesktopAppAgentRefreshTarget[]) => void;
  recordExecution: (summary: DesktopAppAgentActionExecutionSummary) => void;
  entries: () => DesktopAppAgentTraceEntry[];
  executions: () => DesktopAppAgentActionExecutionSummary[];
  refreshTargets: () => DesktopAppAgentRefreshTarget[];
}

export interface AppAgentActionDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  toolName: string;
  description: string;
  category: "rooms" | "settings";
  risk: DesktopAppAgentActionRisk;
  requiresConfirmation: boolean;
  refreshTargets: DesktopAppAgentRefreshTarget[];
  inputSchema: TInput;
  resultLabel: (input: z.infer<TInput>, result?: AppAgentActionExecutionResult) => string;
  inputSummary: (input: z.infer<TInput>) => string;
  confirmation: (input: z.infer<TInput>) => {
    label: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
  };
  execute: (
    input: z.infer<TInput>,
    context: AppAgentActionExecutionContext,
  ) => Promise<AppAgentActionExecutionResult>;
}

interface AppAgentActionExecutionContext {
  deps: AppAgentActionRegistryDeps;
  trace: AppAgentActionTrace;
}

const lowRiskImmediateActionLimit = 5;

const planActionInputSchema = z.object({
  roomIdentifier: z.string().nullable(),
  roomIdentifiers: z.array(z.string()).nullable(),
  excludeRoomIdentifiers: z.array(z.string()).nullable(),
  pinned: z.boolean().nullable(),
  archived: z.boolean().nullable(),
  mode: z.enum(["cloud", "local"]).nullable(),
});

const planActionSchema = z.object({
  actionId: z.string().min(1),
  input: planActionInputSchema,
  label: z.string().nullable(),
  description: z.string().nullable(),
});

const planInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable(),
  actions: z.array(planActionSchema).min(1).max(20),
});

const listRoomsInputSchema = z.object({
  includeArchived: z.boolean().nullable(),
});

const roomPinnedInputSchema = z.object({
  roomIdentifier: z.string().min(1),
  pinned: z.boolean(),
});

const roomsPinnedInputSchema = z.object({
  roomIdentifiers: z.array(z.string().min(1)).min(1).max(10),
  pinned: z.boolean(),
});

const roomArchivedInputSchema = z.object({
  roomIdentifier: z.string().min(1),
  archived: z.boolean(),
});

const roomsArchivedInputSchema = z.object({
  roomIdentifiers: z.array(z.string().min(1)).min(1).max(10),
  archived: z.boolean(),
});

const unpinnedRoomsArchivedInputSchema = z.object({
  excludeRoomIdentifiers: z.array(z.string().min(1)).nullable(),
  archived: z.boolean(),
});

const openRoomInputSchema = z.object({
  roomIdentifier: z.string().min(1),
});

const settingsGetInputSchema = z.object({});

const setChatStorageModeInputSchema = z.object({
  mode: z.enum(["cloud", "local"]),
});

function normalizeRoomText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function roomAliasCandidates(room: DesktopAccountRoomEntry): string[] {
  return [
    room.roomIdentifier,
    room.displayName,
    room.name,
  ]
    .map(normalizeRoomText)
    .filter((value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
    );
}

export function roomMatchesIdentifier(
  room: DesktopAccountRoomEntry,
  roomIdentifier: string,
): boolean {
  const expected = normalizeRoomText(roomIdentifier);
  if (!expected) return false;
  return roomAliasCandidates(room).some((candidate) => candidate === expected);
}

function uniqueRoomsByIdentifier(
  rooms: DesktopAccountRoomEntry[],
): DesktopAccountRoomEntry[] {
  const seen = new Set<string>();
  const unique: DesktopAccountRoomEntry[] = [];
  for (const room of rooms) {
    const key = normalizeRoomText(room.roomIdentifier || room.displayName || room.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(room);
  }
  return unique;
}

function toToolRoom(room: DesktopAccountRoomEntry): Record<string, unknown> {
  return {
    roomIdentifier: room.roomIdentifier,
    displayName: room.displayName,
    name: room.name,
    aliases: roomAliasCandidates(room),
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

function asActionInput(input: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function redactTraceText(value: string): string {
  return value
    .replace(/(api[_\s-]?key|authorization|bearer|token|secret)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/(sk-or-v1-)[A-Za-z0-9_-]+/g, "$1[redacted]");
}

function traceDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  const redacted = redactTraceText(value.trim());
  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted;
}

function logTraceEntry(entry: DesktopAppAgentTraceEntry): void {
  if (process.env.LETAGENTS_APP_AGENT_DEBUG !== "1") return;
  const parts = [
    `[app-agent] ${entry.status.toUpperCase()} ${entry.label}`,
    entry.actionId ? `action=${entry.actionId}` : null,
    entry.detail ? `detail=${entry.detail}` : null,
  ].filter(Boolean);
  console.info(parts.join(" | "));
}

function makeChoiceId(actionId: string, input: Record<string, unknown>): string {
  const basis = `${actionId}:${JSON.stringify(input)}`;
  let hash = 0;
  for (let index = 0; index < basis.length; index += 1) {
    hash = (hash * 31 + basis.charCodeAt(index)) >>> 0;
  }
  return `${actionId}:${hash.toString(36)}`;
}

function toPendingAction<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
): DesktopAppAgentPendingAction {
  const actionInput = asActionInput(input);
  const confirmation = action.confirmation(input);
  return {
    confirmationId: makeChoiceId(action.id, actionInput),
    actionId: action.id,
    input: actionInput,
    risk: action.risk,
    ...confirmation,
  };
}

function riskRank(risk: DesktopAppAgentActionRisk): number {
  if (risk === "destructive") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function maxRisk(
  risks: DesktopAppAgentActionRisk[],
): DesktopAppAgentActionRisk {
  return risks.reduce<DesktopAppAgentActionRisk>(
    (highest, risk) => riskRank(risk) > riskRank(highest) ? risk : highest,
    "low",
  );
}

function actionOperationCount(
  actionId: string,
  input: Record<string, unknown>,
): number {
  if (
    actionId === "rooms.pin_many" ||
    actionId === "rooms.archive_many"
  ) {
    const roomIdentifiers = input.roomIdentifiers;
    return Array.isArray(roomIdentifiers) ? Math.max(1, roomIdentifiers.length) : 1;
  }
  return 1;
}

function planOperationCount(plan: DesktopAppAgentActionPlan): number {
  return plan.actions.reduce(
    (total, action) => total + actionOperationCount(action.actionId, action.input),
    0,
  );
}

function actionNeedsConfirmation(
  action: AppAgentActionDefinition,
  input: Record<string, unknown>,
): boolean {
  if (action.requiresConfirmation || action.risk !== "low") return true;
  return actionOperationCount(action.id, input) > lowRiskImmediateActionLimit;
}

function planNeedsConfirmation(plan: DesktopAppAgentActionPlan): boolean {
  if (plan.risk !== "low") return true;
  return planOperationCount(plan) > lowRiskImmediateActionLimit;
}

async function resolvedActionCopy<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  deps: AppAgentActionRegistryDeps,
): Promise<{
  label: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
}> {
  const fallback = action.confirmation(input);
  if (action.id === "rooms.pin") {
    const parsed = roomPinnedInputSchema.parse(input);
    const room = await requireRoom(deps, parsed.roomIdentifier);
    const verb = parsed.pinned ? "Pin" : "Unpin";
    return {
      ...fallback,
      label: `${verb} ${room.displayName}`,
      description: `${verb} ${room.displayName}.`,
    };
  }
  if (action.id === "rooms.pin_many") {
    const parsed = roomsPinnedInputSchema.parse(input);
    const rooms = await findRooms(deps, parsed.roomIdentifiers);
    const verb = parsed.pinned ? "Pin" : "Unpin";
    return {
      ...fallback,
      label: `${verb} ${rooms.length} rooms`,
      description: `${verb} ${joinRoomNames(rooms)}.`,
    };
  }
  if (action.id === "rooms.archive") {
    const parsed = roomArchivedInputSchema.parse(input);
    const room = await requireRoom(deps, parsed.roomIdentifier);
    const verb = parsed.archived ? "Archive" : "Restore";
    return {
      ...fallback,
      label: `${verb} ${room.displayName}`,
      description: `${verb} ${room.displayName}?`,
    };
  }
  if (action.id === "rooms.archive_many") {
    const parsed = roomsArchivedInputSchema.parse(input);
    const rooms = await findRooms(deps, parsed.roomIdentifiers);
    const verb = parsed.archived ? "Archive" : "Restore";
    return {
      ...fallback,
      label: `${verb} ${rooms.length} rooms`,
      description: `${verb} ${joinRoomNames(rooms)}?`,
    };
  }
  if (action.id === "rooms.archive_unpinned") {
    const parsed = unpinnedRoomsArchivedInputSchema.parse(input);
    const rooms = await findUnpinnedRooms(deps, parsed.excludeRoomIdentifiers);
    if (!rooms.length) {
      throw new Error("There are no unpinned rooms to archive.");
    }
    return {
      ...fallback,
      label: "Archive unpinned rooms",
      description: `Archive ${joinRoomNames(rooms)}?`,
    };
  }
  if (action.id === "rooms.open") {
    const parsed = openRoomInputSchema.parse(input);
    const room = await requireRoom(deps, parsed.roomIdentifier);
    return {
      ...fallback,
      label: `Open ${room.displayName}`,
      description: `Open ${room.displayName}.`,
    };
  }
  return fallback;
}

async function toDisplayActionReference<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  deps: AppAgentActionRegistryDeps,
): Promise<DesktopAppAgentActionReference> {
  const actionInput = asActionInput(input);
  const copy = await resolvedActionCopy(action, input, deps);
  return {
    actionId: action.id,
    input: actionInput,
    label: copy.label,
    description: copy.description,
    risk: action.risk,
    refreshTargets: action.refreshTargets,
  };
}

async function resolvedPendingAction<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  deps: AppAgentActionRegistryDeps,
): Promise<DesktopAppAgentPendingAction> {
  const pendingAction = toPendingAction(action, input);
  const copy = await resolvedActionCopy(action, input, deps);
  pendingAction.label = copy.label;
  pendingAction.description = copy.description;
  pendingAction.confirmLabel = copy.confirmLabel;
  pendingAction.cancelLabel = copy.cancelLabel;
  return pendingAction;
}

async function findRoom(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
): Promise<DesktopAccountRoomEntry | null> {
  const expected = normalizeRoomText(roomIdentifier);
  if (!expected) return null;
  const rooms = await deps.listAccountRooms({
    includeArchived: true,
    limit: 100,
  });
  const canonicalMatches = uniqueRoomsByIdentifier(
    rooms.filter((room) => normalizeRoomText(room.roomIdentifier) === expected),
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) {
    throw new Error(`Multiple rooms match "${roomIdentifier}". Please choose one.`);
  }
  const aliasMatches = uniqueRoomsByIdentifier(
    rooms.filter((room) => roomMatchesIdentifier(room, roomIdentifier)),
  );
  if (aliasMatches.length === 1) return aliasMatches[0];
  if (aliasMatches.length > 1) {
    throw new Error(`Multiple rooms match "${roomIdentifier}". Please choose one.`);
  }
  return null;
}

async function requireRoom(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
): Promise<DesktopAccountRoomEntry> {
  const room = await findRoom(deps, roomIdentifier);
  if (!room) {
    throw new Error(`I don't see a room called "${roomIdentifier}" in your account.`);
  }
  return room;
}

async function findRooms(
  deps: AppAgentActionRegistryDeps,
  roomIdentifiers: string[],
): Promise<DesktopAccountRoomEntry[]> {
  const resolved: DesktopAccountRoomEntry[] = [];
  for (const roomIdentifier of roomIdentifiers) {
    const room = await findRoom(deps, roomIdentifier);
    if (!room) {
      throw new Error(`I don't see a room called "${roomIdentifier}" in your account.`);
    }
    resolved.push(room);
  }
  return uniqueRoomsByIdentifier(resolved);
}

async function findUnpinnedRooms(
  deps: AppAgentActionRegistryDeps,
  excludeRoomIdentifiers: string[] | null | undefined,
): Promise<DesktopAccountRoomEntry[]> {
  const rooms = await deps.listAccountRooms({
    includeArchived: false,
    limit: 100,
  });
  const excluded = excludeRoomIdentifiers || [];
  return rooms.filter(
    (room) =>
      !room.pinned &&
      !excluded.some((roomIdentifier) => roomMatchesIdentifier(room, roomIdentifier)),
  );
}

async function verifyRoomPinned(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
  pinned: boolean,
): Promise<void> {
  const room = await findRoom(deps, roomIdentifier);
  if (!room || room.pinned !== pinned) {
    throw new Error(`The room "${roomIdentifier}" was not ${pinned ? "pinned" : "unpinned"}.`);
  }
}

async function verifyRoomArchived(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
  archived: boolean,
): Promise<void> {
  const room = await findRoom(deps, roomIdentifier);
  if (!room || room.archived !== archived) {
    throw new Error(`The room "${roomIdentifier}" was not ${archived ? "archived" : "restored"}.`);
  }
}

function joinRoomNames(rooms: Array<{ displayName: string }>): string {
  if (rooms.length === 1) return rooms[0].displayName;
  if (rooms.length === 2) return `${rooms[0].displayName} and ${rooms[1].displayName}`;
  return `${rooms.slice(0, -1).map((room) => room.displayName).join(", ")}, and ${rooms[rooms.length - 1].displayName}`;
}

function collectArchivedActionResult(
  result: AppAgentActionExecutionResult,
  identifiers: Set<string>,
  rooms: Array<Record<string, unknown>>,
): void {
  addArchivedIdentifier(identifiers, result.roomIdentifier);
  addArchivedRoom(rooms, {
    roomIdentifier: result.roomIdentifier,
    displayName: result.displayName,
  });
  const actionResult = result.actionResult;
  if (!actionResult || typeof actionResult !== "object") return;
  addArchivedIdentifier(identifiers, actionResult.roomIdentifier);
  addArchivedIdentifier(identifiers, actionResult.displayName);
  const roomIdentifiers = actionResult.roomIdentifiers;
  if (Array.isArray(roomIdentifiers)) {
    for (const roomIdentifier of roomIdentifiers) {
      addArchivedIdentifier(identifiers, roomIdentifier);
    }
  }
  const archivedRoomIdentifiers = actionResult.archivedRoomIdentifiers;
  if (Array.isArray(archivedRoomIdentifiers)) {
    for (const roomIdentifier of archivedRoomIdentifiers) {
      addArchivedIdentifier(identifiers, roomIdentifier);
    }
  }
  const actionRooms = actionResult.rooms;
  if (Array.isArray(actionRooms)) {
    for (const room of actionRooms) {
      addArchivedRoom(rooms, room);
      if (room && typeof room === "object" && "roomIdentifier" in room) {
        addArchivedIdentifier(
          identifiers,
          (room as Record<string, unknown>).roomIdentifier,
        );
      }
    }
  }
  const archivedActionRooms = actionResult.archivedRooms;
  if (Array.isArray(archivedActionRooms)) {
    for (const room of archivedActionRooms) {
      addArchivedRoom(rooms, room);
      if (room && typeof room === "object" && "roomIdentifier" in room) {
        addArchivedIdentifier(
          identifiers,
          (room as Record<string, unknown>).roomIdentifier,
        );
      }
    }
  }
}

function addArchivedIdentifier(identifiers: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized) identifiers.add(normalized);
}

function addArchivedRoom(
  rooms: Array<Record<string, unknown>>,
  value: unknown,
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.roomIdentifier !== "string" && typeof record.displayName !== "string") {
    return;
  }
  rooms.push({
    roomIdentifier: record.roomIdentifier || null,
    displayName: record.displayName || null,
  });
}

export function createAppAgentActionTrace(): AppAgentActionTrace {
  const traceEntries: DesktopAppAgentTraceEntry[] = [];
  const executionSummaries: DesktopAppAgentActionExecutionSummary[] = [];
  const refreshTargetSet = new Set<DesktopAppAgentRefreshTarget>();
  let traceId = 0;
  return {
    add: (label, options = {}) => {
      traceId += 1;
      const entry = {
        id: `trace_${traceId}`,
        label: redactTraceText(label),
        status: options.status || "info",
        detail: traceDetail(options.detail),
        actionId: options.actionId || null,
      };
      traceEntries.push(entry);
      logTraceEntry(entry);
    },
    addRefreshTargets: (targets) => {
      for (const target of targets) {
        refreshTargetSet.add(target);
      }
    },
    recordExecution: (summary) => {
      executionSummaries.push({
        ...summary,
        message: redactTraceText(summary.message),
      });
    },
    entries: () => [...traceEntries],
    executions: () => executionSummaries.map((summary) => ({ ...summary })),
    refreshTargets: () => [...refreshTargetSet],
  };
}

const appAgentActionDisplayCopy: Record<string, {
  displayName: string;
  capabilityName: string;
  displayDescription: string;
}> = {
  "rooms.list": {
    displayName: "View rooms",
    capabilityName: "Room inventory",
    displayDescription:
      "Shows the rooms the App Agent can reason over, including pinned and archived state.",
  },
  "rooms.pin": {
    displayName: "Pin or unpin a room",
    capabilityName: "Single-room pinning",
    displayDescription:
      "Keeps one room in the pinned section, or removes it from there.",
  },
  "rooms.pin_many": {
    displayName: "Pin or unpin rooms",
    capabilityName: "Multi-room pinning",
    displayDescription:
      "Updates the pinned state for several rooms in one request.",
  },
  "rooms.archive": {
    displayName: "Archive or restore a room",
    capabilityName: "Single-room archiving",
    displayDescription:
      "Moves one room out of active lists, or brings it back.",
  },
  "rooms.archive_many": {
    displayName: "Archive or restore rooms",
    capabilityName: "Multi-room archiving",
    displayDescription:
      "Moves several rooms out of active lists, or brings them back.",
  },
  "rooms.archive_unpinned": {
    displayName: "Archive unpinned rooms",
    capabilityName: "Unpinned-room cleanup",
    displayDescription:
      "Finds unpinned rooms and previews the target set before archiving.",
  },
  "rooms.open": {
    displayName: "Open a room",
    capabilityName: "Room switching",
    displayDescription:
      "Switches the desktop app to the selected room.",
  },
  "settings.get": {
    displayName: "Read app settings",
    capabilityName: "Settings overview",
    displayDescription:
      "Lets the App Agent inspect safe settings such as storage mode and setup state.",
  },
  "settings.set_chat_storage_mode": {
    displayName: "Change chat storage",
    capabilityName: "Chat storage control",
    displayDescription:
      "Switches where new chat messages are stored.",
  },
};

function actionMutatesState(actionId: string): boolean {
  return actionId !== "rooms.list" && actionId !== "settings.get";
}

function actionExecutionSummary<TInput extends z.ZodTypeAny>(
  action: AppAgentActionDefinition<TInput>,
  input: z.infer<TInput>,
  result: AppAgentActionExecutionResult | null,
  status: DesktopAppAgentActionExecutionSummary["status"],
  message?: string,
): DesktopAppAgentActionExecutionSummary {
  const safeMessage = message || result?.message || (
    status === "skipped"
      ? "Skipped after an earlier action failed."
      : "Action failed."
  );
  return {
    actionId: action.id,
    label: status === "success" && result
      ? action.resultLabel(input, result)
      : action.inputSummary(input),
    description: null,
    status,
    message: redactTraceText(safeMessage),
    roomIdentifier: result?.roomIdentifier || null,
    displayName: result?.displayName || null,
  };
}

function roomExecutionSummary(input: {
  actionId: string;
  label: string;
  room: DesktopAccountRoomEntry;
  status: DesktopAppAgentActionExecutionSummary["status"];
  message: string;
}): DesktopAppAgentActionExecutionSummary {
  return {
    actionId: input.actionId,
    label: input.label,
    description: null,
    status: input.status,
    message: redactTraceText(input.message),
    roomIdentifier: input.room.roomIdentifier,
    displayName: input.room.displayName,
  };
}

function safeActionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? redactTraceText(error.message) : fallback;
}

export class AppActionRegistry {
  private readonly actions = new Map<string, AppAgentActionDefinition>();

  constructor(private readonly deps: AppAgentActionRegistryDeps) {}

  register<TInput extends z.ZodTypeAny>(
    action: AppAgentActionDefinition<TInput>,
  ): this {
    this.actions.set(action.id, action as AppAgentActionDefinition);
    return this;
  }

  get(actionId: string): AppAgentActionDefinition | null {
    return this.actions.get(actionId) || null;
  }

  list(): AppAgentActionDefinition[] {
    return [...this.actions.values()];
  }

  listMetadata(): DesktopAppAgentActionMetadata[] {
    return this.list().map((action) => ({
      id: action.id,
      toolName: action.toolName,
      displayName:
        appAgentActionDisplayCopy[action.id]?.displayName || action.id,
      capabilityName:
        appAgentActionDisplayCopy[action.id]?.capabilityName || action.id,
      description: action.description,
      displayDescription:
        appAgentActionDisplayCopy[action.id]?.displayDescription || action.description,
      category: action.category,
      risk: action.risk,
      requiresConfirmation: action.requiresConfirmation,
      refreshTargets: [...action.refreshTargets],
    }));
  }

  actionReference(actionId: string, input: Record<string, unknown>): DesktopAppAgentActionReference | null {
    const action = this.get(actionId);
    if (!action) return null;
    const parsed = action.inputSchema.parse(input) as Record<string, unknown>;
    return {
      actionId: action.id,
      input: asActionInput(parsed),
      label: action.confirmation(parsed).label,
      description: action.confirmation(parsed).description,
      risk: action.risk,
      refreshTargets: action.refreshTargets,
    };
  }

  actionChoice(input: {
    label: string;
    description: string;
    actionId: string;
    actionInput: Record<string, unknown>;
  }): DesktopAppAgentActionChoice {
    const action = this.get(input.actionId);
    if (!action) {
      throw new Error(`Unknown App Agent action: ${input.actionId}`);
    }
    const parsed = action.inputSchema.parse(input.actionInput) as Record<string, unknown>;
    return {
      choiceId: makeChoiceId(action.id, parsed),
      label: input.label,
      description: input.description,
      actionId: action.id,
      input: asActionInput(parsed),
      risk: action.risk,
    };
  }

  pendingAction(actionId: string, input: Record<string, unknown>): DesktopAppAgentPendingAction {
    const action = this.get(actionId);
    if (!action) {
      throw new Error(`Unknown App Agent action: ${actionId}`);
    }
    const parsed = action.inputSchema.parse(input);
    return toPendingAction(action, parsed);
  }

  async pendingActionForDisplay(
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<DesktopAppAgentPendingAction> {
    const displayActions = await this.actionReferencesForDisplay(actionId, input);
    if (
      displayActions.length === 1 &&
      displayActions[0] &&
      displayActions[0].actionId !== actionId
    ) {
      return this.pendingActionForDisplay(
        displayActions[0].actionId,
        displayActions[0].input,
      );
    }
    const action = this.get(actionId);
    if (!action) {
      throw new Error(`Unknown App Agent action: ${actionId}`);
    }
    const parsed = action.inputSchema.parse(input);
    return resolvedPendingAction(action, parsed, this.deps);
  }

  async actionReferenceForDisplay(
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<DesktopAppAgentActionReference> {
    const action = this.get(actionId);
    if (!action) {
      throw new Error(`Unknown App Agent action: ${actionId}`);
    }
    const parsed = action.inputSchema.parse(input);
    return toDisplayActionReference(action, parsed, this.deps);
  }

  async actionReferencesForDisplay(
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<DesktopAppAgentActionReference[]> {
    if (actionId === "rooms.archive_unpinned") {
      const parsed = unpinnedRoomsArchivedInputSchema.parse(input);
      if (!parsed.archived) {
        throw new Error("Unpinned-room batch action only supports archiving.");
      }
      const rooms = await findUnpinnedRooms(
        this.deps,
        parsed.excludeRoomIdentifiers,
      );
      if (!rooms.length) {
        throw new Error("There are no unpinned rooms to archive.");
      }
      return [
        await this.actionReferenceForDisplay("rooms.archive_many", {
          roomIdentifiers: rooms.map((room) => room.roomIdentifier),
          archived: true,
        }),
      ];
    }
    return [await this.actionReferenceForDisplay(actionId, input)];
  }

  actionRequiresConfirmation(actionRef: DesktopAppAgentActionReference): boolean {
    const action = this.get(actionRef.actionId);
    if (!action) {
      throw new Error(`Unknown App Agent action: ${actionRef.actionId}`);
    }
    const input = action.inputSchema.parse(actionRef.input) as Record<string, unknown>;
    return actionNeedsConfirmation(action, input);
  }

  async preparePlanForDisplay(input: {
    title: string;
    description?: string | null;
    actions: Array<{
      actionId: string;
      input: Record<string, unknown>;
      label?: string | null;
      description?: string | null;
    }>;
  }): Promise<DesktopAppAgentActionPlan> {
    if (!input.actions.length) {
      throw new Error("Add at least one App Agent action to the plan.");
    }
    const actions: DesktopAppAgentActionReference[] = [];
    for (const actionInput of input.actions) {
      actions.push(
        ...(await this.actionReferencesForDisplay(
          actionInput.actionId,
          actionInput.input,
        )),
      );
    }
    const refreshTargets = new Set<DesktopAppAgentRefreshTarget>();
    for (const action of actions) {
      for (const target of action.refreshTargets || []) {
        refreshTargets.add(target);
      }
    }
    const risk = maxRisk(actions.map((action) => action.risk));
    const description = input.description?.trim()
      || actions.map((action) => action.description || action.label).join(" ");
    const title = input.title.trim() || actions[0]?.label || "App Agent plan";
    const planInput = {
      title,
      actions: actions.map((action) => ({
        actionId: action.actionId,
        input: action.input,
      })),
    };
    return {
      planId: makeChoiceId("plan", planInput),
      title,
      description,
      actions,
      risk,
      confirmLabel: risk === "low" ? "Run" : "Confirm",
      cancelLabel: "Cancel",
      refreshTargets: [...refreshTargets],
    };
  }

  planRequiresConfirmation(plan: DesktopAppAgentActionPlan): boolean {
    return planNeedsConfirmation(plan);
  }

  async pendingPlanForAction(
    actionRef: DesktopAppAgentActionReference,
  ): Promise<DesktopAppAgentActionPlan> {
    return this.preparePlanForDisplay({
      title: actionRef.label,
      description: actionRef.description || actionRef.label,
      actions: [actionRef],
    });
  }

  async executePlan(
    plan: DesktopAppAgentActionPlan,
    options: {
      confirmed?: boolean;
      trace: AppAgentActionTrace;
    },
  ): Promise<AppAgentActionExecutionResult> {
    const validatedPlan = await this.preparePlanForDisplay({
      title: plan.title,
      description: plan.description,
      actions: plan.actions,
    });
    if (this.planRequiresConfirmation(validatedPlan) && !options.confirmed) {
      options.trace.add("Plan confirmation needed", {
        status: "info",
        detail: validatedPlan.title,
        actionId: "app.plan",
      });
      return {
        ok: false,
        message: validatedPlan.description,
        refreshTargets: [],
        actionResult: {
          confirmationRequired: true,
          pendingPlan: validatedPlan,
        },
      };
    }

    options.trace.add("Execute action plan", {
      status: "info",
      detail: `${validatedPlan.actions.length} actions`,
      actionId: "app.plan",
    });
    const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
    const refreshTargets = new Set<DesktopAppAgentRefreshTarget>();
    const archivedRoomIdentifiers = new Set<string>();
    const archivedRooms: Array<Record<string, unknown>> = [];
    let firstRoomIdentifier: string | null = null;
    let firstDisplayName: string | null = null;
    let openRoomIdentifier: string | null = null;
    let pinned: boolean | null = null;
    let archived: boolean | null = null;
    let failed = false;

    for (let index = 0; index < validatedPlan.actions.length; index += 1) {
      const action = validatedPlan.actions[index];
      if (failed) {
        executedActions.push({
          actionId: action.actionId,
          label: action.label,
          description: action.description || null,
          status: "skipped",
          message: "Skipped after an earlier action failed.",
          roomIdentifier: null,
          displayName: null,
        });
        continue;
      }
      try {
        const result = await this.execute(action, {
          confirmed: true,
          trace: options.trace,
        });
        if (result.ok === false) {
          failed = true;
          executedActions.push(result.executedActions?.[0] || {
            actionId: action.actionId,
            label: action.label,
            description: action.description || null,
            status: "error",
            message: result.message,
            roomIdentifier: result.roomIdentifier || null,
            displayName: result.displayName || null,
          });
          continue;
        }
        if (!firstRoomIdentifier && result.roomIdentifier) {
          firstRoomIdentifier = result.roomIdentifier;
        }
        if (!firstDisplayName && result.displayName) {
          firstDisplayName = result.displayName;
        }
        if (result.openRoomIdentifier) {
          openRoomIdentifier = result.openRoomIdentifier;
        }
        if (typeof result.pinned === "boolean") {
          pinned = pinned === null ? result.pinned : pinned === result.pinned ? pinned : null;
        }
        if (result.archived === true) {
          archived = true;
          collectArchivedActionResult(result, archivedRoomIdentifiers, archivedRooms);
        }
        for (const target of result.refreshTargets || action.refreshTargets || []) {
          refreshTargets.add(target);
        }
        executedActions.push({
          actionId: action.actionId,
          label: action.label,
          description: action.description || null,
          status: "success",
          message: result.message,
          roomIdentifier: result.roomIdentifier || null,
          displayName: result.displayName || null,
        });
      } catch (error) {
        failed = true;
        executedActions.push({
          actionId: action.actionId,
          label: action.label,
          description: action.description || null,
          status: "error",
          message: error instanceof Error ? redactTraceText(error.message) : "Action failed.",
          roomIdentifier: null,
          displayName: null,
        });
      }
    }

    const completed = executedActions.filter((action) => action.status === "success").length;
    const message = failed
      ? `Stopped after ${completed} of ${validatedPlan.actions.length} actions.`
      : completed === 1
        ? executedActions.find((action) => action.status === "success")?.message || "Completed 1 action."
        : `Completed ${completed} actions.`;
    return {
      ok: !failed,
      message,
      roomIdentifier: firstRoomIdentifier,
      displayName: firstDisplayName,
      pinned,
      archived,
      openRoomIdentifier,
      refreshTargets: [...refreshTargets],
      executedActions,
      actionResult: {
        executedActions,
        archivedRoomIdentifiers: [...archivedRoomIdentifiers],
        archivedRooms,
      },
    };
  }

  async execute(
    actionRef: DesktopAppAgentActionReference,
    options: {
      confirmed?: boolean;
      trace: AppAgentActionTrace;
    },
  ): Promise<AppAgentActionExecutionResult> {
    const action = this.get(actionRef.actionId);
    if (!action) {
      throw new Error(`Unknown App Agent action: ${actionRef.actionId}`);
    }
    const input = action.inputSchema.parse(actionRef.input);
    if (
      actionNeedsConfirmation(action, input as Record<string, unknown>) &&
      !options.confirmed
    ) {
      options.trace.add("Confirmation needed", {
        status: "info",
        detail: action.inputSummary(input),
        actionId: action.id,
      });
      return {
        ok: false,
        message: action.confirmation(input).description,
        actionResult: { confirmationRequired: true },
      };
    }

    options.trace.add(`Execute ${action.toolName}`, {
      status: "info",
      detail: action.inputSummary(input),
      actionId: action.id,
    });
    let result: AppAgentActionExecutionResult;
    try {
      result = await action.execute(input, {
        deps: this.deps,
        trace: options.trace,
      });
    } catch (error) {
      const message = error instanceof Error ? redactTraceText(error.message) : "Action failed.";
      options.trace.add(`Failed ${action.toolName}`, {
        status: "error",
        detail: message,
        actionId: action.id,
      });
      const executedActions = [actionExecutionSummary(action, input, null, "error", message)];
      if (actionMutatesState(action.id)) {
        options.trace.recordExecution(executedActions[0]);
      }
      return {
        ok: false,
        message,
        refreshTargets: action.refreshTargets,
        executedActions,
      };
    }
    const status = result.ok === false ? "error" : "success";
    options.trace.add(
      status === "success"
        ? action.resultLabel(input, result)
        : `Failed ${action.toolName}`,
      {
        status,
        detail: result.message,
        actionId: action.id,
      },
    );
    options.trace.addRefreshTargets(result.refreshTargets || action.refreshTargets);
    const executedActions = result.executedActions?.length
      ? result.executedActions
      : [actionExecutionSummary(action, input, result, status)];
    if (actionMutatesState(action.id)) {
      for (const summary of executedActions || []) {
        options.trace.recordExecution(summary);
      }
    }
    return {
      ...result,
      refreshTargets: result.refreshTargets || action.refreshTargets,
      executedActions,
    };
  }

  tools(trace: AppAgentActionTrace) {
    const actionTools = this.list().map((action) =>
      tool({
        name: action.toolName,
        description: action.description,
        parameters: action.inputSchema as z.ZodObject<Record<string, z.ZodTypeAny>>,
        strict: true,
        execute: async (rawInput: unknown) => {
          const input = action.inputSchema.parse(rawInput);
          trace.add(`Call ${action.toolName}`, {
            status: "info",
            detail: action.inputSummary(input),
            actionId: action.id,
          });
          if (actionNeedsConfirmation(action, input as Record<string, unknown>)) {
            const pendingAction = await resolvedPendingAction(action, input, this.deps);
            const pendingPlan = await this.preparePlanForDisplay({
              title: pendingAction.label,
              description: pendingAction.description,
              actions: [pendingAction],
            });
            trace.add("Confirmation needed", {
              status: "info",
              detail: action.inputSummary(input),
              actionId: action.id,
            });
            return {
              ok: false,
              confirmationRequired: true,
              message: pendingPlan.description,
              pendingAction,
              pendingPlan,
            };
          }
          let result: AppAgentActionExecutionResult;
          try {
            result = await action.execute(input, {
              deps: this.deps,
              trace,
            });
          } catch (error) {
            const message = error instanceof Error ? redactTraceText(error.message) : "Action failed.";
            trace.add(`Failed ${action.toolName}`, {
              status: "error",
              detail: message,
              actionId: action.id,
            });
            if (actionMutatesState(action.id)) {
              trace.recordExecution(actionExecutionSummary(action, input, null, "error", message));
            }
            throw error;
          }
          const status = result.ok === false ? "error" : "success";
          trace.add(
            status === "success"
              ? action.resultLabel(input, result)
              : `Failed ${action.toolName}`,
            {
              status,
              detail: result.message,
              actionId: action.id,
            },
          );
          trace.addRefreshTargets(result.refreshTargets || action.refreshTargets);
          const executedActions = result.executedActions?.length
            ? result.executedActions
            : [actionExecutionSummary(action, input, result, status)];
          if (actionMutatesState(action.id)) {
            for (const summary of executedActions || []) {
              trace.recordExecution(summary);
            }
          }
          return {
            ok: true,
            ...result,
            refreshTargets: result.refreshTargets || action.refreshTargets,
            executedActions,
          };
        },
      }),
    );
    return [
      ...actionTools,
      tool({
        name: "prepare_app_action_plan",
        description:
          "Validate and preview a grouped App Agent action plan without mutating app state. Use for broad filters, multi-step requests, or any plan that needs confirmation.",
        parameters: planInputSchema,
        strict: true,
        execute: async (rawInput: unknown) => {
          const input = planInputSchema.parse(rawInput);
          trace.add("Call prepare_app_action_plan", {
            status: "info",
            detail: `${input.actions.length} actions`,
            actionId: "app.plan",
          });
          const pendingPlan = await this.preparePlanForDisplay({
            title: input.title,
            description: input.description,
            actions: input.actions.map((action) => ({
              actionId: action.actionId,
              input: action.input,
              label: action.label,
              description: action.description,
            })),
          });
          trace.add("Prepared action plan", {
            status: "success",
            detail: pendingPlan.title,
            actionId: "app.plan",
          });
          return {
            ok: true,
            confirmationRequired: this.planRequiresConfirmation(pendingPlan),
            message: pendingPlan.description,
            pendingPlan,
          };
        },
      }),
    ];
  }
}

export function createAppActionRegistry(
  deps: AppAgentActionRegistryDeps,
): AppActionRegistry {
  return new AppActionRegistry(deps)
    .register({
      id: "rooms.list",
      toolName: "list_account_rooms",
      description:
        "List the user's LetAgents rooms with identifiers, names, pinned state, archived state, focus rooms, and timestamps.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: [],
      inputSchema: listRoomsInputSchema,
      inputSummary: () => "Listed rooms",
      resultLabel: () => "Listed rooms",
      confirmation: () => ({
        label: "List rooms",
        description: "List visible LetAgents rooms.",
        confirmLabel: "List",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const rooms = await context.deps.listAccountRooms({
          includeArchived: input.includeArchived === true,
          limit: 100,
        });
        return {
          message: `Found ${rooms.length} rooms.`,
          actionResult: { rooms: rooms.map(toToolRoom) },
        };
      },
    })
    .register({
      id: "rooms.pin",
      toolName: "set_room_pinned",
      description:
        "Pin or unpin exactly one account room by roomIdentifier. Use only when the user intent and room match are unambiguous.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomPinnedInputSchema,
      inputSummary: (input) => `${input.pinned ? "Pin" : "Unpin"} room`,
      resultLabel: (_input, result) =>
        `${result?.pinned ? "Pinned" : "Unpinned"} ${result?.displayName || "room"}`,
      confirmation: (input) => ({
        label: `${input.pinned ? "Pin" : "Unpin"} room`,
        description: `${input.pinned ? "Pin" : "Unpin"} ${input.roomIdentifier}.`,
        confirmLabel: input.pinned ? "Pin" : "Unpin",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const room = await findRoom(context.deps, input.roomIdentifier);
        if (!room) {
          throw new Error(`I don't see a room called "${input.roomIdentifier}" in your account.`);
        }
        const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
          pinned: input.pinned,
        });
        await verifyRoomPinned(context.deps, room.roomIdentifier, input.pinned);
        return {
          message: `${input.pinned ? "Pinned" : "Unpinned"} ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          pinned: input.pinned,
          actionResult: actionResult as unknown as Record<string, unknown>,
        };
      },
    })
    .register({
      id: "rooms.pin_many",
      toolName: "set_rooms_pinned",
      description:
        "Pin or unpin multiple account rooms by roomIdentifiers. Use when the user asks to pin or unpin more than one room.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomsPinnedInputSchema,
      inputSummary: (input) => `${input.pinned ? "Pin" : "Unpin"} ${input.roomIdentifiers.length} rooms`,
      resultLabel: (input) => `${input.pinned ? "Pinned" : "Unpinned"} ${input.roomIdentifiers.length} rooms`,
      confirmation: (input) => ({
        label: `${input.pinned ? "Pin" : "Unpin"} rooms`,
        description: `${input.pinned ? "Pin" : "Unpin"} ${input.roomIdentifiers.join(", ")}.`,
        confirmLabel: input.pinned ? "Pin" : "Unpin",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const rooms = await findRooms(context.deps, input.roomIdentifiers);
        const actionResults: Record<string, unknown>[] = [];
        const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
        const successRooms: DesktopAccountRoomEntry[] = [];
        const verb = input.pinned ? "Pin" : "Unpin";
        const pastVerb = input.pinned ? "Pinned" : "Unpinned";
        for (let index = 0; index < rooms.length; index += 1) {
          const room = rooms[index];
          try {
            const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
              pinned: input.pinned,
            });
            await verifyRoomPinned(context.deps, room.roomIdentifier, input.pinned);
            actionResults.push(actionResult as unknown as Record<string, unknown>);
            successRooms.push(room);
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.pin",
              label: `${verb} ${room.displayName}`,
              room,
              status: "success",
              message: `${pastVerb} ${room.displayName}.`,
            }));
          } catch (error) {
            const failedMessage = safeActionErrorMessage(
              error,
              `Could not ${verb.toLowerCase()} ${room.displayName}.`,
            );
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.pin",
              label: `${verb} ${room.displayName}`,
              room,
              status: "error",
              message: failedMessage,
            }));
            for (const skippedRoom of rooms.slice(index + 1)) {
              executedActions.push(roomExecutionSummary({
                actionId: "rooms.pin",
                label: `${verb} ${skippedRoom.displayName}`,
                room: skippedRoom,
                status: "skipped",
                message: "Skipped after an earlier room action failed.",
              }));
            }
            return {
              ok: false,
              message: `Stopped after ${successRooms.length} of ${rooms.length} rooms. ${failedMessage}`,
              roomIdentifier: room.roomIdentifier,
              displayName: joinRoomNames(rooms),
              pinned: input.pinned,
              refreshTargets: ["rooms", "active_room", "foreground"],
              executedActions,
              actionResult: {
                rooms: actionResults,
                roomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                targetRoomIdentifiers: rooms.map((targetRoom) => targetRoom.roomIdentifier),
              },
            };
          }
        }
        return {
          message: `${input.pinned ? "Pinned" : "Unpinned"} ${joinRoomNames(rooms)}.`,
          roomIdentifier: rooms[0]?.roomIdentifier || null,
          displayName: joinRoomNames(rooms),
          pinned: input.pinned,
          executedActions,
          actionResult: {
            rooms: actionResults,
            roomIdentifiers: rooms.map((room) => room.roomIdentifier),
          },
        };
      },
    })
    .register({
      id: "rooms.archive",
      toolName: "set_room_archived",
      description:
        "Archive or restore exactly one account room by roomIdentifier. Archiving removes the room from active room lists.",
      category: "rooms",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomArchivedInputSchema,
      inputSummary: (input) => `${input.archived ? "Archive" : "Restore"} room`,
      resultLabel: (_input, result) =>
        `${result?.archived ? "Archived" : "Restored"} ${result?.displayName || "room"}`,
      confirmation: (input) => ({
        label: `${input.archived ? "Archive" : "Restore"} room`,
        description: `${input.archived ? "Archive" : "Restore"} ${input.roomIdentifier}?`,
        confirmLabel: input.archived ? "Archive" : "Restore",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const room = await findRoom(context.deps, input.roomIdentifier);
        if (!room) {
          throw new Error(`I don't see a room called "${input.roomIdentifier}" in your account.`);
        }
        const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
          archived: input.archived,
        });
        await verifyRoomArchived(context.deps, room.roomIdentifier, input.archived);
        return {
          message: `${input.archived ? "Archived" : "Restored"} ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          archived: input.archived,
          actionResult: {
            ...(actionResult as unknown as Record<string, unknown>),
            roomIdentifier: room.roomIdentifier,
            displayName: room.displayName,
            archivedRoomIdentifiers: input.archived ? [room.roomIdentifier] : [],
            archivedRooms: input.archived ? [toToolRoom(room)] : [],
          },
        };
      },
    })
    .register({
      id: "rooms.archive_many",
      toolName: "set_rooms_archived",
      description:
        "Archive or restore multiple account rooms by roomIdentifiers. Use when the user asks to archive, hide, restore, or unarchive more than one room.",
      category: "rooms",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: roomsArchivedInputSchema,
      inputSummary: (input) => `${input.archived ? "Archive" : "Restore"} ${input.roomIdentifiers.length} rooms`,
      resultLabel: (input) => `${input.archived ? "Archived" : "Restored"} ${input.roomIdentifiers.length} rooms`,
      confirmation: (input) => ({
        label: `${input.archived ? "Archive" : "Restore"} rooms`,
        description: `${input.archived ? "Archive" : "Restore"} ${input.roomIdentifiers.join(" and ")}?`,
        confirmLabel: input.archived ? "Archive" : "Restore",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const rooms = await findRooms(context.deps, input.roomIdentifiers);
        const actionResults: Record<string, unknown>[] = [];
        const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
        const successRooms: DesktopAccountRoomEntry[] = [];
        const verb = input.archived ? "Archive" : "Restore";
        const pastVerb = input.archived ? "Archived" : "Restored";
        for (let index = 0; index < rooms.length; index += 1) {
          const room = rooms[index];
          try {
            const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
              archived: input.archived,
            });
            await verifyRoomArchived(context.deps, room.roomIdentifier, input.archived);
            actionResults.push(actionResult as unknown as Record<string, unknown>);
            successRooms.push(room);
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `${verb} ${room.displayName}`,
              room,
              status: "success",
              message: `${pastVerb} ${room.displayName}.`,
            }));
          } catch (error) {
            const failedMessage = safeActionErrorMessage(
              error,
              `Could not ${verb.toLowerCase()} ${room.displayName}.`,
            );
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `${verb} ${room.displayName}`,
              room,
              status: "error",
              message: failedMessage,
            }));
            for (const skippedRoom of rooms.slice(index + 1)) {
              executedActions.push(roomExecutionSummary({
                actionId: "rooms.archive",
                label: `${verb} ${skippedRoom.displayName}`,
                room: skippedRoom,
                status: "skipped",
                message: "Skipped after an earlier room action failed.",
              }));
            }
            return {
              ok: false,
              message: `Stopped after ${successRooms.length} of ${rooms.length} rooms. ${failedMessage}`,
              roomIdentifier: room.roomIdentifier,
              displayName: joinRoomNames(rooms),
              archived: input.archived,
              refreshTargets: ["rooms", "active_room", "foreground"],
              executedActions,
              actionResult: {
                actionResults,
                rooms: successRooms.map(toToolRoom),
                roomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                targetRoomIdentifiers: rooms.map((targetRoom) => targetRoom.roomIdentifier),
                archivedRoomIdentifiers: input.archived
                  ? successRooms.map((successRoom) => successRoom.roomIdentifier)
                  : [],
                archivedRooms: input.archived ? successRooms.map(toToolRoom) : [],
              },
            };
          }
        }
        return {
          message: `${input.archived ? "Archived" : "Restored"} ${joinRoomNames(rooms)}.`,
          roomIdentifier: rooms[0]?.roomIdentifier || null,
          displayName: joinRoomNames(rooms),
          archived: input.archived,
          executedActions,
          actionResult: {
            actionResults,
            rooms: rooms.map(toToolRoom),
            roomIdentifiers: rooms.map((room) => room.roomIdentifier),
            archivedRoomIdentifiers: input.archived
              ? rooms.map((room) => room.roomIdentifier)
              : [],
            archivedRooms: input.archived ? rooms.map(toToolRoom) : [],
          },
        };
      },
    })
    .register({
      id: "rooms.archive_unpinned",
      toolName: "archive_unpinned_rooms",
      description:
        "Archive all currently visible account rooms that are not pinned, optionally excluding specific rooms by identifier or name. Electron main computes the matching room set.",
      category: "rooms",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["rooms", "active_room", "foreground"],
      inputSchema: unpinnedRoomsArchivedInputSchema,
      inputSummary: () => "Archive unpinned rooms",
      resultLabel: () => "Archived unpinned rooms",
      confirmation: (input) => ({
        label: "Archive unpinned rooms",
        description: input.excludeRoomIdentifiers?.length
          ? `Archive all unpinned rooms except ${input.excludeRoomIdentifiers.join(" and ")}?`
          : "Archive all unpinned rooms?",
        confirmLabel: "Archive",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        if (!input.archived) {
          throw new Error("Unpinned-room batch action only supports archiving.");
        }
        const rooms = await findUnpinnedRooms(context.deps, input.excludeRoomIdentifiers);
        if (!rooms.length) {
          throw new Error("There are no unpinned rooms to archive.");
        }
        const actionResults: Record<string, unknown>[] = [];
        const executedActions: DesktopAppAgentActionExecutionSummary[] = [];
        const successRooms: DesktopAccountRoomEntry[] = [];
        for (let index = 0; index < rooms.length; index += 1) {
          const room = rooms[index];
          try {
            const actionResult = await context.deps.updateAccountRoom(room.roomIdentifier, {
              archived: true,
            });
            await verifyRoomArchived(context.deps, room.roomIdentifier, true);
            actionResults.push(actionResult as unknown as Record<string, unknown>);
            successRooms.push(room);
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `Archive ${room.displayName}`,
              room,
              status: "success",
              message: `Archived ${room.displayName}.`,
            }));
          } catch (error) {
            const failedMessage = safeActionErrorMessage(
              error,
              `Could not archive ${room.displayName}.`,
            );
            executedActions.push(roomExecutionSummary({
              actionId: "rooms.archive",
              label: `Archive ${room.displayName}`,
              room,
              status: "error",
              message: failedMessage,
            }));
            for (const skippedRoom of rooms.slice(index + 1)) {
              executedActions.push(roomExecutionSummary({
                actionId: "rooms.archive",
                label: `Archive ${skippedRoom.displayName}`,
                room: skippedRoom,
                status: "skipped",
                message: "Skipped after an earlier room action failed.",
              }));
            }
            return {
              ok: false,
              message: `Stopped after ${successRooms.length} of ${rooms.length} rooms. ${failedMessage}`,
              roomIdentifier: room.roomIdentifier,
              displayName: joinRoomNames(rooms),
              archived: true,
              refreshTargets: ["rooms", "active_room", "foreground"],
              executedActions,
              actionResult: {
                actionResults,
                rooms: successRooms.map(toToolRoom),
                roomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                targetRoomIdentifiers: rooms.map((targetRoom) => targetRoom.roomIdentifier),
                archivedRoomIdentifiers: successRooms.map((successRoom) => successRoom.roomIdentifier),
                archivedRooms: successRooms.map(toToolRoom),
              },
            };
          }
        }
        return {
          message: `Archived ${joinRoomNames(rooms)}.`,
          roomIdentifier: rooms[0]?.roomIdentifier || null,
          displayName: joinRoomNames(rooms),
          archived: true,
          executedActions,
          actionResult: {
            actionResults,
            rooms: rooms.map(toToolRoom),
            roomIdentifiers: rooms.map((room) => room.roomIdentifier),
            archivedRoomIdentifiers: rooms.map((room) => room.roomIdentifier),
            archivedRooms: rooms.map(toToolRoom),
          },
        };
      },
    })
    .register({
      id: "rooms.open",
      toolName: "open_room",
      description:
        "Open exactly one LetAgents room in the desktop app by roomIdentifier.",
      category: "rooms",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: ["active_room", "foreground"],
      inputSchema: openRoomInputSchema,
      inputSummary: () => "Open room",
      resultLabel: (_input, result) => `Opened ${result?.displayName || "room"}`,
      confirmation: (input) => ({
        label: "Open room",
        description: `Open ${input.roomIdentifier}.`,
        confirmLabel: "Open",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const room = await findRoom(context.deps, input.roomIdentifier);
        if (!room) {
          throw new Error(`I don't see a room called "${input.roomIdentifier}" in your account.`);
        }
        return {
          message: `Opened ${room.displayName}.`,
          roomIdentifier: room.roomIdentifier,
          displayName: room.displayName,
          openRoomIdentifier: room.roomIdentifier,
          actionResult: { roomIdentifier: room.roomIdentifier },
        };
      },
    })
    .register({
      id: "settings.get",
      toolName: "get_app_settings",
      description:
        "Read safe desktop settings that the App Agent may reason about. Never returns API keys or secrets.",
      category: "settings",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: [],
      inputSchema: settingsGetInputSchema,
      inputSummary: () => "Read settings",
      resultLabel: () => "Read settings",
      confirmation: () => ({
        label: "Read settings",
        description: "Read safe app settings.",
        confirmLabel: "Read",
        cancelLabel: "Cancel",
      }),
      execute: async (_input, context) => {
        const [chatStorage, appAgent] = await Promise.all([
          context.deps.getChatStorageSettings(),
          context.deps.getAppAgentSettingsStatus(),
        ]);
        return {
          message: "Read app settings.",
          actionResult: {
            chatStorage: {
              mode: chatStorage.mode,
              defaultMode: chatStorage.defaultMode,
              savedAt: chatStorage.savedAt,
            },
            appAgent: {
              configured: appAgent.configured,
              model: appAgent.model,
              savedAt: appAgent.savedAt,
              error: appAgent.error,
            },
          },
        };
      },
    })
    .register({
      id: "settings.set_chat_storage_mode",
      toolName: "set_chat_storage_mode",
      description:
        "Set the desktop chat storage mode to cloud or local. This changes where new chat messages are stored.",
      category: "settings",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["settings", "active_room", "foreground"],
      inputSchema: setChatStorageModeInputSchema,
      inputSummary: (input) => `Set chat storage to ${input.mode}`,
      resultLabel: (input) => `Set chat storage to ${input.mode}`,
      confirmation: (input) => ({
        label: `Set chat storage to ${input.mode}`,
        description:
          input.mode === "local"
            ? "Switch chat storage to local? New messages stay on this computer."
            : "Switch chat storage to cloud? New messages use cloud storage.",
        confirmLabel: "Change",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const settings = await context.deps.setChatStorageMode(input.mode);
        return {
          message:
            input.mode === "local"
              ? "Chat storage is now local."
              : "Chat storage is now cloud.",
          actionResult: {
            mode: settings.mode,
            defaultMode: settings.defaultMode,
            savedAt: settings.savedAt,
          },
        };
      },
    });
}
