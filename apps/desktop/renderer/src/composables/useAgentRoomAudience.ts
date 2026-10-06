import { computed, provide } from "vue";
import type { DesktopParticipantSummary, DesktopRoomInfo } from "../../../electron/ipc-types";
import { agentRoomAudience, agentRoomAudienceKey } from "../domain/agent-home-harness";

/**
 * Tells every agent's settings, wherever they are shown, who else can reach
 * an agent in the room being looked at. It is provided once, by the app, from
 * the room, the people and agents active in it, and the signed-in account.
 */
export function provideAgentRoomAudience(
  room: () => Pick<DesktopRoomInfo, "gitRoom"> | null | undefined,
  participants: () => readonly Pick<DesktopParticipantSummary, "kind" | "participantKey" | "githubLogin" | "ownerLabel" | "actorLabel" | "hiddenAt">[],
  viewer: () => readonly (string | null | undefined)[],
): void {
  provide(agentRoomAudienceKey, computed(() => agentRoomAudience(room(), participants(), viewer())));
}
