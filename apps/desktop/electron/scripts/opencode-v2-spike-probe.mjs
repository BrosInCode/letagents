// Probe behind docs/plans/opencode-v2-spike.md. It drives `opencode serve`
// (OpenCode 2.x) against a loopback OpenAI-compatible provider and a loopback
// npm registry, and prints one JSON report. Nothing leaves the machine.
//
// Usage:
//   node opencode-v2-spike-probe.mjs <opencode binary> <scenario>
//
// Scenarios:
//   plain    one text answer
//   tool     one shell tool call that prints three secret-bearing variables
//   plugin   `tool`, with the 1.x credential-boundary plugin configured
//   unknown  an answer whose stream has no finish_reason
//   retry    HTTP 429 on every model request
//   credit   HTTP 402 whose message contains "1500"
//   paths    no turn; asks the server for 1.x paths, with and without credentials
//
// Switches (environment variables):
//   SPIKE_ENV=1            replace the session environment before the turn
//   SPIKE_ASK=once|reject  ask before shell commands and reply
//   SPIKE_MCP=1            configure a local MCP server in the 1.x shape
//   SPIKE_MCP=native       configure it in the 2.x shape with codemode off
//   SPIKE_MCP_WARM=1       wait for the MCP server to connect before the first turn
//   SPIKE_SETTLE_MS=<ms>   pause before each turn (default 0); MCP tools reach a
//                          session about 100 ms after the server connects
//   SPIKE_TURNS=<n>        run n turns on the session (default 1)
//   SPIKE_ID=<message id>  supply the first user message ID
//   SPIKE_CONNECT_KEY=1    supply the provider key through the connect API
//   SPIKE_NO_KEY=1         supply the key only through OPENCODE_AUTH_CONTENT, as 1.x expects
//   SPIKE_PRIVATE_HOME=1   give the server an empty private HOME
//   SPIKE_UNTIL_END=1      wait up to 120 s for the turn to end by itself
//   SPIKE_POLL_MS=<ms>     status polling interval (default 25)
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SCENARIOS = ["plain", "tool", "plugin", "unknown", "retry", "credit", "paths"];
const PROVIDER_KEY = "spike-provider-key-7d1f";
const SERVER_PASSWORD = "spike-server-password";
const SECRET_PRINTING_COMMAND =
  "printf '%s|%s|%s' \"$OPENCODE_CONFIG_CONTENT\" \"$OPENCODE_SERVER_PASSWORD\" \"$OPENCODE_PASSWORD\"";

const [binary, scenario = "plain"] = process.argv.slice(2);
if (!binary || !SCENARIOS.includes(scenario)) {
  console.error(`Usage: node opencode-v2-spike-probe.mjs <opencode binary> <${SCENARIOS.join("|")}>`);
  process.exit(2);
}

