import type { DesktopSupervisorAgentConfiguration } from "../../../electron/ipc-types";

/** What other members see, and what they never see. */
export const LIVE_SHARING_DESCRIPTION =
  "Other members of this room see a Live tab for this agent: its work notes, its updates, the request it is answering and the names of its actions, such as “Ran a shell command”. They never see commands, file contents, tool results or error details.";
export const LIVE_SHARING_ON_NOTE =
  "On. Turning it off stops sharing within a few seconds and removes what the room can already see.";
export const LIVE_SHARING_OFF_NOTE =
  "Off. Only you see this agent’s Live tab. Turning it on shares the current request and the ones after it.";

/** Why the owner cannot turn sharing on for this agent, or null when they can. */
export function liveSharingUnavailableReason(
  state: NonNullable<DesktopSupervisorAgentConfiguration["liveSharing"]>,
): string | null {
  if (state.availability === "rental") return "A rented agent works for someone else, so its live activity is not shared from here.";
  if (state.availability === "polling") {
    return "Not available for this agent: it fetches its own room messages, so LetAgents cannot tell where its requests begin and end.";
  }
  return null;
}
