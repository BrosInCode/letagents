import { spawn, spawnSync } from "node:child_process";
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
const { OpenCodeServerClient, eventReferencesSession, mintNativeUserMessageId } = await import(
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

function assistantToolCall(response, name) {
  const command = "printf '%s|%s|%s|%s' \"$OPENCODE_AUTH_CONTENT\" \"$OPENCODE_CONFIG_CONTENT\" \"$OPENCODE_SERVER_USERNAME\" \"$OPENCODE_SERVER_PASSWORD\"";
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
          tool_calls: [{
            index: 0,
            id: "call_credential_boundary",
            type: "function",
            function: {
              name,
              arguments: JSON.stringify({ command, description: "Verify runtime boundary" }),
            },
          }],
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

async function waitForTurn(client, sessionId, signal, eventTypes) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const events = client.events(signal)[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    let timeout;
    const next = await Promise.race([
      events.next(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OpenCode live contract turn timed out.")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (next.done) break;
    const event = next.value;
    if (typeof event.type === "string") eventTypes.add(event.type);
    if (eventReferencesSession(event, sessionId)
      && (event.type === "session.idle" || event.type === "session.error")) {
      return;
    }
  }
  throw new Error("OpenCode live contract event stream ended before the turn.");
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

try {
  const client = new OpenCodeServerClient(
    `http://127.0.0.1:${port}`,
    auth,
    (input, init) => fetch(input, init),
  );
  await waitForHealth(client, child, output);
  const initial = await client.createSession("LetAgents live contract");
  const sessionId = typeof initial.id === "string" ? initial.id : "";
  if (!sessionId) throw new Error("OpenCode live contract did not create a session.");
  const eventTypes = new Set();
  const controller = new AbortController();
  const turn = waitForTurn(client, sessionId, controller.signal, eventTypes);
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
  await turn.finally(() => controller.abort());
  const messages = await client.messages(sessionId);
  if (!JSON.stringify(messages).includes("credential-boundary-ok")) {
    throw new Error(`OpenCode did not preserve the bounded-turn result: ${JSON.stringify(messages)}`);
  }
  if (!provider.state.credentialBoundaryObserved) {
    throw new Error("The live model-run shell credential boundary was not observed.");
  }

  // Reconstructing the authenticated client models desktop/daemon restart:
  // the process and session stay authoritative without another native launch.
  const reattached = new OpenCodeServerClient(
    `http://127.0.0.1:${port}`,
    auth,
    (input, init) => fetch(input, init),
  );
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
    eventTypes: [...eventTypes].sort(),
    providerRequests: provider.state.requestCount,
    providerPaths: provider.state.paths,
  }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await provider.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}
