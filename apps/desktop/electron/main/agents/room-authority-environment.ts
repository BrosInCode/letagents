/**
 * The variables that let a process act as a room agent through the daemon:
 * the agent's supervisor coordinates, the markers that select how its room
 * server behaves, and any LetAgents bearer. Given the coordinates, a process
 * on this machine can ask the daemon for the agent's session credential, so
 * they belong to the room's own MCP server and to nothing an owner's setup
 * starts beside it.
 */
const ROOM_AUTHORITY_VARIABLES = new Set([
  "LETAGENTS_SUPERVISED_BOUNDED_TURNS",
  "LETAGENTS_EXECUTION_PROFILE",
  "LETAGENTS_PERMISSION_PROFILE_ID",
  "LETAGENTS_TOKEN",
  "LETAGENTS_AGENT_SESSION_BEARER",
]);

export function isRoomAuthorityVariable(name: string): boolean {
  return name.startsWith("LETAGENTS_SUPERVISOR_") || ROOM_AUTHORITY_VARIABLES.has(name);
}

/** The same environment with none of those variables. */
export function withoutRoomAuthority<T extends Record<string, string | undefined>>(env: T): T {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isRoomAuthorityVariable(name))) as T;
}
