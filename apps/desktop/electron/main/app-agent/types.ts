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

export interface AppAgentActionExecutionContext {
  deps: AppAgentActionRegistryDeps;
  trace: AppAgentActionTrace;
}
