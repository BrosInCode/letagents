import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the packed MCP CLI installs and completes initialize", { timeout: 120_000 }, async () => {
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

    const server = spawn(process.execPath, [join(packageRoot, "dist", "mcp", "server.js")], {
      cwd: installRoot,
      env: {
        ...process.env,
        LETAGENTS_API_URL: "http://127.0.0.1:9",
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

    const initialize = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MCP initialize timed out. stderr: ${stderr}`));
      }, 15_000);

      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`MCP server exited ${code}/${signal}. stderr: ${stderr}`));
        }
      });
      server.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timeout);
            resolve(message);
          }
        }
      });
    });

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
    } finally {
      server.kill("SIGTERM");
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
