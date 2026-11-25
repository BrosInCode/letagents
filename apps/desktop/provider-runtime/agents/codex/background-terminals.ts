/**
 * Codex's own control of the commands that an agent leaves running between turns. Codex calls them background
 * terminals: exec sessions that still run after the tool call that started them returned. The daemon names each
 * one by the item id of its command; Codex terminates one by its session's process id.
 * 1. `thread/backgroundTerminals/list` gives each running session's item id and process id.
 * 2. `thread/backgroundTerminals/terminate` ends one session. Codex then reports the command's item as ended.
 * Both are experimental app-server methods; the adapter's connection asks for the experimental API.
 */

type CodexRequest = { request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> };
type ListedTerminal = { itemId?: unknown; processId?: unknown };

const REQUEST_TIMEOUT_MS = 5_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

export async function stopCodexBackgroundTerminal(
  client: CodexRequest,
  threadId: string,
  itemId: string,
): Promise<"stopping" | "not_running" | "failed"> {
  try {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed: { data?: ListedTerminal[]; nextCursor?: unknown } = await client.request("thread/backgroundTerminals/list",
        { threadId, cursor, limit: PAGE_SIZE }, { timeoutMs: REQUEST_TIMEOUT_MS });
      const terminal = Array.isArray(listed?.data) ? listed.data.find((candidate) => candidate?.itemId === itemId) : undefined;
      if (terminal) {
        if (typeof terminal.processId !== "string" || !terminal.processId) return "failed";
        const result = await client.request<{ terminated?: unknown }>("thread/backgroundTerminals/terminate",
          { threadId, processId: terminal.processId }, { timeoutMs: REQUEST_TIMEOUT_MS });
        // Not terminated: the session ended on its own between the two requests.
        return result?.terminated === true ? "stopping" : "not_running";
      }
      cursor = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : null;
      if (!cursor) break;
    }
    return "not_running";
  } catch {
    return "failed";
  }
}
