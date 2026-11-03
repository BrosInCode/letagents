/**
 * `client_name` of the remote MCP sessions that serve requests sent without a
 * session id. A client that never keeps a session (ChatGPT's connector) is
 * served in its credential's implicit session; a stateful client's session is
 * never reused for it. Kept apart from the session store so the route can
 * import it without loading the database client.
 */
export const IMPLICIT_CLIENT_NAME = "stateless";
