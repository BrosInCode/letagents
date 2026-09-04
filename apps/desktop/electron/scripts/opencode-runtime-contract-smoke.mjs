import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const {
  credentialBoundaryPluginSource,
  minimalOpenCodeEnvironment,
  OPEN_MODEL_OPENCODE_PROVIDER_ID,
  OPENCODE_SERVER_USERNAME,
  openCodeAuthContent,
  openCodeConfig,
} = await import("../../dist-electron/main/agents/opencode-launch-contract.js");
const { OPENCODE_RUNTIME_VERSION } = await import(
  "../../dist-electron/main/agents/opencode-runtime.js"
);
const { OpenCodeServerClient, eventReferencesSession, mintNativeUserMessageId, parseOpenCodePermissionEvent } = await import(
  "../../dist-electron/main/agents/opencode-server-client.js"
);

const CONTRACT_SENTINEL = "letagents-opencode-contract-secret";
const TURN_TIMEOUT_MS = 30_000;

function resolveBinary() {
  const configured = process.env.LETAGENTS_OPENCODE_BIN?.trim();
  if (configured) return configured;
  const which = spawnSync("which", ["opencode"], { encoding: "utf8" });
  const path = which.status === 0 ? which.stdout.trim() : "";
  if (!path) {
    throw new Error(
      "OpenCode contract smoke requires LETAGENTS_OPENCODE_BIN or opencode on PATH.",
    );
  }
  return path;
}

function verifyVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not execute OpenCode: ${result.stderr || result.stdout}`);
  }
  const actual = result.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "";
  if (actual !== OPENCODE_RUNTIME_VERSION) {
    throw new Error(
      `OpenCode contract smoke expected ${OPENCODE_RUNTIME_VERSION}, got ${actual || "unknown"}.`,
    );
  }
  return actual;
}

async function allocatePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function toolName(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map((tool) => tool?.function?.name).filter(Boolean);
  return names.find((name) => name === "bash")
    ?? names.find((name) => name === "shell")
    ?? null;
}

function writeSse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function assistantText(response, text) {
  writeSse(response, [
    {
      id: `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "contract-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "contract-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
}

function assistantToolCall(response, name, commands = [
  "printf '%s|%s|%s|%s' \"$OPENCODE_AUTH_CONTENT\" \"$OPENCODE_CONFIG_CONTENT\" \"$OPENCODE_SERVER_USERNAME\" \"$OPENCODE_SERVER_PASSWORD\"",
]) {
  writeSse(response, [
    {
      id: `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "contract-model",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: commands.map((command, index) => ({
            index,
            id: `call_contract_${index}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify({ command, description: "Verify runtime boundary" }),
            },
          })),
        },
        finish_reason: null,
      }],
    },
    {
      id: `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "contract-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

async function startFixtureProvider() {
  const state = {
    credentialBoundaryObserved: false,
    requestCount: 0,
    paths: [],
  };
  const server = createServer(async (request, response) => {
    state.paths.push(request.url ?? "");
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    state.requestCount += 1;
    const body = await readJsonBody(request);
    const name = toolName(body);
    const serializedMessages = JSON.stringify(body.messages ?? []);
    const hasToolResult = (body.messages ?? []).some((message) => message?.role === "tool");
    if (serializedMessages.includes("LETAGENTS_PERMISSION_REJECT_FIXTURE")
      || serializedMessages.includes("LETAGENTS_PERMISSION_FOREIGN_FIXTURE")) {
      if (hasToolResult) assistantText(response, "permission-contract-settled");
      else if (name) assistantToolCall(response, name, serializedMessages.includes("LETAGENTS_PERMISSION_REJECT_FIXTURE")
        ? ["printf 'rejected-first'", "printf 'rejected-second'"]
        : ["printf 'foreign-pending'"]);
      else assistantText(response, "contract-background-request-ok");
      return;
    }
    if (hasToolResult) {
      if (serializedMessages.includes(CONTRACT_SENTINEL)) {
        response.writeHead(500).end("provider credential escaped into the model shell");
        return;
      }
      if (!serializedMessages.includes("|||")) {
        response.writeHead(500).end("credential-boundary shell output was not empty");
        return;
      }
      state.credentialBoundaryObserved = true;
      assistantText(response, "credential-boundary-ok");
      return;
    }
    if (name) {
      assistantToolCall(response, name);
      return;
    }
    assistantText(response, "contract-background-request-ok");
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    state,
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function writeNoopMcpServer(path) {
  await writeFile(path, [
    'import { createInterface } from "node:readline";',
    'const input = createInterface({ input: process.stdin });',
    "function send(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id, result })}\\n`); }",
    'input.on("line", (line) => {',
    "  const message = JSON.parse(line);",
    "  if (message.id === undefined) return;",
    '  if (message.method === "initialize") {',
    '    send(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "contract-noop", version: "1" } });',
    '  } else if (message.method === "tools/list") send(message.id, { tools: [] });',
    "  else send(message.id, {});",
    "});",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
}

