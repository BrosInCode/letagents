import type {
  DesktopAppAgentActionChoice,
  DesktopAppAgentActionExecutionSummary,
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionReference,
  DesktopAppAgentRefreshTarget,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSettingsStatus,
  DesktopAppAgentTraceEntry,
  DesktopGitRoomInfo,
} from "../../../electron/ipc-types";

export type AppAgentSurfaceState =
  | "idle"
  | "running"
  | "success"
  | "choices"
  | "confirmation"
  | "configuration"
  | "error";

export type AppAgentTimelineState = "pending" | "active" | "done" | "error";

export interface AppAgentTimelineItem {
  id: string;
  label: string;
  detail: string | null;
  state: AppAgentTimelineState;
}

export interface AppAgentCurrentPhase {
  label: string;
  detail: string | null;
  state: AppAgentTimelineState;
}

export interface AppAgentTraceDisplayEntry {
  id: string;
  label: string;
  detail: string | null;
  status: DesktopAppAgentTraceEntry["status"];
}

export function appAgentStatusLabel(
  settingsStatus: DesktopAppAgentSettingsStatus | null,
  busy: boolean,
): string {
  if (busy) return "Running";
  if (!settingsStatus) return "Checking";
  return settingsStatus.configured ? "Ready to help with this room" : "Setup needed";
}

