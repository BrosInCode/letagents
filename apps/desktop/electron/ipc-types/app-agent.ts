import type { DesktopAccountRoomActionResult } from "./room.js";

export type DesktopAppAgentFeedbackState =
  | "configuration_required"
  | "success"
  | "choices"
  | "error"
  | "info";

export interface DesktopAppAgentSettingsStatus {
  configured: boolean;
  hasApiKey: boolean;
  model: string;
  savedAt: string | null;
  settingsPath: string;
  error: string | null;
}

export interface DesktopAppAgentSaveSettingsInput {
  openRouterApiKey?: string | null;
  model: string;
}

export interface DesktopAppAgentRunInput {
  prompt: string;
  activeRoomIdentifier?: string | null;
  selectedRoomIdentifier?: string | null;
  selectedPinned?: boolean | null;
}

export interface DesktopAppAgentRoomChoice {
  roomIdentifier: string;
  displayName: string;
  reason: string;
  pinned: boolean;
  desiredPinned: boolean;
  lastOpenedAt: string | null;
}

export interface DesktopAppAgentRunResult {
  state: DesktopAppAgentFeedbackState;
  message: string;
  roomIdentifier?: string | null;
  displayName?: string | null;
  pinned?: boolean | null;
  choices?: DesktopAppAgentRoomChoice[];
  settingsStatus?: DesktopAppAgentSettingsStatus;
  actionResult?: DesktopAccountRoomActionResult | null;
}
