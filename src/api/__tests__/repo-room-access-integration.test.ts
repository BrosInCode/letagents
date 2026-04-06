import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createProjectWithName = dbModule?.createProjectWithName;
const createSession = dbModule?.createSession;
const upsertAccount = dbModule?.upsertAccount;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const tsxBinary = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

const PUBLIC_ROOM = "github.com/brosincode/public-repo";
const PRIVATE_ROOM = "github.com/brosincode/private-repo";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed repo room access integration tests require TEST_DB_URL");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error("database did not become ready in time");
}

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed repo room access integration tests require TEST_DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

async function waitForServer(port: number, child: ChildProcessWithoutNullStreams, stderrBuffer: () => string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`repo room access test server exited early: ${stderrBuffer()}`.trim());
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until ready
    }

    await sleep(250);
  }

  throw new Error(`repo room access test server did not become ready: ${stderrBuffer()}`.trim());
}

async function startApiServer(githubApiBaseUrl: string): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  if (!testDatabaseUrl) {
    throw new Error("DB-backed repo room access integration tests require TEST_DB_URL");
  }

  const port = 3600 + Math.floor(Math.random() * 500);
  let stderr = "";

  const child = spawn(tsxBinary, ["src/api/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_URL: testDatabaseUrl,
      PORT: String(port),
      GITHUB_API_BASE_URL: githubApiBaseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  await waitForServer(port, child, () => stderr);
  return { child, port };
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(5000),
  ]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function handleGitHubApiRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname.toLowerCase();
  const authorization = req.headers.authorization;

  if (method !== "GET") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (pathname === "/repos/brosincode/public-repo") {
    writeJson(res, 200, {
      private: false,
      owner: { login: "BrosInCode" },
    });
    return;
  }

  if (pathname === "/repos/brosincode/private-repo") {
    if (!authorization) {
      writeJson(res, 404, { message: "Not Found" });
      return;
    }

    writeJson(res, 200, {
      private: true,
      owner: { login: "BrosInCode" },
    });
    return;
  }

  const permissionMatch = pathname.match(
    /^\/repos\/brosincode\/private-repo\/collaborators\/([^/]+)\/permission$/
  );
  if (permissionMatch) {
    if (!authorization) {
      writeJson(res, 401, { message: "Requires authentication" });
      return;
    }

    const login = decodeURIComponent(permissionMatch[1] || "");
    if (login === "collab") {
      writeJson(res, 200, { permission: "write" });
      return;
    }

    if (login === "repoadmin") {
      writeJson(res, 200, { permission: "admin" });
      return;
    }

    writeJson(res, 404, { message: "Not Found" });
    return;
  }

  writeJson(res, 404, { message: "Not Found" });
}

async function startGitHubApiStub(): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
  const server = createServer(handleGitHubApiRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind GitHub API stub");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopGitHubApiStub(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createGitHubSessionToken(input: {
  login: string;
  accessToken: string;
}): Promise<string> {
  if (!upsertAccount || !createSession) {
    throw new Error("DB-backed repo room access integration tests require TEST_DB_URL");
  }

  const account = await upsertAccount({
    provider: "github",
    provider_user_id: `gh-${input.login}`,
    login: input.login,
  });

  const token = `session-${input.login}-${Math.random().toString(36).slice(2, 10)}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await createSession(account.id, token, expiresAt, input.accessToken);
  return token;
}

async function joinRoom(input: {
  port: number;
  roomName: string;
  sessionToken?: string;
}): Promise<Response> {
  return fetch(`http://127.0.0.1:${input.port}/rooms/${encodeURIComponent(input.roomName)}/join`, {
    method: "POST",
    headers: input.sessionToken
      ? {
          Cookie: `letagents_session=${encodeURIComponent(input.sessionToken)}`,
        }
      : undefined,
  });
}

async function fetchRoomMessages(input: {
  port: number;
  roomName: string;
  sessionToken?: string;
}): Promise<Response> {
  return fetch(`http://127.0.0.1:${input.port}/rooms/${encodeURIComponent(input.roomName)}/messages`, {
    headers: input.sessionToken
      ? {
          Cookie: `letagents_session=${encodeURIComponent(input.sessionToken)}`,
        }
      : undefined,
  });
}

test.beforeEach(async () => {
  if (!requiresDatabase) {
    await resetDatabase();
  }
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

test(
  "public repo rooms allow anonymous joins through the real room join route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed repo room access integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName) {
      throw new Error("DB-backed repo room access integration tests require TEST_DB_URL");
    }

    const githubApi = await startGitHubApiStub();
    t.after(async () => {
      await stopGitHubApiStub(githubApi.server);
    });

    const { child, port } = await startApiServer(githubApi.baseUrl);
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await joinRoom({
      port,
      roomName: PUBLIC_ROOM,
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.room_id, PUBLIC_ROOM);
    assert.equal(payload.authenticated, false);
  }
);

test(
  "private repo rooms require authentication on the real room join route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed repo room access integration tests" : false,
  },
  async (t) => {
    const githubApi = await startGitHubApiStub();
    t.after(async () => {
      await stopGitHubApiStub(githubApi.server);
    });

    const { child, port } = await startApiServer(githubApi.baseUrl);
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await joinRoom({
      port,
      roomName: PRIVATE_ROOM,
    });

    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.code, "NOT_AUTHENTICATED");
    assert.equal(payload.room_id, PRIVATE_ROOM);
  }
);

test(
  "private repo rooms allow authenticated collaborators through the real room join route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed repo room access integration tests" : false,
  },
  async (t) => {
    const githubApi = await startGitHubApiStub();
    t.after(async () => {
      await stopGitHubApiStub(githubApi.server);
    });

    const sessionToken = await createGitHubSessionToken({
      login: "collab",
      accessToken: "github-token-collab",
    });

    const { child, port } = await startApiServer(githubApi.baseUrl);
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await joinRoom({
      port,
      roomName: PRIVATE_ROOM,
      sessionToken,
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.room_id, PRIVATE_ROOM);
    assert.equal(payload.authenticated, true);
  }
);

test(
  "protected room routes reject authenticated non-collaborators on private repo rooms",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed repo room access integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName) {
      throw new Error("DB-backed repo room access integration tests require TEST_DB_URL");
    }

    const githubApi = await startGitHubApiStub();
    t.after(async () => {
      await stopGitHubApiStub(githubApi.server);
    });

    await createProjectWithName(PRIVATE_ROOM);

    const outsiderSessionToken = await createGitHubSessionToken({
      login: "outsider",
      accessToken: "github-token-outsider",
    });

    const { child, port } = await startApiServer(githubApi.baseUrl);
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await fetchRoomMessages({
      port,
      roomName: PRIVATE_ROOM,
      sessionToken: outsiderSessionToken,
    });

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.code, "PRIVATE_REPO_NO_ACCESS");
    assert.equal(payload.room_id, PRIVATE_ROOM);
  }
);
