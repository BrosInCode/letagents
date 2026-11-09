import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { stopCodexBackgroundTerminal } from "../main/agents/codex/background-terminals.js";

/** A Codex connection that answers the two background-terminal requests from a fixed list of sessions. */
function codex(pages: Array<{ data: Array<{ itemId: string; processId: string }>; nextCursor: string | null }>, terminated = true) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    async request<T>(method: string, params?: unknown): Promise<T> {
      const record = params as Record<string, unknown>;
      calls.push({ method, params: record });
      if (method === "thread/backgroundTerminals/list") {
        const index = record.cursor === null ? 0 : Number(String(record.cursor).replace("page-", ""));
        return pages[index] as T;
      }
      if (method === "thread/backgroundTerminals/terminate") return { terminated } as T;
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("Stop finds the command's exec session by its item id and terminates it by its process id", async () => {
  const client = codex([
    { data: [{ itemId: "exec-a", processId: "111" }], nextCursor: "page-1" },
    { data: [{ itemId: "exec-b", processId: "60781" }], nextCursor: null },
  ]);
  assert.equal(await stopCodexBackgroundTerminal(client, "thread-1", "exec-b"), "stopping");
  assert.deepEqual(client.calls.map(({ method, params }) => [method, params]), [
    ["thread/backgroundTerminals/list", { threadId: "thread-1", cursor: null, limit: 50 }],
    ["thread/backgroundTerminals/list", { threadId: "thread-1", cursor: "page-1", limit: 50 }],
    ["thread/backgroundTerminals/terminate", { threadId: "thread-1", processId: "60781" }],
  ]);
});

test("Stop answers not running for a command with no session, or one that ended first, and failed on an error", async () => {
  const none = codex([{ data: [{ itemId: "exec-a", processId: "111" }], nextCursor: null }]);
  assert.equal(await stopCodexBackgroundTerminal(none, "thread-1", "exec-z"), "not_running");
  assert.deepEqual(none.calls.map(({ method }) => method), ["thread/backgroundTerminals/list"], "nothing is terminated");

  const endedFirst = codex([{ data: [{ itemId: "exec-a", processId: "111" }], nextCursor: null }], false);
  assert.equal(await stopCodexBackgroundTerminal(endedFirst, "thread-1", "exec-a"), "not_running");

  const broken = { async request(): Promise<never> { throw new Error("connection closed"); } };
  assert.equal(await stopCodexBackgroundTerminal(broken, "thread-1", "exec-a"), "failed");
});
