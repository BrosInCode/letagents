export const EXECUTION_PROFILES = [
  "supervised_room_turn",
  "autonomous_mcp_worker",
  "interactive_desktop",
] as const;

export type LetAgentsExecutionProfile = typeof EXECUTION_PROFILES[number];
export const LETAGENTS_EXECUTION_PROFILE_ENV = "LETAGENTS_EXECUTION_PROFILE";

export function executionProfile(env: NodeJS.ProcessEnv = process.env): LetAgentsExecutionProfile {
  const configured = env[LETAGENTS_EXECUTION_PROFILE_ENV]?.trim();
  if (!configured) return "autonomous_mcp_worker";
  if ((EXECUTION_PROFILES as readonly string[]).includes(configured)) return configured as LetAgentsExecutionProfile;
  throw new Error(`Invalid ${LETAGENTS_EXECUTION_PROFILE_ENV}: ${configured}`);
}
