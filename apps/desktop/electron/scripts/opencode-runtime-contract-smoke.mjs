import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  seedOpenCodeConfigHome,
  shieldOwnerInstructions,
  workspaceOpenCodeEnvironment,
} = await import("../../dist-electron/main/agents/opencode-launch-contract.js");
const { OPENCODE_RUNTIME_VERSION } = await import(
  "../../dist-electron/main/agents/opencode-runtime.js"
);
const { OpenCodeServerClient, eventReferencesSession, mintNativeUserMessageId, parseOpenCodePermissionEvent } = await import(
  "../../dist-electron/main/agents/opencode-server-client.js"
);
// The daemon gives every room's scratch workspace its own repository with this.
const { ensureScratchWorkspaceRepository } = await import("../../../../shared/scratch-workspace-repository.mjs");

const CONTRACT_SENTINEL = "letagents-opencode-contract-secret";
const OWNER_INSTRUCTIONS_SENTINEL = "letagents-owner-instructions-sentinel";
const PROJECT_INSTRUCTIONS_SENTINEL = "letagents-project-instructions-sentinel";
const HOME_DIRECTORY_INSTRUCTIONS_SENTINEL = "letagents-home-directory-instructions-sentinel";
const HOME_DIRECTORY_CONFIG_SENTINEL = "letagents-home-directory-config-sentinel";
const ANCESTOR_AGENT_SENTINEL = "letagents-ancestor-agent-sentinel";
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

