import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cursorWrapperMcpSource } from "#provider-runtime/agents/cursor/turn-wrapper-mcp.js";
import {
  edgeDevMcpCompletionInputSchema,
  materializeDevMcpPackage,
  type EdgeDevMcpCompletionContract,
} from "./edge/daemon-edge-harness.js";

// Before it starts Cursor, the Cursor turn wrapper sends initialize and tools/list
// to the MCP runtime it hosts and refuses a runtime whose complete_room_turn schema
// is not the product contract. With LETAGENTS_DEV_MCP_SERVER_ENTRY set, that runtime
// is the edge harness's stand-in, so the stand-in must list the product schema, or
// every Cursor turn under the harness ends `not_started` (task_21, run cr8).

type CompletionValidator = (response: unknown) => boolean;

/** The wrapper's own check, taken from the exact source it runs, so the two cannot drift. */
function wrapperCompletionValidator(platform: NodeJS.Platform): CompletionValidator {
  const source = cursorWrapperMcpSource(platform);
  const match = /\nfunction hasRequiredCompletionContract\(response\) \{\n[\s\S]*?\n\}\n/.exec(source);
  assert.ok(match, `the ${platform} wrapper source defines hasRequiredCompletionContract`);
  return new Function(`${match[0]}\nreturn hasRequiredCompletionContract;`)() as CompletionValidator;
}

/** Start the materialized stand-in, then send the wrapper's initialize and tools/list. */
async function standInToolsList(contract: EdgeDevMcpCompletionContract): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), `letagents-edge-mcp-stub-${contract}-`));
  try {
    const entry = await materializeDevMcpPackage(join(root, "dev-mcp"), contract);
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      return await new Promise((resolve, reject) => {
        let buffer = "";
        child.once("error", reject);
        child.once("exit", (code, signal) => reject(new Error(`the stand-in exited early (${code ?? signal})`)));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const message = JSON.parse(line) as { id?: unknown };
            if (message.id === "init") {
              child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
              child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} })}\n`);
            } else if (message.id === "list") {
              resolve(message);
            }
          }
        });
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "edge-stub-contract-test", version: "1.0.0" } },
        })}\n`);
      });
    } finally {
      child.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const platform of ["darwin", "win32"] as const) {
  test(`the Cursor wrapper (${platform}) accepts the edge stand-in's default completion contract`, async () => {
    const validator = wrapperCompletionValidator(platform);
    const response = await standInToolsList("product");
    assert.equal(validator(response), true);
    const tools = (response as { result: { tools: Array<{ name: string; inputSchema: unknown }> } }).result.tools;
    const completion = tools.filter((tool) => tool.name === "complete_room_turn");
    assert.equal(completion.length, 1);
    assert.deepEqual(completion[0]!.inputSchema, edgeDevMcpCompletionInputSchema("product"));
  });

  test(`the Cursor wrapper (${platform}) still refuses the summary-only completion contract`, async () => {
    const validator = wrapperCompletionValidator(platform);
    // The check is an && chain, so a refusal is any falsy value (here undefined), not only false.
    assert.equal(Boolean(validator(await standInToolsList("summary_only"))), false);
  });
}
