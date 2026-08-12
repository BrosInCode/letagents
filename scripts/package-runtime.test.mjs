import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the packed MCP CLI reports its contract and exposes the supervised Cursor tools", { timeout: 120_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "letagents-package-runtime-"));

  try {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });

    const packOutput = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const [{ filename }] = JSON.parse(packOutput);
    const tarball = join(tempRoot, filename);
    const installRoot = join(tempRoot, "install");
    mkdirSync(installRoot);
    writeFileSync(join(installRoot, "package.json"), '{"private":true,"type":"module"}\n');

    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      { cwd: installRoot, stdio: "pipe" },
    );

    const packageRoot = join(installRoot, "node_modules", "letagents");
    const runtimeDependency = join(packageRoot, "dist", "api", "board-intent-payloads.js");
    assert.equal(existsSync(runtimeDependency), true, "packed runtime dependency is missing");
    const entry = join(packageRoot, "dist", "mcp", "server.js");
    const contract = JSON.parse(execFileSync(
      process.execPath,
      [entry, "--letagents-runtime-contract"],
      { cwd: installRoot, encoding: "utf8" },
    ));
    assert.equal(contract.format, 1);
    assert.equal(
      contract.profiles.cursor_supervised_room_turn.tools.includes("complete_room_turn"),
      true,
      "the published executable must advertise Cursor's exact completion tool",
    );

    const server = spawn(process.execPath, [entry], {
      cwd: installRoot,
      env: {
        ...process.env,
        LETAGENTS_API_URL: "http://127.0.0.1:9",
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
        LETAGENTS_SUPERVISOR_ENTRY_ID: "package_test_entry",
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-package-test.sock",
        LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "package_test_attempt",
        LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "package_test_generation",
        LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "package_test_session",
        LETAGENTS_SUPERVISOR_ROOM_ID: "package_test_room",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    server.stdout.setEncoding("utf8");
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const responses = new Map();
    const pending = new Map();
    const waitForResponse = (id) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP response ${id} timed out. stderr: ${stderr}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timeout });
      const buffered = responses.get(id);
      if (buffered) {
        responses.delete(id);
        clearTimeout(timeout);
        pending.delete(id);
        resolve(buffered);
      }
    });
    server.once("error", (error) => {
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(error);
      }
      pending.clear();
    });
    server.once("exit", (code, signal) => {
      if (code === null || code === 0) return;
      for (const item of pending.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error(`MCP server exited ${code}/${signal}. stderr: ${stderr}`));
      }
      pending.clear();
    });
    server.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        } else {
          responses.set(message.id, message);
        }
      }
    });

    const initialize = waitForResponse(1);
    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "package-runtime-test", version: "1.0.0" },
        },
      })}\n`,
    );

    try {
      const response = await initialize;
      assert.equal(response.jsonrpc, "2.0");
      assert.equal(response.id, 1);
      assert.ok(response.result?.serverInfo?.name);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = waitForResponse(2);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
      const toolResponse = await listed;
      const completionTools = toolResponse.result.tools.filter((tool) => tool.name === "complete_room_turn");
      assert.equal(completionTools.length, 1, "the packed runtime must expose exactly one completion tool");
      const completionSchema = completionTools[0].inputSchema;
      assert.equal(completionSchema?.type, "object");
      assert.equal(completionSchema?.properties?.outcome?.type, "string");
      assert.deepEqual(completionSchema?.properties?.outcome?.enum, ["reply", "no_reply"]);
      assert.equal(completionSchema?.properties?.text?.type, "string");
      assert.deepEqual(completionSchema?.required, ["outcome"], "text must remain optional for no-reply completion");
    } finally {
      server.kill("SIGTERM");
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