async function waitForHealth(client, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await client.health()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`OpenCode server did not become healthy: ${output.value}`);
}

async function watchEvents(client, eventTypes) {
  const controller = new AbortController();
  const seen = [];
  const waiting = new Set();
  let ended = false;
  const reading = (async () => {
    try {
      for await (const event of client.events(controller.signal)) {
        parseOpenCodePermissionEvent(event);
        if (typeof event.type === "string") eventTypes.add(event.type);
        seen.push(event);
        for (const wake of waiting) wake();
      }
    } finally {
      ended = true;
      for (const wake of waiting) wake();
    }
  })();
  // Event-reader errors are surfaced by waitFor or close, never unhandled.
  void reading.catch(() => {});
  const watch = {
    seen,
    waitFor(predicate, after = 0) {
      return new Promise((resolveEvent, reject) => {
        const finish = (error, event) => {
          clearTimeout(timer);
          waiting.delete(check);
          if (error) reject(error); else resolveEvent(event);
        };
        const check = () => {
          const event = seen.slice(after).find(predicate);
          if (event) finish(null, event);
          else if (ended) finish(new Error("OpenCode contract event stream ended before its evidence arrived."));
        };
        const timer = setTimeout(() => finish(new Error("OpenCode contract event evidence timed out.")), TURN_TIMEOUT_MS);
        waiting.add(check);
        check();
      });
    },
    async close() {
      controller.abort();
      await reading.catch((error) => { if (error?.name !== "AbortError") throw error; });
    },
  };
  try {
    await watch.waitFor((event) => event.type === "server.connected");
    return watch;
  } catch (error) {
    await watch.close().catch(() => {});
    throw error;
  }
}

const binary = resolveBinary();
const actualVersion = verifyVersion(binary);
const provider = await startFixtureProvider();
const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-contract-"));
const pluginPath = join(runtimeRoot, "credential-boundary.mjs");
const mcpPath = join(runtimeRoot, "noop-mcp.mjs");
await mkdir(join(runtimeRoot, "worktree"), { recursive: true });
await writeFile(pluginPath, credentialBoundaryPluginSource(), { encoding: "utf8", mode: 0o600 });
await writeNoopMcpServer(mcpPath);
const port = await allocatePort();
const auth = {
  username: OPENCODE_SERVER_USERNAME,
  password: randomBytes(24).toString("base64url"),
};
const config = openCodeConfig({
  model: "contract-model",
  baseUrl: provider.url,
  pluginUrl: pathToFileURL(pluginPath).href,
  cwd: join(runtimeRoot, "worktree"),
  mcpCommand: [process.execPath, mcpPath],
  mcpEnvironment: {},
  permissionProfileId: "ask_before_write",
});
const environment = minimalOpenCodeEnvironment(process.env, {
  OPENCODE_SERVER_USERNAME: auth.username,
  OPENCODE_SERVER_PASSWORD: auth.password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_AUTH_CONTENT: openCodeAuthContent(CONTRACT_SENTINEL),
  XDG_DATA_HOME: join(runtimeRoot, "data"),
  XDG_CACHE_HOME: join(runtimeRoot, "cache"),
  XDG_CONFIG_HOME: join(runtimeRoot, "config"),
  XDG_STATE_HOME: join(runtimeRoot, "state"),
});
const output = { value: "" };
const child = spawn(binary, [
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: join(runtimeRoot, "worktree"),
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output.value += chunk; });
child.stderr.on("data", (chunk) => { output.value += chunk; });
let observation;

