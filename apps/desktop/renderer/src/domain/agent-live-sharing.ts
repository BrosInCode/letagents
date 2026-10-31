import type { DesktopSupervisorAgentConfiguration } from "../../../electron/ipc-types";
import type { AgentRoomAudience } from "./agent-home-harness";

/** What everyone who can read the room sees, and what they never see. */
export const LIVE_SHARING_DESCRIPTION =
  "Anyone who can read this room sees a Live tab for this agent: its work notes and updates, the request it is answering, and the names of its actions, such as “Ran a shell command”. Notes and updates can quote code or text the agent read. Commands, tool results and error details are not shared, and passwords and machine paths are removed from the text.";

/** Who that is, for this room: a public repository room can be read by anyone, signed in or not. */
export function liveSharingAudienceNote(audience: AgentRoomAudience): string {
  if (audience === "public") return "This room is public: anyone can read it, even without signing in, so anyone can see this agent’s live activity.";
  if (audience === "shared") return "Other people are in this room. Everyone who can read it sees this agent’s live activity.";
  return "No one else is in this room now, but anyone who joins it later sees this agent’s live activity.";
}
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
