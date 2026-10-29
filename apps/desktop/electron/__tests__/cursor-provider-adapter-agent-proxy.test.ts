import "./isolated-home.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisedAgentTest as test } from "./platform.js";
import { CursorProviderAdapter, defaultLaunchTurn } from "../main/agents/cursor-provider-adapter.js";
import {
  productionPersonalIdentityDependencies,
  wrapperHostedMcpFixture,
  cursorMcpAttestationFixtureSource,
  daemonSpawnRequest,
  roomTurnRequest,
  waitForPath,
  withLoopAlive,
} from "./cursor-provider-adapter.fixture.js";

test("the production supervised wrapper blocks remote Cursor authority and retires its loopback proxy", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-remote-authority-"));
  const controlRequests: Array<{ method: string; path: string; authorization: string; body: string }> = [];
  const controlUpstream = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      controlRequests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: String(request.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/proto", "content-length": "0" });
      response.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    controlUpstream.once("error", rejectListen);
    controlUpstream.listen(0, "127.0.0.1", () => {
      controlUpstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const controlAddress = controlUpstream.address();
  assert.ok(controlAddress && typeof controlAddress !== "string");
  const testControlPlaneUpstreamEndpoint = `http://127.0.0.1:${controlAddress.port}`;
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}
const endpoint = value("--endpoint");
const agentEndpoint = value("--agent-endpoint");
if (!endpoint || !agentEndpoint || agentEndpoint === endpoint
  || !agentEndpoint.startsWith("http://127.0.0.1:")
  || value("--http-version") !== "1.1") process.exit(7);
const blockedPaths = [
  "/aiserver.v1.DashboardService/GetMcpConfig",
  "/aiserver.v1.DashboardService/GetEffectiveUserPlugins",
  "/aiserver.v1.DashboardService/GetManagedSkills",
  "/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam",
  "/aiserver.v1.DashboardService/GetTeamHooks",
  "/aiserver.v1.AnalyticsService/BootstrapStatsig",
];
function expectBlocked(path) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, endpoint), {
      method: "POST",
      headers: { "content-length": "0", "authorization": "Bearer " + value("--auth-token") },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 503 ? resolve() : reject(new Error("unexpected status")));
    });
    request.once("error", reject);
    request.end();
  });
}
function expectAllowed(path) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, endpoint), {
      method: "POST",
      headers: { "content-length": "0", "authorization": "Bearer " + value("--auth-token") },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error("allowed request was rejected")));
    });
    request.once("error", reject);
    request.end();
  });
}
function expectChunkedBlocked() {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL("/aiserver.v1.DashboardService/GetMe", endpoint), {
      method: "POST",
      headers: { "transfer-encoding": "chunked", "authorization": "Bearer " + value("--auth-token") },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 503 ? resolve() : reject(new Error("chunked request was accepted")));
    });
    request.once("error", reject);
    request.end("x");
  });
}
Promise.all([
  expectAllowed("/aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam"),
  ...blockedPaths.map(expectBlocked),
  expectChunkedBlocked(),
]).then(() => {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-remote-authority" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: endpoint, session_id: "sess-remote-authority" }) + "\\n");
}).catch(() => process.exit(9));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testControlPlaneUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.match(result.text ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(controlRequests, [{
      method: "POST",
      path: "/aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
      authorization: "Bearer test-provider-authorization",
      body: "",
    }]);
    const proxyUrl = new URL(result.text!);
    await new Promise<void>((resolveRequest, rejectRequest) => {
      const request = httpRequest(proxyUrl, { method: "POST" });
      request.once("response", () => rejectRequest(new Error("retired Cursor authority proxy still accepted requests")));
      request.once("error", () => resolveRequest());
      request.end();
    });
  } finally {
    await new Promise<void>((resolveClose) => controlUpstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal evidence waits for in-flight control and agent bearer authority to be destroyed", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-inflight-authority-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  const writableRoot = join(root, "tmp");
  const controlMarker = join(writableRoot, "control-received");
  const agentMarker = join(writableRoot, "agent-received");
  const revokedStatus = join(writableRoot, "detached-revoked.json");
  const detachedPidPath = join(writableRoot, "detached.pid");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(writableRoot, { recursive: true });
  let controlAuthorization = "";
  let agentAuthorization = "";
  let controlSocketClosed = false;
  let agentStreamClosed = false;
  const controlUpstream = createHttpServer((request, response) => {
    controlAuthorization = String(request.headers.authorization ?? "");
    request.socket.once("close", () => { controlSocketClosed = true; });
    response.once("close", () => { controlSocketClosed = true; });
    request.resume();
    writeFileSync(controlMarker, "received");
    // Deliberately never respond: retirement must destroy this in-flight
    // bearer request before its terminal can authorize recovery.
  });
  const agentUpstream = createHttp2Server();
  agentUpstream.on("stream", (stream, headers) => {
    agentAuthorization = String(headers.authorization ?? "");
    stream.once("close", () => { agentStreamClosed = true; });
    stream.resume();
    writeFileSync(agentMarker, "received");
    // Deliberately keep the bidirectional Run stream active.
  });
  await Promise.all([
    new Promise<void>((resolveListen, rejectListen) => {
      controlUpstream.once("error", rejectListen);
      controlUpstream.listen(0, "127.0.0.1", () => {
        controlUpstream.removeListener("error", rejectListen);
        resolveListen();
      });
    }),
    new Promise<void>((resolveListen, rejectListen) => {
      agentUpstream.once("error", rejectListen);
      agentUpstream.listen(0, "127.0.0.1", () => {
        agentUpstream.removeListener("error", rejectListen);
        resolveListen();
      });
    }),
  ]);
  const controlAddress = controlUpstream.address();
  const agentAddress = agentUpstream.address();
  assert.ok(controlAddress && typeof controlAddress !== "string");
  assert.ok(agentAddress && typeof agentAddress !== "string");
  const testControlPlaneUpstreamEndpoint = `http://127.0.0.1:${controlAddress.port}`;
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${agentAddress.port}`;
  let detachedPid: number | null = null;
  try {
    const detachedSource = `
const fs = require("node:fs");
const http = require("node:http");
const http2 = require("node:http2");
${cursorMcpAttestationFixtureSource}
const [statusPath, controlEndpoint, agentEndpoint, placeholderToken] = process.argv.slice(1);
let controlClosed = false;
let agentClosed = false;
const keepAlive = setInterval(() => {}, 1000);
function finish() {
  if (!controlClosed || !agentClosed) return;
  clearInterval(keepAlive);
  fs.writeFileSync(statusPath, JSON.stringify({ controlClosed, agentClosed }));
}
attestFixtureMcp().then(() => {
const control = http.request(new URL("/aiserver.v1.DashboardService/GetMe", controlEndpoint), {
  method: "POST",
  headers: { "content-length": "4", "connection": "keep-alive", "authorization": "Bearer " + placeholderToken },
});
control.once("response", (response) => { response.resume(); response.once("close", () => { controlClosed = true; finish(); }); });
control.once("error", () => { controlClosed = true; finish(); });
control.once("close", () => { controlClosed = true; finish(); });
control.end("ping");
const session = http2.connect(agentEndpoint);
const stream = session.request({
  ":method": "POST",
  ":path": "/agent.v1.AgentService/Run",
  "content-type": "application/connect+proto",
  "authorization": "Bearer " + placeholderToken,
});
function agentDone() { agentClosed = true; try { session.destroy(); } catch {} finish(); }
stream.once("error", agentDone);
stream.once("close", agentDone);
session.once("error", agentDone);
session.once("close", agentDone);
stream.write("active-run");
}).catch(() => process.exit(92));
`;
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const escaped = spawn(process.execPath, ["-e", ${JSON.stringify(detachedSource)}, ${JSON.stringify(revokedStatus)}, value("--endpoint"), value("--agent-endpoint"), value("--auth-token")], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(detachedPidPath)}, String(escaped.pid));
let checks = 0;
const ready = setInterval(() => {
  checks += 1;
  if (fs.existsSync(${JSON.stringify(controlMarker)}) && fs.existsSync(${JSON.stringify(agentMarker)})) {
    clearInterval(ready);
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-inflight-authority" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "inflight-authority-open", session_id: "sess-inflight-authority" }) + "\\n");
  } else if (checks > 250) process.exit(91);
}, 20);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint, testControlPlaneUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "inflight-authority-open");
    detachedPid = Number(readFileSync(detachedPidPath, "utf8"));
    assert.equal(await waitForPath(revokedStatus), true, "the detached fixture observes both upstream sockets closing");
    assert.deepEqual(JSON.parse(readFileSync(revokedStatus, "utf8")), { controlClosed: true, agentClosed: true });
    assert.equal(controlAuthorization, "Bearer test-provider-authorization");
    assert.equal(agentAuthorization, "Bearer test-provider-authorization");
    assert.equal(controlSocketClosed, true, "control upstream is closed before the terminal result resolves");
    assert.equal(agentStreamClosed, true, "agent upstream is closed before the terminal result resolves");
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(result.turnId).digest("hex")}.jsonl.terminal.json`);
    assert.equal(JSON.parse(readFileSync(terminalPath, "utf8")).remote_authority_revoked, true);
  } finally {
    if (detachedPid && Number.isSafeInteger(detachedPid)) {
      try { process.kill(detachedPid, "SIGKILL"); } catch {}
    }
    await Promise.all([
      new Promise<void>((resolveClose) => controlUpstream.close(() => resolveClose())),
      new Promise<void>((resolveClose) => agentUpstream.close(() => resolveClose())),
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy admits HTTP/1 retries and background Runs until the native terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-agent-h1-proxy-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  const terminalObserved = join(root, "terminal-observed");
  const terminalProbe = join(homeDir, "terminal-probe");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamAuthorization = "";
  let upstreamBody = "";
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    upstreamAuthorization = String(headers.authorization ?? "");
    let body = "";
    stream.on("data", (chunk) => { body += chunk.toString("utf8"); });
    stream.once("end", () => {
      upstreamBody += body + ";";
      stream.respond({ ":status": body === "transient-failure" ? 503 : 200, "content-type": "application/connect+proto" });
      stream.end("h1-upstream-ok");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const endpoint = value("--agent-endpoint");
function request(path, contentType, body, authorization = "Bearer " + value("--auth-token")) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, endpoint), {
      method: "POST",
      headers: { "content-type": contentType, authorization, "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
(async () => {
  const connector = await attestFixtureMcp();
  const wrongMedia = await request("/agent.v1.AgentService/Run", "application/connect+protobufad", "wrong");
  const wrongPath = await request("/agent.v1.AgentService/Other", "application/connect+proto", "wrong");
  const staleTurn = await request("/agent.v1.AgentService/Run", "application/connect+proto", "stale", "Bearer predecessor-placeholder");
  const accepted = await request("/agent.v1.AgentService/Run", "application/connect+proto; charset=binary", "h1-request-body");
  const transient = await request("/agent.v1.AgentService/Run", "application/connect+proto", "transient-failure");
  const retry = await request("/agent.v1.AgentService/Run", "application/connect+proto", "resume-action");
  const background = await request("/agent.v1.AgentService/Run", "application/connect+proto", "background-completion");
  if (wrongMedia.status !== 503 || wrongPath.status !== 503 || staleTurn.status !== 503
    || accepted.status !== 200 || accepted.body !== "h1-upstream-ok" || transient.status !== 503 || retry.status !== 200 || background.status !== 200) process.exit(78);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-agent-h1" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "h1-proxy-ok", session_id: "sess-agent-h1" }) + "\\n");
  while (!fs.existsSync(${JSON.stringify(terminalObserved)})) await new Promise((resolve) => setTimeout(resolve, 5));
  const afterTerminal = await request("/agent.v1.AgentService/Run", "application/connect+proto", "after-terminal");
  fs.writeFileSync(${JSON.stringify(terminalProbe)}, String(afterTerminal.status));
  if (afterTerminal.status !== 503) process.exit(80);
  detachFixtureMcp(connector);
})().catch(() => process.exit(79));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          const child = defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
          child.onLine((line) => { if (JSON.parse(line).type === "result") writeFileSync(terminalObserved, "observed"); });
          return child;
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "h1-proxy-ok");
    assert.equal(upstreamAuthorization, "Bearer test-provider-authorization");
    assert.equal(upstreamBody, "h1-request-body;transient-failure;resume-action;background-completion;");
    assert.equal(readFileSync(terminalProbe, "utf8"), "503");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing an attested Cursor connector revokes the model proxy before a later Run", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-lease-close-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const writableRoot = join(root, "tmp");
  const executable = join(root, "fake-cursor-agent");
  const attemptPath = join(writableRoot, "late-run.json");
  const attackerPidPath = join(writableRoot, "late-run.pid");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(writableRoot, { recursive: true });
  let upstreamRuns = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    upstreamRuns += 1;
    stream.resume();
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end("must-not-arrive");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  let attackerPid: number | null = null;
  try {
    const attackerSource = `
const fs = require("node:fs");
const http = require("node:http");
const [statusPath, endpoint, token] = process.argv.slice(1);
setTimeout(() => {
  const request = http.request(new URL("/agent.v1.AgentService/Run", endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "authorization": "Bearer " + token,
      "content-length": "4",
    },
  }, (response) => {
    response.resume();
    response.once("end", () => fs.writeFileSync(statusPath, JSON.stringify({ status: response.statusCode })));
  });
  request.once("error", (error) => fs.writeFileSync(statusPath, JSON.stringify({ error: error.code || error.message })));
  request.end("late");
}, 250);
`;
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
(async () => {
  const connector = await attestFixtureMcp();
  const attacker = spawn(process.execPath, ["-e", ${JSON.stringify(attackerSource)}, ${JSON.stringify(attemptPath)}, value("--agent-endpoint"), value("--auth-token")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  attacker.unref();
  fs.writeFileSync(${JSON.stringify(attackerPidPath)}, String(attacker.pid));
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-live-lease-close" }) + "\\n");
  connector.stdin.end();
  setInterval(() => {}, 1000);
})().catch(() => process.exit(97));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root, workAttemptId: "wa-cursor-live-lease-close" }));
    const ended = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-lease-close" })));
    assert.equal(ended.outcome, "interrupted");
    assert.match(ended.error ?? "", /supervised turn failed: Cursor's live MCP connector ended before the turn became terminal/);
    assert.equal(await waitForPath(attackerPidPath), true);
    attackerPid = Number(readFileSync(attackerPidPath, "utf8"));
    assert.equal(await waitForPath(attemptPath), true, "the escaped late Run probe observed the retired proxy");
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8")) as { status?: number; error?: string };
    assert.notEqual(attempt.status, 200, "the revoked lease cannot reach the model upstream");
    assert.equal(upstreamRuns, 0, "the model upstream sees no Run after connector lease loss");
  } finally {
    if (attackerPid && Number.isSafeInteger(attackerPid)) {
      try { process.kill(attackerPid, "SIGKILL"); } catch {}
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy relays sequential and bounded concurrent HTTP/2 Runs through the live turn lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-agent-h2-proxy-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  const slotReleased = join(root, "slot-released");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamAuthorization = "";
  const upstreamBodies: string[] = [];
  let upstreamRuns = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    upstreamRuns += 1;
    upstreamAuthorization = String(headers.authorization ?? "");
    let body = "";
    stream.on("error", () => {});
    stream.on("data", (chunk) => { body += chunk.toString("utf8"); });
    stream.once("close", () => {
      if (headers["x-fixture-child"] === "0") writeFileSync(slotReleased, "closed");
    });
    if (headers["x-fixture-child"] !== undefined) stream.respond({ ":status": 200 });
    stream.once("end", () => {
      upstreamBodies.push(body);
      setTimeout(() => {
        if (!stream.headersSent) stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        stream.end("h2-upstream-ok");
      }, body === "h2-request-body" ? 5_250 : 0);
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http2 = require("node:http2");
const fs = require("node:fs");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const endpoint = value("--agent-endpoint");
const client = http2.connect(endpoint);
function startRequest(path, contentType, body, authorization = "Bearer " + value("--auth-token"), child) {
  let stream;
  let headersReady;
  const ready = new Promise((resolve) => { headersReady = resolve; });
  const done = new Promise((resolve, reject) => {
    stream = client.request({
      ":method": "POST", ":path": path,
      "content-type": contentType,
      authorization,
      ...(child === undefined ? {} : { "x-fixture-child": String(child) }),
    });
    const chunks = [];
    let status = 0;
    stream.once("response", (headers) => { status = Number(headers[":status"] || 0); headersReady(status); });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    if (child === undefined) stream.end(body);
    else stream.write(body);
  });
  return { stream, ready, done };
}
function request(...args) { return startRequest(...args).done; }
(async () => {
  const connector = await attestFixtureMcp();
  const wrongMedia = await request("/agent.v1.AgentService/Run", "application/connect+protobufad", "wrong");
  const wrongPath = await request("/agent.v1.AgentService/Other", "application/connect+proto", "wrong");
  const staleTurn = await request("/agent.v1.AgentService/Run", "application/connect+proto", "stale", "Bearer predecessor-placeholder");
  const accepted = await request("/agent.v1.AgentService/Run", "application/connect+proto; charset=binary", "h2-request-body");
  const children = Array.from({ length: 24 }, (_, index) => startRequest("/agent.v1.AgentService/Run", "application/connect+proto", "child-" + index, undefined, index));
  if ((await Promise.all(children.map((child) => child.ready))).some((status) => status !== 200)) process.exit(91);
  const overflow = await request("/agent.v1.AgentService/Run", "application/connect+proto", "overflow");
  if (overflow.status !== 503) process.exit(92);
  children[0].stream.close();
  await children[0].done;
  while (!fs.existsSync(${JSON.stringify(slotReleased)})) await new Promise((resolve) => setTimeout(resolve, 5));
  const replacement = startRequest("/agent.v1.AgentService/Run", "application/connect+proto", "replacement-child", undefined, 24);
  if (await replacement.ready !== 200) process.exit(93);
  for (const child of [...children.slice(1), replacement]) child.stream.end();
  await Promise.all([...children.slice(1), replacement].map((child) => child.done));
  const background = await request("/agent.v1.AgentService/Run", "application/connect+proto", "background-completion");
  client.close();
  if (wrongMedia.status !== 503 || wrongPath.status !== 503 || staleTurn.status !== 503
    || accepted.status !== 200 || accepted.body !== "h2-upstream-ok" || background.status !== 200) process.exit(88);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-agent-h2" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "h2-proxy-ok", session_id: "sess-agent-h2" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(89));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "h2-proxy-ok");
    assert.equal(upstreamRuns, 27);
    assert.equal(upstreamAuthorization, "Bearer test-provider-authorization");
    assert.ok(upstreamBodies.includes("h2-request-body"));
    assert.ok(upstreamBodies.includes("replacement-child"));
    assert.ok(upstreamBodies.includes("background-completion"));
    assert.ok(!upstreamBodies.includes("overflow"));
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

for (const terminalWhileHeld of [false, true]) {
test(`the supervised agent proxy bounds and cancels held Runs before ${terminalWhileHeld ? "terminal" : "attestation"}`, async () => {
  // Cursor opens its model connection at startup, before its MCP handshake has
  // finished. The proxy must HOLD that first Run until live attestation
  // completes and then admit it -- not reject it, which is what made Cursor
  // retry to death (the StoneForge incident). The fake fires the Run before
  // attesting, so a regression to immediate rejection surfaces as a 503.
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-hold-admit-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  const terminalObserved = join(root, "terminal-observed");
  const heldProbe = join(homeDir, "held-probe");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamAuthorization = "";
  let upstreamBody = "";
  const upstream = createHttp2Server();
  upstream.on("stream", (stream, headers) => {
    upstreamAuthorization = String(headers.authorization ?? "");
    stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
    stream.once("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end("held-upstream-ok");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http2 = require("node:http2");
const fs = require("node:fs");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const client = http2.connect(value("--agent-endpoint"));
function request(body, path = "/agent.v1.AgentService/Run") {
  let stream;
  const done = new Promise((resolve, reject) => {
    stream = client.request({ ":method": "POST", ":path": path, "content-type": "application/connect+proto", authorization: "Bearer " + value("--auth-token") });
    const chunks = [];
    let status = 0;
    stream.once("response", (headers) => { status = Number(headers[":status"] || 0); });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    stream.once("close", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    stream.end(body);
  });
  return { stream, done };
}
(async () => {
  const held = Array.from({ length: 24 }, (_, index) => request("held-" + index));
  const overflow = await request("overflow").done;
  if (overflow.status !== 503) process.exit(91);
  held[0].stream.close();
  await held[0].done;
  // A response from the same HTTP/2 session acknowledges processing past the
  // cancellation without requiring a timing allowance in the production code.
  await request("barrier", "/agent.v1.AgentService/Other").done;
  const replacement = request("replacement-held");
  if ((await request("overflow-again").done).status !== 503) process.exit(92);
  const remaining = [...held.slice(1), replacement];
  const init = { type: "system", subtype: "init", session_id: "sess-hold-admit" };
  const result = { type: "result", subtype: "success", is_error: false, result: "hold-admit-ok", session_id: "sess-hold-admit" };
  if (${terminalWhileHeld}) {
    process.stdout.write(JSON.stringify(init) + "\\n");
    process.stdout.write(JSON.stringify(result) + "\\n");
    while (!fs.existsSync(${JSON.stringify(terminalObserved)})) await new Promise((resolve) => setTimeout(resolve, 5));
    if ((await Promise.all(remaining.map((pending) => pending.done))).some((response) => response.status !== 503)) process.exit(93);
  }
  const connector = await attestFixtureMcp();
  if (!${terminalWhileHeld}) {
    // Held Runs may finish once the MCP socket connects, before tools/list returns.
    const responses = await Promise.all(remaining.map((pending) => pending.done));
    if (responses.some((response) => response.status !== 200 || response.body !== "held-upstream-ok")) process.exit(94);
    if ((await request("background-completion").done).status !== 200) process.exit(95);
    process.stdout.write(JSON.stringify(init) + "\\n");
    process.stdout.write(JSON.stringify(result) + "\\n");
  } else if ((await request("after-terminal-attestation").done).status !== 503) process.exit(96);
  fs.writeFileSync(${JSON.stringify(heldProbe)}, "verified");
  client.close();
  detachFixtureMcp(connector);
})().catch(() => process.exit(89));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          const child = defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint });
          child.onLine((line) => { if (JSON.parse(line).type === "result") writeFileSync(terminalObserved, "observed"); });
          return child;
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: "wa-cursor-hold-admit", cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "hold-admit" })));
    assert.equal(result.text, "hold-admit-ok");
    assert.equal(readFileSync(heldProbe, "utf8"), "verified");
    if (terminalWhileHeld) {
      assert.equal(upstreamBody, "", "terminal rejects every held Run even if MCP later attests");
      assert.equal(upstreamAuthorization, "");
    } else {
      assert.equal(upstreamAuthorization, "Bearer test-provider-authorization");
      assert.ok(upstreamBody.includes("replacement-held"));
      assert.ok(upstreamBody.includes("background-completion"));
      assert.ok(!upstreamBody.includes("overflow"));
    }
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

}

test("a held Run whose MCP attestation never completes fails with the exact causal reason and is never forwarded upstream", async () => {
  // With the model Run held rather than rejected, Cursor no longer dies in a
  // retry storm; the turn instead fails when the capability deadline elapses,
  // recording that exact attestation reason (not the generic connector-ended
  // message). Critically, a held Run whose attestation FAILS must never reach
  // the model backend: the recording upstream must see zero requests. A
  // regression that fail-opens the held release path would forward it here and
  // trip that assertion (the code-only mutation this test is designed to kill).
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-held-timeout-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamHits = 0;
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    upstreamHits += 1;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end("must-never-be-reached");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
const body = "never-attested";
const req = http.request(new URL("/agent.v1.AgentService/Run", value("--agent-endpoint")), {
  method: "POST",
  headers: { "content-type": "application/connect+proto", authorization: "Bearer " + value("--auth-token"), "content-length": Buffer.byteLength(body) },
}, () => {});
req.on("error", () => {});
req.end(body);
setInterval(() => {}, 1000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint,
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
            testMcpCapabilityTimeoutMs: 800,
          });
        },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: "wa-cursor-held-timeout", cwd: root }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "held-timeout" }))),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        assert.match(message, /never connected the attested MCP runtime before model authority/);
        assert.doesNotMatch(message, /connector ended/);
        return true;
      },
    );
    assert.equal(upstreamHits, 0, "a held Run whose attestation failed must never be forwarded to the model backend");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent supervised agents each hold and admit their own Run independently", async () => {
  // The hold state is per-wrapper-process, so concurrent turns must not
  // interfere: each holds its own first Run and admits it on its own
  // attestation, with no shared admission slot or cross-turn deadlock.
  const buildAgent = async (label: string) => {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-concurrent-${label}-`));
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    let upstreamBody = "";
    const upstream = createHttp2Server();
    upstream.on("stream", (stream) => {
      stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
      stream.once("end", () => {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        stream.end(`concurrent-upstream-${label}`);
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      upstream.once("error", rejectListen);
      upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
    });
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function request(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL("/agent.v1.AgentService/Run", value("--agent-endpoint")), {
      method: "POST",
      headers: { "content-type": "application/connect+proto", authorization: "Bearer " + value("--auth-token"), "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
(async () => {
  const held = request("concurrent-body-${label}");
  const connector = await attestFixtureMcp();
  const admitted = await held;
  if (admitted.status !== 200 || admitted.body !== "concurrent-upstream-${label}") process.exit(70);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-concurrent-${label}" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "concurrent-${label}-ok", session_id: "sess-concurrent-${label}" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(71));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) { return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint }); },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: `wa-cursor-concurrent-${label}`, cwd: root }));
    return {
      root,
      upstream,
      run: () => withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: `concurrent-${label}` }))),
    };
  };
  const agentA = await buildAgent("a");
  const agentB = await buildAgent("b");
  try {
    const [resultA, resultB] = await Promise.all([agentA.run(), agentB.run()]);
    assert.equal(resultA.text, "concurrent-a-ok");
    assert.equal(resultB.text, "concurrent-b-ok");
  } finally {
    await new Promise<void>((resolveClose) => agentA.upstream.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => agentB.upstream.close(() => resolveClose()));
    rmSync(agentA.root, { recursive: true, force: true });
    rmSync(agentB.root, { recursive: true, force: true });
  }
});

test("the supervised agent proxy rejects a boundary-violating request immediately, never holding it for attestation", async () => {
  // The attestation hold is only for authorized Run requests. A request
  // outside that boundary -- wrong path or a bearer that is not the wrapper's
  // placeholder -- must be rejected at once, never granted the grace window.
  // The fake awaits those rejections BEFORE attesting: if such a request were
  // held, the await would block until the deadline and the turn would fail, so
  // reaching attestation and a 200 proves the immediate, hold-free rejection.
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-boundary-"));
  const configDir = join(root, "config");
  const homeDir = join(root, "home");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let upstreamBody = "";
  const upstream = createHttp2Server();
  upstream.on("stream", (stream) => {
    stream.on("data", (chunk) => { upstreamBody += chunk.toString("utf8"); });
    stream.once("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end("boundary-upstream-ok");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(0, "127.0.0.1", () => { upstream.removeListener("error", rejectListen); resolveListen(); });
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const testAgentUpstreamEndpoint = `http://127.0.0.1:${upstreamAddress.port}`;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
${cursorMcpAttestationFixtureSource}
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }
function request(path, body, authorization = "Bearer " + value("--auth-token")) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, value("--agent-endpoint")), {
      method: "POST",
      headers: { "content-type": "application/connect+proto", authorization, "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
(async () => {
  // These resolve only if rejected immediately; if held, the awaits would hang.
  const wrongPath = await request("/agent.v1.AgentService/Other", "x");
  const badBearer = await request("/agent.v1.AgentService/Run", "x", "Bearer not-the-placeholder");
  if (wrongPath.status !== 503 || badBearer.status !== 503) process.exit(74);
  const connector = await attestFixtureMcp();
  const accepted = await request("/agent.v1.AgentService/Run", "boundary-request-body");
  if (accepted.status !== 200 || accepted.body !== "boundary-upstream-ok") process.exit(75);
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-boundary" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "boundary-ok", session_id: "sess-boundary" }) + "\\n");
  detachFixtureMcp(connector);
})().catch(() => process.exit(76));
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) { return defaultLaunchTurn({ ...input, testAgentUpstreamEndpoint }); },
      },
      supervisedProfileFactory: (input) => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root, input.mcpConnectorSocketPath, "valid", true),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ workAttemptId: "wa-cursor-boundary", cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "boundary" })));
    assert.equal(result.text, "boundary-ok");
    assert.equal(upstreamBody, "boundary-request-body");
  } finally {
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
