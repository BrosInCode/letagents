import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeProviderAdapter } from "../main/agents/claude-code-provider-adapter.js";
import { CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import type { ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import { safeStreamPayload } from "../main/agents/provider-evidence.js";
import { createHarness as createClaudeHarness, spawnRequest as claudeSpawnRequest } from "./claude-code-provider-adapter.fixture.js";
import { createHarness as createCodexHarness, spawnRequest as codexSpawnRequest, flush } from "./codex-provider-adapter.fixture.js";

// Large enough that the bounded payload loses the text, so the evidence must come from the raw event.
const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`);

test("Claude Code: edit evidence is read from the raw tool result; the bounded payload is unchanged", async () => {
  const harness = createClaudeHarness();
  const events: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => events.push(event) });
  const handle = await adapter.spawn(claudeSpawnRequest());
  const raw = { type: "user", session_id: handle.providerContinuationId, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "File created successfully" }] },
    tool_use_result: { type: "create", filePath: "/w/big.txt", content: lines.join("\n"), structuredPatch: [], originalFile: null } };
  events.length = 0;
  harness.children[0]!.emit(raw);
  const event = events.find((candidate) => candidate.editEvidence);
  assert.ok(event, "the tool result carries its evidence");
  assert.deepEqual(event.editEvidence!.map(({ path, additions, deletions, patch_truncated }) => [path, additions, deletions, patch_truncated]),
    [["/w/big.txt", 2_000, 0, true]], "the counts come from the whole raw result");
  assert.ok(event.editEvidence![0]!.patch.startsWith("@@ -0,0 +1,2000 @@\n+line 0 "));
  const bounded = safeStreamPayload(raw);
  assert.equal(bounded.payloadTruncated, true);
  assert.deepEqual([event.payload, event.payloadTruncated, event.payloadRedacted], [bounded.payload, bounded.payloadTruncated, bounded.payloadRedacted]);
  harness.children[0]!.emit({ type: "user", session_id: handle.providerContinuationId, message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "denied" }] },
    tool_use_result: "User rejected tool use" });
  assert.equal(events.at(-1)?.editEvidence, undefined, "a refused call has none");
  assert.ok(events.filter((candidate) => !candidate.editEvidence).every((candidate) => !("editEvidence" in candidate)));
});

test("Codex: edit evidence is read from the raw fileChange item; the bounded payload is unchanged", async () => {
  const harness = createCodexHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(codexSpawnRequest({ deliveryMode: "daemon_inbox" }));
  const events: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => events.push(event));
  const threadId = handle.providerContinuationId;
  const params = { threadId, turnId: "turn-1", item: { type: "fileChange", id: "item-1", status: "completed",
    changes: [{ path: "src/big.ts", kind: { type: "update", move_path: null },
      diff: `--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,2000 +1,2000 @@\n${lines.map((line) => `-${line}\n+${line}!`).join("\n")}\n` }] } };
  harness.clients[0]!.emit({ method: "item/completed", params });
  await flush();
  const event = events.find((candidate) => candidate.method === "item/completed");
  assert.ok(event?.editEvidence);
  assert.deepEqual(event.editEvidence.map(({ path, additions, deletions, patch_truncated }) => [path, additions, deletions, patch_truncated]),
    [["src/big.ts", 2_000, 2_000, true]]);
  const bounded = safeStreamPayload(params);
  assert.equal(bounded.payloadTruncated, true);
  assert.deepEqual([event.payload, event.payloadTruncated, event.payloadRedacted], [bounded.payload, bounded.payloadTruncated, bounded.payloadRedacted]);
  harness.clients[0]!.emit({ method: "item/completed", params: { ...params, item: { ...params.item, id: "item-2", status: "declined" } } });
  await flush();
  assert.equal(events.filter((candidate) => candidate.method === "item/completed").at(-1)?.editEvidence, undefined, "a declined change has none");
});
