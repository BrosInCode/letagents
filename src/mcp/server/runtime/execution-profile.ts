export const EXECUTION_PROFILES = [
  "supervised_room_turn",
  "supervised_mcp_polling",
  "autonomous_mcp_worker",
  "interactive_desktop",
] as const;

export type LetAgentsExecutionProfile = typeof EXECUTION_PROFILES[number];
export const LETAGENTS_EXECUTION_PROFILE_ENV = "LETAGENTS_EXECUTION_PROFILE";
export const LETAGENTS_SUPERVISED_BOUNDED_TURNS_ENV = "LETAGENTS_SUPERVISED_BOUNDED_TURNS";

export function executionProfile(env: NodeJS.ProcessEnv = process.env): LetAgentsExecutionProfile {
  const configured = env[LETAGENTS_EXECUTION_PROFILE_ENV]?.trim();
  const bounded = env[LETAGENTS_SUPERVISED_BOUNDED_TURNS_ENV]?.trim() === "1";
  if (configured && !(EXECUTION_PROFILES as readonly string[]).includes(configured)) {
    throw new Error(`Invalid ${LETAGENTS_EXECUTION_PROFILE_ENV}: ${configured}`);
  }
  const profile = (configured || "autonomous_mcp_worker") as LetAgentsExecutionProfile;
  if (bounded !== (profile === "supervised_room_turn")) {
    throw new Error(`${LETAGENTS_EXECUTION_PROFILE_ENV}=supervised_room_turn and ${LETAGENTS_SUPERVISED_BOUNDED_TURNS_ENV}=1 must be configured together.`);
  }
  return profile;
}