const started = Date.now();
const pollMs = Number(process.env.SPIKE_POLL_MS || 25);
const turns = Number(process.env.SPIKE_TURNS || 1);
const cleanups = [];
let cleaning = null;
// Every caller waits for the same run, so a signal that arrives while the
// main flow is failing cannot let the process exit before the run finishes.
function cleanup() {
  cleaning ??= (async () => {
    for (const step of cleanups.reverse()) await step().catch(() => undefined);
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

function chunk(delta, finishReason) {
  return {
    id: `chatcmpl_${randomUUID()}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function main() {
  const report = { scenario, switches: {}, version: null };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPIKE_")) report.switches[key] = value;
  }

  const modelRequests = [];
  const provider = createHttpServer((request, response) => {
    const buffers = [];
    request.on("data", (buffer) => buffers.push(buffer));
    request.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(buffers).toString("utf8") || "{}"); } catch {}
      const tools = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
      const messages = body.messages ?? [];
      const system = messages.filter((message) => message?.role === "system")
        .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
        .join("\n");
      const toolResults = messages.filter((message) => message?.role === "tool")
        .map((message) => String(typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
      modelRequests.push({
        atMs: Date.now() - started,
        path: request.url,
        authorization: request.headers.authorization ?? null,
        maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
        toolChoice: body.tool_choice ?? null,
        tools,
        systemPromptLength: system.length,
        skillsInSystemPrompt: [...system.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1]),
        toolResults: toolResults.map((result) => result.includes(PROVIDER_KEY)
          ? "<contains the provider key>"
          : result.slice(0, 120)),
        toolResultsContainProviderKey: toolResults.some((result) => result.includes(PROVIDER_KEY)),
        toolResultsContainServerPassword: toolResults.some((result) => result.includes(SERVER_PASSWORD)),
        // In Code Mode an MCP tool is named in the request's text, for the
        // `execute` tool to call, rather than listed as a tool of its own.
        mcpToolInCodeModeCatalog: JSON.stringify(body).includes("tools.letagents.spike_echo"),
      });
      if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
      if (tools.length === 0) {
        sse(response, [chunk({ role: "assistant", content: "title" }, null), chunk({}, "stop")]);
        return;
      }
      if (scenario === "credit") {
        response.writeHead(402, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: {
          message: "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 1500.",
          code: 402,
        } }));
        return;
      }
      if (scenario === "retry") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }));
        return;
      }
      if (scenario === "unknown") {
        sse(response, [chunk({ role: "assistant", content: "unknown-finish-answer" }, null)]);
        return;
      }
      if ((scenario === "tool" || scenario === "plugin") && toolResults.length === 0) {
        const name = tools.find((tool) => /^(bash|shell)$/.test(tool)) ?? tools[0];
        sse(response, [
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: {
            name,
            arguments: JSON.stringify({ command: SECRET_PRINTING_COMMAND, description: "probe" }),
          } }] }, null),
          chunk({}, "tool_calls"),
        ]);
        return;
      }
      sse(response, [chunk({ role: "assistant", content: "plain-answer" }, null), chunk({}, "stop")]);
    });
  });
  const providerPort = await listen(provider);
  cleanups.push(() => close(provider));

  const registryRequests = [];
  const registry = createHttpServer((request, response) => {
    registryRequests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
  });
  const registryPort = await listen(registry);
  cleanups.push(() => close(registry));

  // The server resolves its working directory, so the session location must
  // use the resolved path or location-scoped lists describe another place.
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-v2-spike-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree");
  await mkdir(cwd, { recursive: true });
  const privateHome = join(root, "home");
  await mkdir(privateHome, { recursive: true });

  const pluginPath = join(root, "credential-boundary.mjs");
  await writeFile(pluginPath, [
    "export default async () => ({",
    '  "shell.env": (_input, output) => {',
    '    output.env.OPENCODE_CONFIG_CONTENT = "";',
    '    output.env.OPENCODE_SERVER_PASSWORD = "";',
    '    output.env.OPENCODE_PASSWORD = "";',
    "  },",
    "});",
    "",
  ].join("\n"));
  const mcpPath = join(root, "echo-mcp.mjs");
  await writeFile(mcpPath, [
    'import { createInterface } from "node:readline";',
    'const input = createInterface({ input: process.stdin });',
    "function send(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id, result })}\\n`); }",
    'input.on("line", (line) => {',
    "  const message = JSON.parse(line);",
    "  if (message.id === undefined) return;",
    '  if (message.method === "initialize") send(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "spike", version: "1" } });',
    '  else if (message.method === "tools/list") send(message.id, { tools: [{ name: "spike_echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] });',
    "  else send(message.id, {});",
    "});",
    "",
  ].join("\n"));

  const useConnectApi = Boolean(process.env.SPIKE_CONNECT_KEY);
  const mcpServer = { type: "local", command: [process.execPath, mcpPath], cwd, environment: { SPIKE: "1" }, enabled: true };
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    formatter: false,
    lsp: false,
    model: "letagents-open-model/m",
    ...(scenario === "plugin" ? { plugin: [pathToFileURL(pluginPath).href] } : {}),
    ...(process.env.SPIKE_MCP === "native"
      ? { mcp: { servers: { letagents: {
        type: "local", command: mcpServer.command, environment: mcpServer.environment, codemode: false,
      } } } }
      : process.env.SPIKE_MCP ? { mcp: { letagents: mcpServer } } : {}),
    permission: process.env.SPIKE_ASK ? { "*": "allow", bash: "ask", shell: "ask" } : { "*": "allow" },
    provider: { "letagents-open-model": {
      id: "letagents-open-model",
      name: "LetAgents Open Model",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: {
        baseURL: `http://127.0.0.1:${providerPort}/v1`,
        ...(useConnectApi || process.env.SPIKE_NO_KEY ? {} : { apiKey: PROVIDER_KEY }),
      },
      models: { m: {
        id: "m", name: "m", attachment: true, reasoning: true, temperature: true, tool_call: true,
        release_date: "2025-01-01", limit: { context: 1_000_000, output: 8_192 },
        cost: { input: 0, output: 0 }, options: {},
      } },
    } },
  };

  const probe = createNetServer();
  const port = await listen(probe);
  await close(probe);
  const dataHome = join(root, "data");
  const child = spawn(binary, [
    "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "info",
  ], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.SPIKE_PRIVATE_HOME ? privateHome : process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      npm_config_registry: `http://127.0.0.1:${registryPort}/`,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      // 1.x reads the provider key from this variable. It is set so the
      // report can show whether 2.x does.
      OPENCODE_AUTH_CONTENT: JSON.stringify({ "letagents-open-model": { type: "api", key: PROVIDER_KEY } }),
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  let launchError = null;
  child.once("error", (error) => { launchError = error; });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const url = `http://127.0.0.1:${port}`;
  const basic = (password) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const headers = { authorization: basic(SERVER_PASSWORD), "content-type": "application/json" };
  const call = async (method, path, body, options = {}) => {
    const began = Date.now();
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: options.headers ?? headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {
        status: response.status,
        ms: Date.now() - began,
        contentType: response.headers.get("content-type"),
        json,
        text: json === null ? text.slice(0, 120) : undefined,
      };
    } catch (error) {
      return { error: `${error.name}: ${error.message}`, ms: Date.now() - began };
    }
  };

  const launchedAt = Date.now();
  while (Date.now() - launchedAt < 20_000 && child.exitCode === null && !launchError) {
    const info = await call("GET", "/api/info", undefined, { timeoutMs: 2_000 });
    if (info.status === 200) {
      report.version = info.json.version;
      report.healthyAfterMsAtMost = Date.now() - launchedAt;
      break;
    }
    await sleep(10);
  }
  if (report.version === null) {
    throw new Error(launchError
      ? `could not launch ${binary}: ${launchError.message}`
      : `the server did not become healthy: ${log.split("\n").slice(-5).join(" | ")}`);
  }

  if (scenario === "paths") {
    report.paths = {};
    for (const path of ["/global/health", "/session", "/config", "/session/status", "/event", "/no-such-path"]) {
      const withCredentials = await call("GET", path);
      const without = await call("GET", path, undefined, { headers: {} });
      report.paths[`GET ${path}`] = {
        withCredentials: `${withCredentials.status} ${withCredentials.contentType}`,
        withoutCredentials: String(without.status),
      };
    }
    const oldPrompt = await call("POST", "/session", { title: "x" });
    report.paths["POST /session"] = { withCredentials: String(oldPrompt.status) };
    const wrong = await call("GET", "/api/info", undefined, { headers: { authorization: basic("wrong") } });
    report.paths["GET /api/info, wrong password"] = { withCredentials: String(wrong.status) };
    return report;
  }

  const location = `location[directory]=${encodeURIComponent(cwd)}`;
  if (useConnectApi) {
    const integrations = (await call("GET", `/api/integration?${location}`)).json?.data ?? [];
    report.integrationListed = integrations.some((integration) => integration.id === "letagents-open-model");
    const connected = await call(
      "POST",
      `/api/integration/letagents-open-model/connect/key?${location}`,
      { key: PROVIDER_KEY },
    );
    report.connectKey = { status: connected.status, body: connected.json ?? connected.text ?? connected.error };
  }
  const configRead = await call("GET", "/api/config");
  report.configEndpointReturnsProviderKey = JSON.stringify(configRead.json ?? "").includes(PROVIDER_KEY);
  report.pluginsListed = (await call("GET", `/api/plugin?${location}`)).json?.data ?? null;
  if (process.env.SPIKE_MCP) {
    report.mcpBeforeFirstTurn = (await call("GET", `/api/mcp?${location}`)).json?.data ?? null;
    if (process.env.SPIKE_MCP_WARM) {
      const warmingSince = Date.now();
      while (Date.now() - warmingSince < 10_000) {
        const listed = (await call("GET", `/api/mcp?${location}`)).json?.data ?? [];
        if (listed.some((server) => server.status?.status === "connected")) {
          report.mcpConnectedAfterMsAtMost = Date.now() - warmingSince;
          break;
        }
        await sleep(pollMs);
      }
    }
  }

  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  const events = [];
  const stream = await fetch(`${url}/api/event`, {
    headers: { ...headers, accept: "text/event-stream" },
    signal: controller.signal,
  });
  void (async () => {
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim()).join("");
          if (data) {
            try { events.push({ atMs: Date.now() - started, event: JSON.parse(data) }); } catch {}
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } catch {}
  })();

  const created = await call("POST", "/api/session", { title: "spike", location: { directory: cwd } });
  const sessionId = (created.json?.data ?? created.json)?.id;
  report.createSession = { status: created.status, ms: created.ms, sessionId };
  if (!sessionId) throw new Error(`session was not created: ${JSON.stringify(created)}`);

  if (process.env.SPIKE_ENV) {
    const replaced = await call("PUT", `/api/session/${sessionId}/environment`, { variables: {
      OPENCODE_CONFIG_CONTENT: "", OPENCODE_SERVER_PASSWORD: "", OPENCODE_PASSWORD: "", PATH: process.env.PATH,
    } });
    report.environmentPut = replaced.status;
  }

  const active = async () => JSON.stringify((await call("GET", "/api/session/active", undefined, { timeoutMs: 3_000 })).json ?? {});
  report.turns = [];
  for (let turn = 0; turn < turns; turn += 1) {
    await sleep(Number(process.env.SPIKE_SETTLE_MS || 0));
    const requestsBefore = modelRequests.length;
    const eventsBefore = events.length;
    const promptedAt = Date.now();
    const prompted = await call("POST", `/api/session/${sessionId}/prompt`, {
      ...(turn === 0 && process.env.SPIKE_ID ? { id: process.env.SPIKE_ID } : {}),
      text: scenario === "tool" || scenario === "plugin"
        ? "Use the shell tool exactly once, then report its output."
        : "say hello",
    });
    const result = {
      promptStatus: prompted.status,
      userMessageId: prompted.json?.data?.id ?? null,
      promptError: prompted.status === 200 ? undefined : prompted.json ?? prompted.text ?? prompted.error,
    };
    const waitMs = process.env.SPIKE_UNTIL_END ? 120_000 : 9_000;
    while (Date.now() - promptedAt < waitMs) {
      await sleep(pollMs);
      if (process.env.SPIKE_ASK && !result.permission) {
        const pending = (await call("GET", `/api/session/${sessionId}/permission`, undefined, { timeoutMs: 3_000 })).json;
        const list = pending?.data ?? pending ?? [];
        if (Array.isArray(list) && list.length > 0) {
          const globalList = (await call("GET", `/api/permission/request?${location}`)).json;
          const reply = await call("POST", `/api/session/${sessionId}/permission/${list[0].id}/reply`, { decision: process.env.SPIKE_ASK });
          result.permission = {
            action: list[0].action,
            listedGlobally: JSON.stringify(globalList ?? "").includes(list[0].id),
            replyStatus: reply.status,
          };
        }
      }
      const ended = events.slice(eventsBefore).find((entry) =>
        /^session\.execution\.(succeeded|failed|interrupted)$/.test(entry.event?.type ?? "")
        && entry.event?.data?.sessionID === sessionId);
      if (ended) {
        result.endedWith = ended.event.type;
        result.endedAfterMsAtMost = Date.now() - promptedAt;
        break;
      }
    }
    if (!result.endedWith) {
      result.stillActive = (await active()).includes(sessionId);
      result.statusWhileActive = JSON.parse(await active()).data?.[sessionId] ?? null;
      const interrupted = await call("POST", `/api/session/${sessionId}/interrupt`);
      result.interrupt = { status: interrupted.status, body: interrupted.json ?? interrupted.text };
      await sleep(1_000);
      result.activeAfterInterrupt = (await active()).includes(sessionId);
    }
    const requests = modelRequests.slice(requestsBefore).filter((request) => request.tools.length > 0);
    result.modelRequests = requests.length;
    result.modelRequestsAtMs = requests.map((request) => request.atMs - (promptedAt - started));
    result.first = requests[0] ? {
      authorization: requests[0].authorization,
      maxTokens: requests[0].maxTokens,
      toolChoice: requests[0].toolChoice,
      tools: requests[0].tools,
      systemPromptLength: requests[0].systemPromptLength,
      skillsInSystemPrompt: requests[0].skillsInSystemPrompt,
      mcpToolInCodeModeCatalog: requests[0].mcpToolInCodeModeCatalog,
    } : null;
    result.shellOutputSeenByModel = requests.flatMap((request) => request.toolResults);
    result.shellOutputContainsProviderKey = requests.some((request) => request.toolResultsContainProviderKey);
    result.shellOutputContainsServerPassword = requests.some((request) => request.toolResultsContainServerPassword);
    const turnEvents = events.slice(eventsBefore).map((entry) => entry.event);
    result.eventTypes = [...new Set(turnEvents.map((event) => event.type))];
    result.failure = turnEvents.find((event) => event.type === "session.step.failed")?.data?.error ?? null;
    result.retry = turnEvents.find((event) => event.type === "session.retry.scheduled")?.data ?? null;
    report.turns.push(result);
  }

  const transcript = (await call("GET", `/api/session/${sessionId}/message?limit=100`)).json;
  const records = transcript?.data ?? transcript ?? [];
  report.transcriptRecordTypes = Array.isArray(records)
    ? records.reduce((counts, record) => ({ ...counts, [record.type]: (counts[record.type] ?? 0) + 1 }), {})
    : null;
  if (process.env.SPIKE_MCP) {
    report.mcpAfterTurns = (await call("GET", `/api/mcp?${location}`)).json?.data ?? null;
  }
  report.registryRequests = registryRequests;
  report.configDirectory = await readdir(join(root, "config", "opencode")).catch(() => null);

  const dataFiles = await readdir(join(dataHome, "opencode")).catch(() => []);
  report.providerKeyOnDisk = [];
  for (const name of dataFiles) {
    const content = await readFile(join(dataHome, "opencode", name)).catch(() => null);
    if (content?.includes(PROVIDER_KEY)) report.providerKeyOnDisk.push(name);
  }

  const lines = log.split("\n");
  report.log = {
    pluginMessages: [...new Set(lines.filter((line) => /plugin/i.test(line) && /level=(WARN|ERROR)/.test(line))
      .map((line) => line.match(/message="([^"]+)"/)?.[1]).filter(Boolean))],
    droppedSettings: [...new Set(lines.filter((line) => line.includes("configuration normalization diagnostic"))
      .map((line) => line.match(/path=(\S+)/)?.[1]).filter(Boolean))],
    watchersOutsideTheRuntime: [...new Set(lines.filter((line) => /message="watcher (started|subscribe)"/.test(line))
      .map((line) => `${line.match(/path=(\S+)/)?.[1]} ${line.match(/type=(\S+)/)?.[1] ?? ""}`.trim())
      .filter((entry) => !entry.startsWith(root) && !entry.startsWith(root.replace(/^\/private/, ""))))],
  };
  return report;
}

let exitCode = 0;
try {
  console.log(JSON.stringify(await main(), null, 1));
} catch (error) {
  exitCode = 1;
  console.error(`probe failed: ${error.message}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