function plainRecord(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function plainActionReference(
  action: DesktopAppAgentActionReference | null | undefined,
): DesktopAppAgentActionReference | null {
  if (!action) return null;
  return {
    actionId: action.actionId,
    input: plainRecord(action.input || {}),
    label: action.label,
    description: action.description ?? null,
    risk: action.risk,
    refreshTargets: action.refreshTargets ? [...action.refreshTargets] : undefined,
  };
}

function plainActionPlan(
  plan: DesktopAppAgentActionPlan | null | undefined,
): DesktopAppAgentActionPlan | null {
  if (!plan) return null;
  return {
    planId: plan.planId,
    title: plan.title,
    description: plan.description,
    actions: plan.actions
      .map((action) => plainActionReference(action))
      .filter((action): action is DesktopAppAgentActionReference => Boolean(action)),
    risk: plan.risk,
    confirmLabel: plan.confirmLabel,
    cancelLabel: plan.cancelLabel,
    refreshTargets: plan.refreshTargets ? [...plan.refreshTargets] : [],
  };
}

export function buildAppAgentRunInput(input: {
  prompt: string;
  activeRoomIdentifier?: string | null;
  activeRoomDisplayName?: string | null;
  activeRoomPinned?: boolean | null;
  activeRoomGitRoom?: DesktopGitRoomInfo | null;
  selectedAction?: DesktopAppAgentActionReference | null;
  confirmedAction?: DesktopAppAgentActionReference | null;
  confirmedPlan?: DesktopAppAgentActionPlan | null;
}): DesktopAppAgentRunInput | null {
  const prompt = input.prompt.trim();
  if (!prompt) return null;
  return {
    prompt,
    activeRoomIdentifier: input.activeRoomIdentifier || null,
    activeRoomDisplayName: input.activeRoomDisplayName || null,
    activeRoomPinned: input.activeRoomPinned === true,
    activeRoomGitRoom: input.activeRoomGitRoom || null,
    selectedAction: plainActionReference(input.selectedAction),
    confirmedAction: plainActionReference(input.confirmedAction),
    confirmedPlan: plainActionPlan(input.confirmedPlan),
  };
}

export function visibleAppAgentChoices(
  result: DesktopAppAgentRunResult | null,
): DesktopAppAgentActionChoice[] {
  return result?.state === "choices" ? result.choices || [] : [];
}

export function visibleAppAgentPlan(
  result: DesktopAppAgentRunResult | null,
): DesktopAppAgentActionPlan | null {
  return result?.state === "confirmation_required"
    ? result.pendingPlan || null
    : null;
}

export function visibleAppAgentExecutionJournal(
  result: DesktopAppAgentRunResult | null,
): DesktopAppAgentActionExecutionSummary[] {
  return result?.executedActions || [];
}

export function appAgentTraceDisplayEntry(
  entry: DesktopAppAgentTraceEntry,
): AppAgentTraceDisplayEntry {
  return {
    id: entry.id,
    label: appAgentTraceDisplayLabel(entry),
    detail: appAgentTraceDisplayDetail(entry),
    status: entry.status,
  };
}

export function appAgentRefreshTargets(
  result: DesktopAppAgentRunResult | null,
): DesktopAppAgentRefreshTarget[] {
  if (!result) return [];
  const hasSuccessfulSideEffect = result.executedActions?.some(
    (action) => action.status === "success",
  ) || false;
  if (result.state !== "success" && !hasSuccessfulSideEffect) return [];
  if (result.refreshTargets?.length) return result.refreshTargets;
  return result.roomIdentifier || result.openRoomIdentifier || result.actionResult?.roomIdentifier
    ? ["rooms", "active_room", "foreground"]
    : [];
}

export function shouldRefreshRoomsAfterAppAgentResult(
  result: DesktopAppAgentRunResult | null,
): boolean {
  return appAgentRefreshTargets(result).includes("rooms");
}

export function appAgentSurfaceState(input: {
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
  settingsStatus?: DesktopAppAgentSettingsStatus | null;
}): AppAgentSurfaceState {
  if (input.busy) return "running";
  if (input.settingsStatus && !input.settingsStatus.configured) return "configuration";
  if (!input.result) return "idle";
  if (input.result.state === "configuration_required") return "configuration";
  if (input.result.state === "confirmation_required") return "confirmation";
  if (input.result.state === "choices") return "choices";
  if (input.result.state === "success") return "success";
  if (input.result.state === "error") return "error";
  return "idle";
}

export function appAgentSurfaceKicker(state: AppAgentSurfaceState): string {
  if (state === "running") return "Working";
  if (state === "confirmation") return "Confirm";
  if (state === "choices") return "Choose";
  if (state === "success") return "Complete";
  if (state === "error") return "Needs attention";
  if (state === "configuration") return "Setup";
  return "Ready";
}

export function appAgentTimeline(input: {
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
}): AppAgentTimelineItem[] {
  if (input.busy && !input.result?.trace?.length) {
    return [
      timelineItem("understand", "Understanding request", null, "active"),
      timelineItem("check", "Checking app context", null, "pending"),
      timelineItem("act", "Preparing action", null, "pending"),
    ];
  }

  const trace = input.result?.trace || [];
  if (!input.busy && !trace.length && !input.result) return [];

  const steps = new Map<string, AppAgentTimelineItem>();
  for (const entry of trace) {
    const step = timelineItemFromTrace(entry);
    const existing = steps.get(step.id);
    if (!existing || timelineRank(step.state) >= timelineRank(existing.state)) {
      steps.set(step.id, step);
    }
  }

  if (input.result?.state === "choices") {
    steps.set("choose", timelineItem("choose", "Needs a room choice", input.result.message, "active"));
  }
  if (input.result?.state === "confirmation_required") {
    steps.set("confirm", timelineItem("confirm", "Needs confirmation", input.result.message, "active"));
  }
  if (input.result?.state === "success") {
    if (appAgentRefreshTargets(input.result).length) {
      steps.set("refresh", timelineItem("refresh", "Refreshing app", null, "done"));
    }
    steps.set("done", timelineItem("done", "Done", input.result.message, "done"));
  }
  if (
    input.result?.state === "error" ||
    input.result?.state === "configuration_required"
  ) {
    steps.set("error", timelineItem("error", "Stopped", input.result.message, "error"));
  }

  const ordered = [
    "understand",
    "check",
    "match",
    "choose",
    "confirm",
    "act",
    "refresh",
    "done",
    "error",
  ];
  const output = ordered
    .map((id) => steps.get(id))
    .filter((item): item is AppAgentTimelineItem => Boolean(item));

  if (input.busy && output.length) {
    return markLastNonTerminalActive(output);
  }
  if (input.result?.state === "success") {
    return output.map((item) =>
      item.state === "active" ? { ...item, state: "done" as const } : item,
    );
  }
  return output;
}

export function appAgentCurrentPhase(input: {
  busy: boolean;
  result: DesktopAppAgentRunResult | null;
}): AppAgentCurrentPhase | null {
  const timeline = appAgentTimeline(input);
  if (!timeline.length && !input.result?.message) return null;

  if (input.busy) {
    const active = timeline.find((item) => item.state === "active");
    if (active) return phaseFromTimelineItem(active);
    const last = timeline[timeline.length - 1];
    return last ? phaseFromTimelineItem(last) : null;
  }

  if (input.result?.state === "confirmation_required") {
    return {
      label: "Waiting for confirmation",
      detail: input.result.message,
      state: "active",
    };
  }
  if (input.result?.state === "choices") {
    return {
      label: "Choose a target",
      detail: input.result.message,
      state: "active",
    };
  }
  if (input.result?.state === "success") {
    return {
      label: "Done",
      detail: input.result.message,
      state: "done",
    };
  }
  if (
    input.result?.state === "error" ||
    input.result?.state === "configuration_required"
  ) {
    return {
      label: "Stopped",
      detail: input.result.message,
      state: "error",
    };
  }

  const last = timeline[timeline.length - 1];
  return last ? phaseFromTimelineItem(last) : null;
}

export function appAgentArchivedRoomIdentifiers(
  result: DesktopAppAgentRunResult | null,
): string[] {
  if (!result || result.archived !== true) return [];
  const identifiers = new Set<string>();
  addIdentifier(identifiers, result.roomIdentifier);
  addIdentifier(identifiers, result.displayName);

  const actionResult = result.actionResult;
  if (isRecord(actionResult)) {
    addIdentifier(identifiers, actionResult.roomIdentifier);
    addIdentifier(identifiers, actionResult.displayName);
    const archivedRoomIdentifiers = actionResult.archivedRoomIdentifiers;
    if (Array.isArray(archivedRoomIdentifiers)) {
      for (const roomIdentifier of archivedRoomIdentifiers) {
        addIdentifier(identifiers, roomIdentifier);
      }
    }
    const archivedRoomDisplayNames = actionResult.archivedRoomDisplayNames;
    if (Array.isArray(archivedRoomDisplayNames)) {
      for (const displayName of archivedRoomDisplayNames) {
        addIdentifier(identifiers, displayName);
      }
    }
    const roomIdentifiers = actionResult.roomIdentifiers;
    if (Array.isArray(roomIdentifiers)) {
      for (const roomIdentifier of roomIdentifiers) {
        addIdentifier(identifiers, roomIdentifier);
      }
    }
    const rooms = actionResult.rooms;
    if (Array.isArray(rooms)) {
      for (const room of rooms) {
        if (isRecord(room)) {
          addIdentifier(identifiers, room.roomIdentifier);
          addIdentifier(identifiers, room.displayName);
        }
      }
    }
    const archivedRooms = actionResult.archivedRooms;
    if (Array.isArray(archivedRooms)) {
      for (const room of archivedRooms) {
        if (isRecord(room)) {
          addIdentifier(identifiers, room.roomIdentifier);
          addIdentifier(identifiers, room.displayName);
        }
      }
    }
  }

  return [...identifiers];
}

function addIdentifier(identifiers: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = value.trim().toLowerCase();
  if (normalized) identifiers.add(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function timelineItem(
  id: string,
  label: string,
  detail: string | null,
  state: AppAgentTimelineState,
): AppAgentTimelineItem {
  return { id, label, detail, state };
}

function phaseFromTimelineItem(item: AppAgentTimelineItem): AppAgentCurrentPhase {
  return {
    label: item.label,
    detail: item.detail,
    state: item.state,
  };
}

function timelineItemFromTrace(entry: DesktopAppAgentTraceEntry): AppAgentTimelineItem {
  const label = entry.label.toLowerCase();
  if (label.includes("asked model") || label.includes("retried model")) {
    return timelineItem("understand", "Understanding request", entry.detail || null, traceState(entry));
  }
  if (label.includes("model returned decision")) {
    return timelineItem("match", "Planned action", null, traceState(entry));
  }
  if (entry.actionId === "rooms.list" || label.includes("list")) {
    return timelineItem("check", "Checking available rooms", entry.detail || null, traceState(entry));
  }
  if (label.includes("match") || label.includes("matched")) {
    return timelineItem("match", "Matched target", entry.detail || null, traceState(entry));
  }
  if (label.includes("confirmation")) {
    return timelineItem("confirm", "Needs confirmation", entry.detail || null, traceState(entry));
  }
  if (entry.actionId || label.startsWith("call ") || label.startsWith("execute ")) {
    return timelineItem("act", actionTimelineLabel(entry), entry.detail || null, traceState(entry));
  }
  return timelineItem("understand", entry.label, entry.detail || null, traceState(entry));
}

function actionTimelineLabel(entry: DesktopAppAgentTraceEntry): string {
  if (entry.actionId?.includes("archive")) return "Hiding room";
  if (entry.actionId?.includes("pin")) return "Updating pin";
  if (entry.actionId?.includes("open")) return "Opening room";
  if (entry.actionId?.includes("settings")) return "Updating setting";
  return "Running action";
}

function appAgentTraceDisplayLabel(entry: DesktopAppAgentTraceEntry): string {
  const label = entry.label.toLowerCase();
  if (label.includes("asked model")) return "Understanding request";
  if (label.includes("retried model")) return "Retried with tool guidance";
  if (label.includes("model setup")) return "Prepared model";
  if (label.includes("model run started")) return "Asked model";
  if (label.includes("model returned decision")) return "Planned action";
  if (label.includes("model stopped before tool use")) return "Tool path incomplete";
  if (label.includes("model timeout")) return "Model timed out";
  if (label.includes("model run failed")) return "Model run failed";
  if (label.includes("app agent failed")) return "App Agent stopped";
  if (label.includes("confirmation")) return "Requested confirmation";
  if (entry.actionId === "rooms.list" || label.includes("list_account_rooms")) {
    return "Checked rooms";
  }
  if (entry.actionId === "settings.get" || label.includes("get_app_settings")) {
    return "Checked settings";
  }
  if (entry.actionId === "app.plan" || label.includes("prepare_app_action_plan")) {
    if (label.includes("execute")) return "Ran action plan";
    return "Prepared action plan";
  }
  if (entry.actionId?.includes("archive") || label.includes("archive_unpinned")) {
    return entry.status === "error" ? "Hide action failed" : "Ran hide action";
  }
  if (entry.actionId?.includes("pin")) {
    return entry.status === "error" ? "Pin action failed" : "Ran pin action";
  }
  if (entry.actionId?.includes("open")) {
    return entry.status === "error" ? "Open action failed" : "Ran open action";
  }
  if (entry.actionId?.includes("storage")) {
    return entry.status === "error" ? "Storage action failed" : "Updated chat storage";
  }
  if (entry.actionId?.includes("settings")) {
    return entry.status === "error" ? "Settings action failed" : "Ran settings action";
  }
  if (label.startsWith("call ") || label.startsWith("execute ")) return "Ran app action";
  if (label.startsWith("failed ")) return "Action failed";
  return entry.label;
}

function appAgentTraceDisplayDetail(entry: DesktopAppAgentTraceEntry): string | null {
  if (!entry.detail) return null;
  if (entry.label.toLowerCase().includes("model returned decision")) return null;
  return entry.detail
    .replace(/set_room_(pinned|archived)/g, "room action")
    .replace(/set_rooms_(pinned|archived)/g, "room batch action")
    .replace(/list_account_rooms/g, "room lookup")
    .replace(/archive_unpinned_rooms/g, "unpinned-room cleanup");
}

function traceState(entry: DesktopAppAgentTraceEntry): AppAgentTimelineState {
  if (entry.status === "error") return "error";
  if (entry.status === "success") return "done";
  return "active";
}

function timelineRank(state: AppAgentTimelineState): number {
  if (state === "error") return 3;
  if (state === "done") return 2;
  if (state === "active") return 1;
  return 0;
}

function markLastNonTerminalActive(items: AppAgentTimelineItem[]): AppAgentTimelineItem[] {
  const nextItems = items.map((item) =>
    item.state === "active" ? { ...item, state: "done" as const } : item,
  );
  for (let index = nextItems.length - 1; index >= 0; index -= 1) {
    const item = nextItems[index];
    if (!item || item.state === "error" || item.id === "done") continue;
    nextItems[index] = { ...item, state: "active" };
    break;
  }
  return nextItems;
}
