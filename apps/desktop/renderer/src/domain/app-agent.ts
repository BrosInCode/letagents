import type {
  DesktopAppAgentRoomChoice,
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSettingsStatus,
} from "../../../electron/ipc-types";

export function appAgentStatusLabel(
  settingsStatus: DesktopAppAgentSettingsStatus | null,
  busy: boolean,
): string {
  if (busy) return "Running";
  if (!settingsStatus) return "Checking";
  return settingsStatus.configured ? settingsStatus.model : "Setup needed";
}

export function buildAppAgentRunInput(input: {
  prompt: string;
  activeRoomIdentifier?: string | null;
  selectedRoomIdentifier?: string | null;
  selectedPinned?: boolean | null;
}): DesktopAppAgentRunInput | null {
  const prompt = input.prompt.trim();
  if (!prompt) return null;
  return {
    prompt,
    activeRoomIdentifier: input.activeRoomIdentifier || null,
    selectedRoomIdentifier: input.selectedRoomIdentifier || null,
    selectedPinned:
      typeof input.selectedPinned === "boolean" ? input.selectedPinned : null,
  };
}

export function visibleAppAgentChoices(
  result: DesktopAppAgentRunResult | null,
): DesktopAppAgentRoomChoice[] {
  return result?.state === "choices" ? result.choices || [] : [];
}

export function shouldRefreshRoomsAfterAppAgentResult(
  result: DesktopAppAgentRunResult | null,
): boolean {
  return Boolean(
    result?.state === "success" &&
      (result.roomIdentifier || result.actionResult?.roomIdentifier),
  );
}