try {
  let permissionReplyPosts = 0;
  const nativeFetch = (input, init) => {
    if (init?.method === "POST" && /\/permission\/[^/]+\/reply$/.test(new URL(input).pathname)) permissionReplyPosts += 1;
    return fetch(input, init);
  };
  const client = new OpenCodeServerClient(
    `http://127.0.0.1:${port}`,
    auth,
    nativeFetch,
  );
  await waitForHealth(client, child, output);
  assert.deepEqual((await client.config()).permission, {
    "*": "allow",
    edit: "ask",
    bash: "ask",
  }, "the pinned runtime must retain the supervised ask-before-write policy");
  const initial = await client.createSession("LetAgents live contract");
  const sessionId = typeof initial.id === "string" ? initial.id : "";
  if (!sessionId) throw new Error("OpenCode live contract did not create a session.");
  const eventTypes = new Set();
  observation = await watchEvents(client, eventTypes);
  // The adapter dispatches user message IDs in OpenCode's own ascending
  // scheme; anything else breaks the native loop-exit ordering invariant.
  // The contract smoke must prove that exact discipline round-trips.
  const messageId = mintNativeUserMessageId(Date.now());
  await client.promptAsync(sessionId, {
    messageID: messageId,
    model: {
      providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID,
      modelID: "contract-model",
    },
    parts: [{
      type: "text",
      text: "Use the shell tool exactly once, then report its output.",
    }],
  });
  const asked = await observation.waitFor((event) => event.type === "permission.asked"
    && event.properties.sessionID === sessionId);
  const pending = await client.listPendingPermissions(sessionId);
  assert.deepEqual(pending, [asked.properties], "native ask must match the authoritative exact-session list");
  assert.equal(pending[0].permission, "bash");
  assert.deepEqual(await client.correlatePermissionTurn(sessionId, pending[0]), {
    outcome: "correlated", requestId: pending[0].id, providerContinuationId: sessionId,
    providerTurnId: messageId, assistantMessageId: pending[0].tool.messageID, callId: pending[0].tool.callID,
  }, "native permission must resolve through its exact assistant and tool call to the dispatched user turn");
  assert.deepEqual(await client.correlatePermissionTurn(sessionId, {
    ...pending[0], tool: { ...pending[0].tool, messageID: mintNativeUserMessageId(Date.now()) },
  }), { outcome: "correlation_unproven" }, "missing exact message is not continuation loss");
  assert.ok((await client.listSessions()).some((session) => session.id === sessionId));
  await observation.close();

  // Reconnect the event channel and reconstruct the client while the same
  // native request remains pending; do not replay its model prompt.
  let reattached = new OpenCodeServerClient(`http://127.0.0.1:${port}`, auth, nativeFetch);
  observation = await watchEvents(reattached, eventTypes);
  assert.deepEqual(await reattached.listPendingPermissions(sessionId), pending);
  assert.deepEqual(await reattached.replyPermission(sessionId, pending[0], "once"), { outcome: "processed", nativeScope: "request" });
  await observation.waitFor((event) => event.type === "permission.replied"
    && event.properties.requestID === pending[0].id && event.properties.reply === "once");
  await observation.waitFor((event) => eventReferencesSession(event, sessionId)
    && (event.type === "session.idle" || event.type === "session.error"));
  const messages = await client.messages(sessionId);
  if (!JSON.stringify(messages).includes("credential-boundary-ok")) {
    throw new Error(`OpenCode did not preserve the bounded-turn result: ${JSON.stringify(messages)}`);
  }
  if (!provider.state.credentialBoundaryObserved) {
    throw new Error("The live model-run shell credential boundary was not observed.");
  }
  assert.equal(permissionReplyPosts, 1);
  await observation.close();
  reattached = new OpenCodeServerClient(`http://127.0.0.1:${port}`, auth, nativeFetch);
  observation = await watchEvents(reattached, eventTypes);
  assert.deepEqual(await reattached.listPendingPermissions(sessionId), [], "a processed request must remain absent after reconnect");
  await assert.rejects(reattached.replyPermission(sessionId, pending[0], "once"), (error) => error?.outcome === "not_pending");
  assert.equal(permissionReplyPosts, 1, "a repeated processed request must be refused before another native POST");

  // Reconstructing the authenticated client models desktop/daemon restart:
  // the process and session stay authoritative without another native launch.
  const sessions = await reattached.listSessions();
  if (!sessions.some((session) => session.id === sessionId)) {
    throw new Error("A fresh control client could not reattach to the exact session.");
  }
  await reattached.abort(sessionId);
  const replacement = await reattached.createSession("LetAgents same-process repair");
  const replacementSessionId = typeof replacement.id === "string" ? replacement.id : "";
  if (!replacementSessionId || replacementSessionId === sessionId) {
    throw new Error("Same-process continuation repair did not create a distinct session.");
  }
  const foreignSession = await reattached.createSession("LetAgents pending permission isolation");
  assert.equal(typeof foreignSession.id, "string");
  const permissionTurnsStart = observation.seen.length;
  for (const [target, text] of [[replacementSessionId, "LETAGENTS_PERMISSION_REJECT_FIXTURE"],
    [foreignSession.id, "LETAGENTS_PERMISSION_FOREIGN_FIXTURE"]]) {
    await reattached.promptAsync(target, {
      messageID: mintNativeUserMessageId(Date.now()),
      model: { providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID, modelID: "contract-model" },
      parts: [{ type: "text", text }],
    });
  }
  for (const command of ["printf 'rejected-first'", "printf 'rejected-second'", "printf 'foreign-pending'"]) {
    await observation.waitFor((event) => event.type === "permission.asked" && event.properties.metadata.command === command);
  }
  const rejected = await reattached.listPendingPermissions(replacementSessionId);
  const foreign = await reattached.listPendingPermissions(foreignSession.id);
  assert.equal(rejected.length, 2, "the native session must have two simultaneous pending requests");
  assert.equal(foreign.length, 1);
  assert.deepEqual(await reattached.replyPermission(replacementSessionId, rejected[0], "reject"), {
    outcome: "processed", nativeScope: "session_pending",
  });
  for (const request of rejected) await observation.waitFor((event) => event.type === "permission.replied"
    && event.properties.requestID === request.id && event.properties.reply === "reject");
  assert.deepEqual(await reattached.listPendingPermissions(replacementSessionId), []);
  assert.deepEqual(await reattached.listPendingPermissions(foreignSession.id), foreign, "reject must not affect another session");
  await observation.waitFor((event) => event.type === "session.idle" && eventReferencesSession(event, replacementSessionId), permissionTurnsStart);
  const rejectedTools = (await reattached.messages(replacementSessionId)).flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "tool" && part.tool === "bash");
  assert.equal(rejectedTools.length, 2);
  assert.ok(rejectedTools.every((part) => part.state?.status === "error"), "neither rejected command may complete execution");

  // Native pending requests are instance-local, not durable session history.
  // Dispose the instance while the foreign request is pending, without exiting
  // the server PID, then prove that a new control instance cannot recover it.
  const disposed = await fetch(`${reattached.url}/instance/dispose`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  assert.equal(disposed.ok, true);
  assert.equal(await disposed.json(), true);
  await observation.waitFor((event) => event.type === "server.instance.disposed");
  await observation.close();
  assert.equal(child.exitCode, null, "instance loss is distinct from process death");
  assert.deepEqual(await reattached.listPendingPermissions(foreignSession.id), []);
  await assert.rejects(reattached.replyPermission(foreignSession.id, foreign[0], "once"),
    (error) => error?.outcome === "not_pending");
  await assert.rejects(reattached.replyPermission(sessionId, pending[0], "once"),
    (error) => error?.outcome === "not_pending");
  assert.equal(permissionReplyPosts, 2, "disposal must not permit re-dispatch of lost or previously processed requests");
  console.log(JSON.stringify({
    runtime: "opencode",
    version: actualVersion,
    pid: child.pid,
    sessionId,
    replacementSessionId,
    messageId,
    credentialBoundaryObserved: true,
    reattachedWithoutRelaunch: true,
    nativeAbortAccepted: true,
    sameProcessRepair: true,
    permissionAskAndExactList: true,
    permissionEditAndShellPolicy: true,
    permissionExactUserTurnCorrelation: true,
    permissionMissingMessageIsNotSessionLoss: true,
    permissionReconnectWithoutReplay: true,
    permissionAllowOnce: true,
    permissionProcessedReplayRefused: true,
    permissionRejectScope: "all_pending_in_same_session",
    permissionForeignSessionPreserved: true,
    permissionInstanceDisposalLoss: true,
    eventTypes: [...eventTypes].sort(),
    providerRequests: provider.state.requestCount,
    providerPaths: provider.state.paths,
  }));
} finally {
  await observation?.close().catch(() => {});
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await provider.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}
