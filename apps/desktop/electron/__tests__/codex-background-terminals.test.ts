import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { stopCodexBackgroundTerminal } from "../main/agents/codex/background-terminals.js";
import { boundedCommandEnd } from "../main/agents/codex/adapter-events.js";
import { MAX_STREAM_PAYLOAD_BYTES, safeStreamPayload } from "../main/agents/provider-evidence.js";

test("a command's end with a large whole output keeps its ids: only the newest output is kept, and it says so", () => {
  const lines = Array.from({ length: 2_000 }, (_, index) => `[dev-server] request ${index} served`).join("\n");
  const end = { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "exec-1", status: "failed", exitCode: 1,
    command: "/bin/zsh -lc 'npm run dev'", aggregatedOutput: lines } };
  assert.ok(Buffer.byteLength(JSON.stringify(end)) > MAX_STREAM_PAYLOAD_BYTES, "the whole end is over the stream's limit");
  assert.ok("preview" in (safeStreamPayload(end).payload as object), "unbounded, it would reach the daemon without its ids");

  const bounded = boundedCommandEnd("item/completed", end);
  assert.equal(bounded.truncated, true);
  const safe = safeStreamPayload(bounded.params);
  const item = (safe.payload as { item: Record<string, unknown> }).item;
  assert.deepEqual([(safe.payload as Record<string, unknown>).threadId, item.id, item.status, item.exitCode], ["thread-1", "exec-1", "failed", 1]);
  assert.ok((item.aggregatedOutput as string).endsWith("[dev-server] request 1999 served"), "the newest output stays");
  assert.ok((item.aggregatedOutput as string).startsWith("[dev-server] request "), "from a line start");

  // A private key that crosses the cut loses its BEGIN line: its body never shows (live, the review's probe showed 44 lines).
  const body = Array.from({ length: 50 }, (_, index) => `MIIEowIBAAKCAQEAx${String(index).padStart(2, "0")}Zk9mQb1vT8cR3nLp0sWqYdHjKfGtUeXiOzNaBmCvDlEyFrPuAgSo`).join("\n");
  const keyOutput = [...Array.from({ length: 300 }, (_, index) => `log ${index}`), "-----BEGIN RSA PRIVATE KEY-----", body,
    "-----END RSA PRIVATE KEY-----", ...Array.from({ length: 280 }, (_, index) => `after ${index}`)].join("\n");
  const keyEnd = boundedCommandEnd("item/completed", { ...end, item: { ...end.item, aggregatedOutput: keyOutput } });
  const shownKey = (keyEnd.params as { item: { aggregatedOutput: string } }).item.aggregatedOutput;
  assert.equal(keyEnd.truncated, true);
  assert.doesNotMatch(shownKey, /MIIEowIBAAKCAQEA/, "no line of the key body");
  assert.match(shownKey, /after 279$/);

  // A very long command (a heredoc) keeps the end under the limit: no output, the start of the command, its ids.
  const longCommand = { ...end, item: { ...end.item, command: `cat <<'EOF'\n${"x".repeat(40_000)}\nEOF`, commandActions: [{ command: "x".repeat(40_000) }] } };
  const longEnd = boundedCommandEnd("item/completed", longCommand);
  const longItem = (longEnd.params as { item: Record<string, unknown> }).item;
  assert.equal(longEnd.truncated, true);
  assert.deepEqual([longItem.id, longItem.status, longItem.exitCode, longItem.aggregatedOutput, (longItem.command as string).length, "commandActions" in longItem],
    ["exec-1", "failed", 1, "", 2_000, false]);
  assert.ok(!("preview" in (safeStreamPayload(longEnd.params).payload as object)), "it reaches the daemon whole");

  const small = { ...end, item: { ...end.item, aggregatedOutput: "ok\n" } };
  assert.deepEqual(boundedCommandEnd("item/completed", small), { params: small, truncated: false });
  assert.deepEqual(boundedCommandEnd("item/commandExecution/outputDelta", end), { params: end, truncated: false }, "only a command's end");
});

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
