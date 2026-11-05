/**
 * `client_name` of the remote MCP sessions that serve requests sent without a
 * session id. A client that never keeps a session (ChatGPT's connector) is
 * served in its credential's implicit session; a stateful client's session is
 * never reused for it. Kept apart from the session store so the route can
 * import it without loading the database client.
 */
export const IMPLICIT_CLIENT_NAME = "stateless";

/**
 * The product token of a request's User-Agent (`openai-mcp` from
 * `openai-mcp/1.0.0`): the only hint an implicit session has of which client
 * is calling, since such a client never sends `initialize`. Only the product
 * token is kept, at most 64 characters of letters, digits, `.`, `_` and `-`;
 * the rest of the header is never stored or passed on.
 */
export function clientHintFromUserAgent(userAgent: string | string[] | undefined): string | null {
  const header = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  const match = /^\s*([A-Za-z0-9._-]{1,64})(?:[/\s]|$)/.exec(header ?? "");
  return match?.[1] ?? null;
}
