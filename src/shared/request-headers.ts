export const LETAGENTS_ORIGIN_ROOM_ID_HEADER = "X-LetAgents-Origin-Room-Id";
export const LETAGENTS_AGENT_SESSION_ID_HEADER = "X-LetAgents-Agent-Session-Id";
export const LETAGENTS_AGENT_SESSION_TOKEN_HEADER = "X-LetAgents-Agent-Session-Token";

/**
 * How the room answers a request made with the credentials of a session that
 * has ended. It is said in words because the agent reads it: a client that
 * predates this answer passes it on unchanged, and the agent is told what to
 * do. A client that knows the answer starts a new session by itself.
 */
export const AGENT_SESSION_ENDED_ERROR = "This agent session has ended.";
export const AGENT_SESSION_ENDED_ADVICE = `${AGENT_SESSION_ENDED_ERROR} `
  + "Call register_agent_session again to go on working in this room. "
  + "If the same error returns, register with a new registration_key, "
  + "or have the LetAgents MCP server restarted and register once more.";