// Some OpenAI-compatible endpoints end a complete answer without a standard
// finish_reason, which OpenCode records as an "unknown" finish.
function assistantTextWithoutFinishReason(response, text) {
  writeSse(response, [{
    id: `chatcmpl_${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "contract-model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  }]);
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
              // A fixture may give the whole tool input, to set a working directory.
              arguments: JSON.stringify(typeof command === "string"
                ? { command, description: "Verify runtime boundary" }
                : command),
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
    unknownFinishRequests: 0,
    retriedRequests: 0,
    isolationSystemPrompts: [],
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
    if (serializedMessages.includes("LETAGENTS_ISOLATION_FIXTURE")) {
      // Only the agent turn carries tools, and with them the system prompt
      // that lists instructions and skills.
      if (name) {
        state.isolationSystemPrompts.push((body.messages ?? [])
          .filter((message) => message?.role === "system")
          .map((message) => typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content))
          .join("\n"));
      }
      assistantText(response, name ? "isolation-ok" : "contract-background-request-ok");
      return;
    }
    if (serializedMessages.includes("LETAGENTS_RETRY_FIXTURE")) {
      if (name) {
        state.retriedRequests += 1;
        response.writeHead(429, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }));
      } else assistantText(response, "contract-background-request-ok");
      return;
    }
    if (serializedMessages.includes("LETAGENTS_UNKNOWN_FINISH_FIXTURE")) {
      // Only the agent turn carries tools; OpenCode's background title
      // request for the same prompt gets an ordinary answer.
      if (name) {
        state.unknownFinishRequests += 1;
        assistantTextWithoutFinishReason(response, "unknown-finish-ok");
      } else assistantText(response, "contract-background-request-ok");
      return;
    }
    const outsideProject = /LETAGENTS_OUTSIDE_PROJECT_FIXTURE:(workdir|path|leave|sibling)/.exec(serializedMessages)?.[1];
    if (outsideProject || serializedMessages.includes("LETAGENTS_INSIDE_PROJECT_FIXTURE")) {
      if (hasToolResult) assistantText(response, "project-boundary-settled");
      else if (name) assistantToolCall(response, name, [
        outsideProject === "workdir" ? { command: "ls", workdir: tmpdir(), description: "List another directory" }
          : outsideProject === "path" ? "cat /etc/hosts"
            : outsideProject === "leave" ? "cd .. && ls"
              : outsideProject === "sibling" ? "cat ../sibling/notes.txt"
                : "ls",
      ]);
      else assistantText(response, "contract-background-request-ok");
      return;
    }
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

// Stands in for the npm registry. Every request is evidence that OpenCode
// tried to install a package during a supervised launch.
async function startFixtureRegistry() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    requests,
    url: `http://127.0.0.1:${port}/`,
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

// OpenCode installs its plugin SDK into a project's .opencode directory
// too. This marks one provisioned, as the seed marks the runtime's own.
async function markOpenCodeDirectoryProvisioned(directory) {
  const dependencies = { "@opencode-ai/plugin": OPENCODE_RUNTIME_VERSION };
  await mkdir(join(directory, "node_modules"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies }));
  await writeFile(join(directory, "package-lock.json"), JSON.stringify({
    name: "opencode",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { dependencies } },
  }));
}

function skillFile(name) {
  return `---\nname: ${name}\ndescription: Planted by the contract smoke.\n---\n\nNothing to do.\n`;
}

// A second launch, from a planted home directory and project, shows what of
// the owner's reaches the model. The first launch keeps the real home
// directory so that it sees this machine as production would.
async function observeOwnerIsolation({ binary, provider, registry, runtimeRoot, mcpPath, pluginPath, workspaceKind }) {
  const scratch = workspaceKind === "room_scratch";
  const label = scratch ? "scratch" : "isolation";
  const home = join(runtimeRoot, `${label}-home`);
  // A room's scratch workspace lies under the owner's home directory and is
  // the root of its own repository, as the daemon provisions it.
  const project = scratch
    ? join(home, ".letagents", "worktrees", "room-only", randomUUID())
    : join(runtimeRoot, "isolation-project");
  const planted = scratch ? [
    [join(home, "AGENTS.md"), `${HOME_DIRECTORY_INSTRUCTIONS_SENTINEL}\n`],
    [join(home, "opencode.json"), JSON.stringify({
      instructions: [join(home, "owner-notes.md")],
      plugins: [pathToFileURL(join(home, "named-plugin.js")).href],
    })],
    [join(home, "named-plugin.js"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(join(runtimeRoot, "scratch-named-plugin-ran"))}, "ran");`,
      "export default { id: \"letagents-contract-named\", setup: async () => {} };",
      "",
    ].join("\n")],
    [join(home, "owner-notes.md"), `${HOME_DIRECTORY_CONFIG_SENTINEL}\n`],
    [join(project, "notes.txt"), "A scratch workspace starts with no project files.\n"],
    // An OpenCode directory between the workspace and the home directory.
    // OpenCode would replace the agent's prompt with its agent definition
    // and install packages into it. Without the workspace's repository it
    // imports the plugin whatever the launch sets.
    [join(home, ".letagents", ".opencode", "plugin", "planted.js"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(join(runtimeRoot, "scratch-plugin-ran"))}, "ran");`,
      "export const Planted = async () => ({});",
      "",
    ].join("\n")],
    // The directory that holds every room's workspace, in the current format.
    [join(home, ".letagents", "worktrees", "room-only", ".opencode", "plugin", "planted.js"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(join(runtimeRoot, "scratch-room-only-plugin-ran"))}, "ran");`,
      'export default { id: "letagents-contract-room-only", setup: async () => {} };',
      "",
    ].join("\n")],
    // Positive control: a plugin in the workspace's own .opencode directory
    // is inside the project and is imported, which shows that plugins were
    // loaded at all before the ones above are reported absent. It is also a
    // gap that stays open.
    [join(project, ".opencode", "plugin", "own.js"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(join(runtimeRoot, "scratch-own-plugin-ran"))}, "ran");`,
      'export default { id: "letagents-contract-own", setup: async () => {} };',
      "",
    ].join("\n")],
    [join(home, ".letagents", ".opencode", "agent", "build.md"),
      `---\ndescription: Planted by the contract smoke.\nmode: primary\n---\n\n${ANCESTOR_AGENT_SENTINEL}\n`],
  ] : [
    [join(home, ".claude", "CLAUDE.md"), `${OWNER_INSTRUCTIONS_SENTINEL}\n`],
    [join(home, ".claude", "skills", "owner-claude-skill", "SKILL.md"), skillFile("owner-claude-skill")],
    [join(home, ".agents", "skills", "owner-agents-skill", "SKILL.md"), skillFile("owner-agents-skill")],
    [join(project, "CLAUDE.md"), `${PROJECT_INSTRUCTIONS_SENTINEL}\n`],
    [join(project, ".claude", "skills", "project-claude-skill", "SKILL.md"), skillFile("project-claude-skill")],
    [join(project, ".opencode", "skills", "project-opencode-skill", "SKILL.md"), skillFile("project-opencode-skill")],
  ];
  for (const [path, content] of planted) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf8" });
  }
  if (scratch) {
    assert.equal(await ensureScratchWorkspaceRepository(project), "created");
    await markOpenCodeDirectoryProvisioned(join(project, ".opencode"));
  } else {
    // Room agents work in Git worktrees, where OpenCode's search for project
    // instruction files stops at the repository root. Without a repository it
    // climbs to the file system root and picks up whatever lies on the way.
    // Git's own variables would put the repository somewhere else.
    const gitEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const initialized = spawnSync("git", ["init", "--quiet", project], {
      encoding: "utf8",
      env: gitEnvironment,
    });
    assert.equal(initialized.status, 0, `git init failed: ${initialized.error ?? initialized.stderr}`);
    assert.deepEqual(
      (await readdir(project)).filter((name) => name === ".git"),
      [".git"],
      "the planted project must be a Git repository",
    );
    await markOpenCodeDirectoryProvisioned(join(project, ".opencode"));
  }
  const auth = { username: OPENCODE_SERVER_USERNAME, password: randomBytes(24).toString("base64url") };
  const port = await allocatePort();
  const configHome = join(runtimeRoot, `${label}-config`);
  await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION);
  await shieldOwnerInstructions(configHome);
  const environment = minimalOpenCodeEnvironment({ ...process.env, HOME: home }, {
    npm_config_registry: registry.url,
    OPENCODE_SERVER_USERNAME: auth.username,
    OPENCODE_SERVER_PASSWORD: auth.password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig({
      model: "contract-model",
      baseUrl: provider.url,
      pluginUrl: pathToFileURL(pluginPath).href,
      cwd: project,
      mcpCommand: [process.execPath, mcpPath],
      mcpEnvironment: {},
      permissionProfileId: "ask_before_write",
    })),
    OPENCODE_AUTH_CONTENT: openCodeAuthContent(CONTRACT_SENTINEL),
    XDG_DATA_HOME: join(runtimeRoot, `${label}-data`),
    XDG_CACHE_HOME: join(runtimeRoot, "cache"),
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: join(runtimeRoot, `${label}-state`),
    ...workspaceOpenCodeEnvironment(workspaceKind),
  });
  const output = { value: "" };
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  let observation;
  try {
    const client = new OpenCodeServerClient(`http://127.0.0.1:${port}`, auth, fetch);
    await waitForHealth(client, child, output);
    const session = await client.createSession("LetAgents owner isolation");
    assert.equal(typeof session.id, "string");
    observation = await watchEvents(client, new Set());
    await client.promptAsync(session.id, {
      messageID: mintNativeUserMessageId(Date.now()),
      model: { providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID, modelID: "contract-model" },
      parts: [{ type: "text", text: "LETAGENTS_ISOLATION_FIXTURE" }],
    });
    await observation.waitFor((event) => event.type === "session.idle"
      && eventReferencesSession(event, session.id));
    const systemPrompt = provider.state.isolationSystemPrompts.pop();
    assert.equal(typeof systemPrompt, "string");
    assert.equal(provider.state.isolationSystemPrompts.length, 0);
    // OpenCode names its working directory in the prompt, which ties the
    // prompt to this launch and no other.
    assert.ok(
      systemPrompt.includes(`Working directory: ${await realpath(project)}`)
        || systemPrompt.includes(`Working directory: ${project}`),
      "the captured system prompt must be this workspace's",
    );
    return systemPrompt;
  } finally {
    await observation?.close().catch(() => {});
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/**
 * The Auto access level reviews commands by their text, and that text says
 * nothing a review could trust about a place outside the project. The pinned
 * runtime must therefore refuse such a command itself, before any request
 * for permission exists, and must still ask about a command inside it. A
 * room's scratch workspace is launched differently from a Git worktree, so
 * both kinds are launched. Each has a sibling directory, which is outside
 * its project: a repository above a scratch workspace would bring every
 * other room's workspace inside it.
 */
async function verifyAutoStaysInProject(binary, provider, registry, workspaceKind) {
  // OpenCode compares against the real path, as production workspaces are given.
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-opencode-auto-")));
  const pluginPath = join(root, "credential-boundary.mjs");
  const mcpPath = join(root, "noop-mcp.mjs");
  // A scratch workspace sits beside other rooms' workspaces, as in production.
  const parent = workspaceKind === "room_scratch" ? join(root, "worktrees", "room-only") : root;
  const worktree = join(parent, workspaceKind === "room_scratch" ? randomUUID() : "worktree");
  await mkdir(worktree, { recursive: true });
  await mkdir(join(parent, "sibling"), { recursive: true });
  await writeFile(join(parent, "sibling", "notes.txt"), "Another room's workspace.\n");
  if (workspaceKind === "room_scratch") {
    assert.equal(await ensureScratchWorkspaceRepository(worktree), "created");
  } else {
    const initialized = spawnSync("git", ["init", "--quiet", worktree], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    });
    assert.equal(initialized.status, 0, `git init failed: ${initialized.error ?? initialized.stderr}`);
  }
  await writeFile(pluginPath, credentialBoundaryPluginSource(), { encoding: "utf8", mode: 0o600 });
  await writeNoopMcpServer(mcpPath);
  const port = await allocatePort();
  const auth = { username: OPENCODE_SERVER_USERNAME, password: randomBytes(24).toString("base64url") };
  const configHome = join(root, "config");
  await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION);
  await shieldOwnerInstructions(configHome);
  const output = { value: "" };
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: worktree,
    env: minimalOpenCodeEnvironment(process.env, {
      npm_config_registry: registry.url,
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig({
        model: "contract-model",
        baseUrl: provider.url,
        pluginUrl: pathToFileURL(pluginPath).href,
        cwd: worktree,
        mcpCommand: [process.execPath, mcpPath],
        mcpEnvironment: {},
        permissionProfileId: "auto_review",
      })),
      OPENCODE_AUTH_CONTENT: openCodeAuthContent(CONTRACT_SENTINEL),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(root, "state"),
      ...workspaceOpenCodeEnvironment(workspaceKind),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  let observation;
  try {
    const client = new OpenCodeServerClient(`http://127.0.0.1:${port}`, auth, fetch);
    await waitForHealth(client, child, output);
    assert.deepEqual((await client.config()).permission, {
      "*": "allow",
      edit: "ask",
      bash: "ask",
      external_directory: "deny",
    }, "the pinned runtime must retain the supervised automatic-review policy");
    observation = await watchEvents(client, new Set());
    const run = async (text) => {
      const session = await client.createSession(`LetAgents project boundary ${text}`);
      assert.equal(typeof session.id, "string");
      const start = observation.seen.length;
      await client.promptAsync(session.id, {
        messageID: mintNativeUserMessageId(Date.now()),
        model: { providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID, modelID: "contract-model" },
        parts: [{ type: "text", text }],
      });
      return { sessionId: session.id, start };
    };
    for (const kind of ["workdir", "path", "leave", "sibling"]) {
      const { sessionId, start } = await run(`LETAGENTS_OUTSIDE_PROJECT_FIXTURE:${kind}`);
      // A request would hold the turn open, so it ends the wait too.
      await observation.waitFor((event) => (event.type === "permission.asked" && event.properties.sessionID === sessionId)
        || (eventReferencesSession(event, sessionId)
          && (event.type === "session.idle" || event.type === "session.error")), start);
      assert.deepEqual(observation.seen.slice(start).filter((event) => event.type === "permission.asked"
        && event.properties.sessionID === sessionId), [], `a command outside a ${workspaceKind} project (${kind}) must never become a request`);
      assert.deepEqual(await client.listPendingPermissions(sessionId), []);
      const tools = (await client.messages(sessionId)).flatMap((message) => message.parts ?? [])
        .filter((part) => part.type === "tool" && part.tool === "bash");
      assert.equal(tools.length, 1);
      assert.equal(tools[0].state?.status, "error", `a command outside a ${workspaceKind} project (${kind}) must not run`);
    }
    const inside = await run("LETAGENTS_INSIDE_PROJECT_FIXTURE");
    const asked = await observation.waitFor((event) => event.type === "permission.asked"
      && event.properties.sessionID === inside.sessionId, inside.start);
    // Automatic review reads the whole command from here and its parts from `patterns`.
    assert.equal(asked.properties.permission, "bash");
    assert.deepEqual(asked.properties.patterns, ["ls"]);
    assert.deepEqual(asked.properties.metadata, { command: "ls" });
    assert.deepEqual(await client.replyPermission(inside.sessionId, asked.properties, "reject"),
      { outcome: "processed", nativeScope: "session_pending" });
  } finally {
    await observation?.close().catch(() => {});
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

const binary = resolveBinary();
const actualVersion = verifyVersion(binary);
const provider = await startFixtureProvider();
const registry = await startFixtureRegistry();
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
// Production seeds every fresh runtime so OpenCode has no plugin SDK to
// install. npm is pointed at a loopback registry that records every request,
// so an attempted install is observed instead of inferred from a timeout.
const configHome = join(runtimeRoot, "config");
await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION);
await shieldOwnerInstructions(configHome);
const environment = minimalOpenCodeEnvironment(process.env, {
  npm_config_registry: registry.url,
  OPENCODE_SERVER_USERNAME: auth.username,
  OPENCODE_SERVER_PASSWORD: auth.password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_AUTH_CONTENT: openCodeAuthContent(CONTRACT_SENTINEL),
  XDG_DATA_HOME: join(runtimeRoot, "data"),
  XDG_CACHE_HOME: join(runtimeRoot, "cache"),
  XDG_CONFIG_HOME: configHome,
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
  // The launch inherits HOME, so an unprovisioned ~/.opencode on this machine
  // shows up here too: production launches on it would pay the same install.
  assert.deepEqual(
    registry.requests,
    [],
    "a supervised launch must not contact the npm registry before its first session",
  );
  assert.deepEqual(
    await readdir(join(configHome, "opencode", "node_modules")),
    [],
    "the seeded config directory must stay empty of installed packages",
  );
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

  // A complete answer with an unknown finish reason must end the turn after
  // one model request. OpenCode 1.18.21 through at least 1.18.33 instead
  // re-invoke the model without bound. Run this smoke before changing the pin.
  const unknownFinish = await reattached.createSession("LetAgents unknown finish");
  assert.equal(typeof unknownFinish.id, "string");
  const unknownFinishStart = observation.seen.length;
  await reattached.promptAsync(unknownFinish.id, {
    messageID: mintNativeUserMessageId(Date.now()),
    model: { providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID, modelID: "contract-model" },
    parts: [{ type: "text", text: "LETAGENTS_UNKNOWN_FINISH_FIXTURE" }],
  });
  await observation.waitFor((event) => event.type === "session.idle"
    && eventReferencesSession(event, unknownFinish.id), unknownFinishStart);
  assert.equal(provider.state.unknownFinishRequests, 1, "an unknown finish reason must not re-invoke the model");
  assert.ok(JSON.stringify(await reattached.messages(unknownFinish.id)).includes("unknown-finish-ok"));

  // While OpenCode waits to re-send a failed model request it reports the
  // session as "retry", not "busy". That is still an active turn: the client
  // must read it as busy, and a native abort must end it.
  const retrying = await reattached.createSession("LetAgents retry status");
  assert.equal(typeof retrying.id, "string");
  const retryStart = observation.seen.length;
  await reattached.promptAsync(retrying.id, {
    messageID: mintNativeUserMessageId(Date.now()),
    model: { providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID, modelID: "contract-model" },
    parts: [{ type: "text", text: "LETAGENTS_RETRY_FIXTURE" }],
  });
  await observation.waitFor((event) => event.type === "session.status"
    && event.properties.sessionID === retrying.id
    && event.properties.status?.type === "retry", retryStart);
  assert.equal(await reattached.status(retrying.id), "busy", "a retrying session is an active turn");
  await reattached.abort(retrying.id);
  await observation.waitFor((event) => event.type === "session.idle"
    && eventReferencesSession(event, retrying.id), retryStart);
  assert.equal(await reattached.status(retrying.id), "idle");
  assert.ok(provider.state.retriedRequests >= 1);
  // OpenCode's first backoff is 2 to 2.5 seconds, so a retry that survived
  // the abort has sent its next request by then. The wait sits here because
  // the instance disposal further down would end a surviving retry too.
  const retriedRequestsAtAbort = provider.state.retriedRequests;
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  assert.equal(
    provider.state.retriedRequests,
    retriedRequestsAtAbort,
    "an aborted retry must not send the model another request",
  );

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

  // A supervised agent takes its instructions from LetAgents and the project,
  // not from what the owner keeps in their home directory for other tools.
  // The two that must still arrive show that the prompt was the right one.
  const systemPrompt = await observeOwnerIsolation({
    binary, provider, registry, runtimeRoot, mcpPath, pluginPath, workspaceKind: "git_worktree",
  });
  assert.ok(systemPrompt.includes(PROJECT_INSTRUCTIONS_SENTINEL),
    "a project's CLAUDE.md must still reach the model when it has no AGENTS.md");
  assert.ok(systemPrompt.includes("project-opencode-skill"),
    "a project's own OpenCode skills must still be listed");
  assert.ok(!systemPrompt.includes(OWNER_INSTRUCTIONS_SENTINEL),
    "the owner's ~/.claude/CLAUDE.md must not reach the model");
  // OpenCode names the file each instruction came from.
  assert.ok(!systemPrompt.includes("isolation-config"),
    "the empty file that stands in for the owner's must add nothing to the prompt");
  for (const skill of ["owner-claude-skill", "owner-agents-skill", "project-claude-skill"]) {
    assert.ok(!systemPrompt.includes(skill), `the external skill ${skill} must not be listed`);
  }

  // A room's scratch workspace has no repository root to stop OpenCode's
  // search for project files, which would otherwise climb into the owner's
  // home directory.
  const scratchPrompt = await observeOwnerIsolation({
    binary, provider, registry, runtimeRoot, mcpPath, pluginPath, workspaceKind: "room_scratch",
  });
  assert.ok(!scratchPrompt.includes(HOME_DIRECTORY_INSTRUCTIONS_SENTINEL),
    "an AGENTS.md above a scratch workspace must not reach the model");
  assert.ok(!scratchPrompt.includes(HOME_DIRECTORY_CONFIG_SENTINEL),
    "instructions named by an opencode.json above a scratch workspace must not reach the model");
  assert.ok(!scratchPrompt.includes(ANCESTOR_AGENT_SENTINEL),
    "an agent definition above a scratch workspace must not replace the agent's prompt");
  // No launch setting stops OpenCode 1.18.20 importing plugins from above a
  // workspace; the workspace's own repository does, because OpenCode's
  // search ends at the project root. Each plugin writes its file when it is
  // imported, so none of these may exist once the turn has ended.
  const scratchLeftovers = await readdir(runtimeRoot);
  assert.ok(scratchLeftovers.includes("scratch-own-plugin-ran"),
    "positive control: a plugin in the scratch workspace's own .opencode directory is imported");
  assert.ok(!scratchLeftovers.includes("scratch-plugin-ran"),
    "a plugin in a .opencode directory above a scratch workspace must not be imported");
  assert.ok(!scratchLeftovers.includes("scratch-room-only-plugin-ran"),
    "a plugin in the .opencode directory beside every room's workspace must not be imported");
  assert.ok(!scratchLeftovers.includes("scratch-named-plugin-ran"),
    "a plugin named by an opencode.json above a scratch workspace must not be imported");
  assert.deepEqual(
    (await readdir(join(runtimeRoot, "scratch-home", ".letagents", ".opencode"))).sort(),
    ["agent", "plugin"],
    "OpenCode must not install into, or write to, a directory above a scratch workspace",
  );
  for (const workspaceKind of ["git_worktree", "room_scratch"]) {
    await verifyAutoStaysInProject(binary, provider, registry, workspaceKind);
  }
  assert.deepEqual(
    registry.requests,
    [],
    "no turn, reconnect, or instance disposal may contact the npm registry",
  );
  console.log(JSON.stringify({
    runtime: "opencode",
    version: actualVersion,
    pid: child.pid,
    sessionId,
    replacementSessionId,
    messageId,
    npmRegistryRequests: registry.requests.length,
    unknownFinishEndsTurnAfterOneRequest: true,
    retryStatusReadAsActiveAndAborted: true,
    ownerInstructionsAndExternalSkillsWithheld: true,
    scratchWorkspaceInstructionsAndAgentsWithheld: true,
    scratchWorkspacePluginsWithheld: true,
    scratchWorkspaceOwnPluginStillImported: true,
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
    automaticReviewStaysInProject: true,
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
  await registry.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}
