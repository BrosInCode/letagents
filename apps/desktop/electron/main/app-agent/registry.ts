import { tool } from "@openai/agents";
import { z } from "zod";

import type {
  DesktopAppAgentActionChoice,
  DesktopAppAgentActionExecutionSummary,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionReference,
  DesktopAppAgentPendingAction,
  DesktopAppAgentRefreshTarget,
} from "../../ipc-types.js";

import type {
  AppAgentActionDefinition,
  AppAgentActionExecutionResult,
  AppAgentActionRegistryDeps,
  AppAgentActionTrace,
} from "./types.js";
import {
  asActionInput,
  makeChoiceId,
  resolvedPendingAction,
  toDisplayActionReference,
  toPendingAction,
} from "./copy.js";
import {
  actionNeedsConfirmation,
  maxRisk,
  planNeedsConfirmation,
} from "./risk-policy.js";
import {
  findUnpinnedRooms,
} from "./rooms-matching.js";
import { redactTraceText } from "./trace.js";
import {
  registerRoomActions,
  unpinnedRoomsArchivedInputSchema,
} from "./actions/rooms.js";
import { registerSettingsActions } from "./actions/settings.js";

export type {
  AppAgentActionDefinition,
  AppAgentActionExecutionResult,
  AppAgentActionRegistryDeps,
  AppAgentActionTrace,
} from "./types.js";

export { createAppAgentActionTrace } from "./trace.js";
export { roomMatchesIdentifier } from "./rooms-matching.js";

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
  const registry = new AppActionRegistry(deps);
  registerRoomActions(registry);
  registerSettingsActions(registry);
  return registry;
}
