export const FOCUS_PARENT_VISIBILITIES = [
  "summary_only",
  "major_activity",
  "all_activity",
  "silent",
] as const;

export const FOCUS_ACTIVITY_SCOPES = [
  "task_and_branch",
  "task_only",
  "room",
] as const;

export const FOCUS_GITHUB_EVENT_ROUTINGS = [
  "task_and_branch",
  "task_only",
  "all_parent_repo",
  "off",
] as const;

export type FocusParentVisibility = typeof FOCUS_PARENT_VISIBILITIES[number];
export type FocusActivityScope = typeof FOCUS_ACTIVITY_SCOPES[number];
export type FocusGitHubEventRouting = typeof FOCUS_GITHUB_EVENT_ROUTINGS[number];

export interface FocusRoomSettings {
  parent_visibility: FocusParentVisibility;
  activity_scope: FocusActivityScope;
  github_event_routing: FocusGitHubEventRouting;
}

export type FocusRoomSettingsPatch = Partial<FocusRoomSettings>;

export const DEFAULT_FOCUS_ROOM_SETTINGS: FocusRoomSettings = {
  parent_visibility: "summary_only",
  activity_scope: "task_and_branch",
  github_event_routing: "task_and_branch",
};

export type FocusParentEventKind = "result_summary" | "major_activity" | "all_activity";

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export function normalizeFocusRoomSettings(input: {
  parent_visibility?: string | null;
  activity_scope?: string | null;
  github_event_routing?: string | null;
} | null | undefined): FocusRoomSettings {
  return {
    parent_visibility: isOneOf(FOCUS_PARENT_VISIBILITIES, input?.parent_visibility)
      ? input.parent_visibility
      : DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
    activity_scope: isOneOf(FOCUS_ACTIVITY_SCOPES, input?.activity_scope)
      ? input.activity_scope
      : DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
    github_event_routing: isOneOf(FOCUS_GITHUB_EVENT_ROUTINGS, input?.github_event_routing)
      ? input.github_event_routing
      : DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
  };
}

export function validateFocusRoomSettingsPatch(input: unknown): FocusRoomSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("settings body must be an object");
  }

  const record = input as Record<string, unknown>;
  const patch: FocusRoomSettingsPatch = {};

  if (Object.prototype.hasOwnProperty.call(record, "parent_visibility")) {
    if (!isOneOf(FOCUS_PARENT_VISIBILITIES, record.parent_visibility)) {
      throw new Error("parent_visibility is invalid");
    }
    patch.parent_visibility = record.parent_visibility;
  }

  if (Object.prototype.hasOwnProperty.call(record, "activity_scope")) {
    if (!isOneOf(FOCUS_ACTIVITY_SCOPES, record.activity_scope)) {
      throw new Error("activity_scope is invalid");
    }
    patch.activity_scope = record.activity_scope;
  }

  if (Object.prototype.hasOwnProperty.call(record, "github_event_routing")) {
    if (!isOneOf(FOCUS_GITHUB_EVENT_ROUTINGS, record.github_event_routing)) {
      throw new Error("github_event_routing is invalid");
    }
    patch.github_event_routing = record.github_event_routing;
  }

  for (const key of Object.keys(record)) {
    if (!["parent_visibility", "activity_scope", "github_event_routing"].includes(key)) {
      throw new Error(`unsupported focus room setting "${key}"`);
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("at least one focus room setting is required");
  }

  return patch;
}

export function shouldPostFocusRoomEventToParent(
  settingsInput: FocusRoomSettings | null | undefined,
  eventKind: FocusParentEventKind
): boolean {
  const settings = normalizeFocusRoomSettings(settingsInput);

  switch (settings.parent_visibility) {
    case "silent":
      return false;
    case "all_activity":
      return true;
    case "major_activity":
      return eventKind === "result_summary" || eventKind === "major_activity";
    case "summary_only":
    default:
      return eventKind === "result_summary";
  }
}
