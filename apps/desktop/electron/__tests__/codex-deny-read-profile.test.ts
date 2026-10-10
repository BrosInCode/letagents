import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";

import { createElectronTestEnv } from "./harness.js";

// What the installed Codex does with a permission profile that denies reads.
//
// Codex's read-only and workspace-write sandboxes refuse no read: a command of
// a sandboxed agent can read the owner's Codex sign-in. A permission profile
// can name paths with `deny`. These cases ask the installed Codex, in real
// turns against a stand-in model on this machine, what such a profile does and
// what it costs. They are the facts the Read-only launch rests on, as Codex
// 0.153.4 shows them, and they fail when a later Codex changes one. The last
// case starts a Read-only agent through the adapter itself, so that what is
// shown is what the product sends, not what a test wrote by hand.
//
// Every home is a scratch folder, the sign-in is made up, and every address
// Codex could call is the stand-in service. The cases read the macOS sandbox's
// own words, so they run on macOS only.

const env = createElectronTestEnv({ prefix: "letagents-codex-deny-read-", paths: [] });
// Every Git call and every Codex in this file sees a scratch HOME, never the owner's.
const scratchHome = join(env.tempDir, "scratch-home");
mkdirSync(scratchHome, { recursive: true });
writeFileSync(join(scratchHome, ".gitconfig"), "[user]\n\tname = Fake Owner\n\temail = owner@example.invalid\n");
process.env.HOME = scratchHome;
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.CODEX_HOME;
// A launch through the adapter hands this process's environment on to the agent's commands. With this variable set,
// Node asks the keychain for certificates when it starts, which no Codex sandbox lets a command do, with or without a deny.
delete process.env.NODE_USE_SYSTEM_CA;

const { codexReadOnlyProfileId, codexReadOnlyProfileOverrides, codexSignInPaths, linkCodexAgentHome } = await import("../main/agents/codex-agent-home.js");
const { launchManagedCodexAppServer, terminateSpawnedProcess } = await import("../main/agents/codex-app-server.js");
const { resolveCodexExecutable } = await import("../main/agents/codex-executable.js");
const { CodexProviderAdapter } = await import("../main/agents/codex-provider-adapter.js");
const { CodexRpcClient } = await import("../main/agents/codex-rpc-client.js");

let fixtureSerial = 0;
function fixture(name: string): string {
  const path = join(env.tempDir, `${name}-${fixtureSerial++}`);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

function installedCodex(): string | null {
  if (process.env.LETAGENTS_SKIP_CODEX_CONTRACT === "1" || process.platform !== "darwin") return null;
  const bin = resolveCodexExecutable();
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000, env: { ...process.env, CODEX_HOME: fixture("version-home") } });
    return bin;
  } catch {
    return null;
  }
}
const realCodex = installedCodex();
// Codex's writable sandbox leaves /tmp writable, so "a folder nothing names" must not be below it.
const tempBelowSlashTmp = /^\/(?:private\/)?tmp(?:\/|$)/.test(realpathSync(env.tempDir));
const installed = {
  skip: !realCodex ? "needs the installed Codex on macOS" : tempBelowSlashTmp ? "the temp folder is below /tmp, which Codex's sandbox leaves writable" : false,
  timeout: 240_000,
};

const REFRESH_BEFORE = "made-up-refresh-token-before";
const REFRESH_AFTER = "made-up-refresh-token-after";
const REVIEWER_MODEL = "codex-auto-review";
/** A sign-in token in the shape Codex reads: three parts, the middle one its claims. Signed by nobody. */
function pretendToken(label: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ email: "check@letagents.invalid", exp: Math.floor(Date.now() / 1000) + 3600, label })}.${label}`;
}

type ModelItem = Record<string, unknown>;
type ModelRequest = { model?: string; input?: Array<{ type?: string; call_id?: string; output?: unknown }>; tools?: Array<{ name?: string; type?: string }> };
type StandIn = {
  origin: string;
  plan: Array<() => ModelItem[]>;
  /** What the agent's model was sent. The reviewer's requests are counted apart. */
  requests: ModelRequest[];
  reviews: number;
  refreshes: number;
  /** What each request to the agent's model was signed with. */
  authorizations: Array<string | null>;
  /** What Codex's own reviewer answers when it is asked about a command. */
  reviewerAllows: boolean;
};

/**
 * Everything Codex can reach, on this machine: the agent's model, the model of
 * Codex's own reviewer, and the service that refreshes a sign-in. Any other
 * request is answered 404, and Codex's proxy settings lead here too.
 */
async function standIn(t: TestContext): Promise<StandIn> {
  const service: StandIn = { origin: "", plan: [], requests: [], reviews: 0, refreshes: 0, authorizations: [], reviewerAllows: false };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = String(request.url);
      if (request.method === "POST" && url.endsWith("/oauth/token")) {
        service.refreshes += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id_token: pretendToken("after"), access_token: pretendToken("after"), refresh_token: REFRESH_AFTER }));
        return;
      }
      if (request.method !== "POST" || !url.endsWith("/responses")) {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      const asked = JSON.parse(body) as ModelRequest;
      let items: ModelItem[];
      if (asked.model === REVIEWER_MODEL) {
        service.reviews += 1;
        const verdict = service.reviewerAllows
          ? { outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "The stand-in reviewer allows it." }
          : { outcome: "deny", risk_level: "high", user_authorization: "unknown", rationale: "The stand-in reviewer refuses it." };
        items = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(verdict) }] }];
      } else {
        service.requests.push(asked);
        service.authorizations.push(request.headers.authorization ?? null);
        items = service.plan.shift()?.() ?? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "nothing planned" }] }];
      }
      const id = `resp_${service.requests.length}_${service.reviews}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Record<string, unknown>) => response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id } });
      for (const item of items) send({ type: "response.output_item.done", item });
      send({ type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
      response.end();
    });
  });
  // A request to any other host arrives as a tunnel to it, and is refused. A caller that hangs up on that is not an error here.
  server.on("connect", (_request, socket) => {
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => server.close());
  service.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return service;
}

type Owner = { home: string; codexHome: string; agentHome: string; signIn: string };

/**
 * A stand-in owner: a Codex home with a made-up sign-in kept in a file, a
 * prompt history, and a config that names the stand-in model as a provider a
 * conversation can ask for. `moreConfig` is added as the owner's own settings.
 */
function ownerHome(model: StandIn, moreConfig = ""): Owner {
  const home = fixture("owner");
  const codexHome = join(home, ".codex");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const signIn = join(codexHome, "auth.json");
  writeFileSync(signIn, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: pretendToken("before"), access_token: pretendToken("before"), refresh_token: REFRESH_BEFORE, account_id: "made-up-account" },
    last_refresh: "2000-01-01T00:00:00Z",
  }), { mode: 0o600 });
  writeFileSync(join(codexHome, "history.jsonl"), '{"text":"MADE-UP-HISTORY"}\n');
  writeFileSync(join(codexHome, "config.toml"), [
    'cli_auth_credentials_store = "file"', "",
    "[model_providers.standin]", 'name = "standin"', `base_url = "${model.origin}/v1"`,
    'wire_api = "responses"', "requires_openai_auth = false", "supports_websockets = false", "", moreConfig, "",
  ].join("\n"));
  return { home, codexHome, agentHome: join(home, ".letagents", "codex-agent-home"), signIn };
}

/** Launch overrides that define permission profiles, as a launch would pass them: nothing is written to the owner's config. */
function profileOverrides(profiles: Record<string, { extends: string; deny?: readonly string[] }>, byDefault: string): string[] {
  const tables = Object.entries(profiles).map(([id, profile]) => {
    const denied = (profile.deny ?? []).map((path) => `${JSON.stringify(path)} = "deny"`).join(", ");
    return `${id} = { extends = ${JSON.stringify(profile.extends)}${profile.deny?.length ? `, filesystem = { ${denied} }` : ""} }`;
  });
  return [`permissions={ ${tables.join(", ")} }`, `default_permissions=${JSON.stringify(byDefault)}`];
}

type Ask = <T = Record<string, unknown>>(method: string, params: unknown) => Promise<T>;
type Codex = {
  ask: Ask;
  /** Everything Codex told the client without being asked. */
  notes: Array<{ method: string; params: Record<string, unknown> }>;
  /** The approvals Codex asked the client for, by method. Each one was accepted. */
  approvalsAsked: string[];
  turnEnded(): Promise<void>;
};
type Started = {
  thread: { id: string; turns?: unknown[] };
  sandbox: Record<string, unknown>;
  activePermissionProfile: { id: string; extends: string | null } | null;
};

/** Start the installed Codex with one home, talk to it over its own protocol, and stop it. The client accepts every approval. */
async function withCodex<T>(
  options: { owner: Owner; codexHome: string; cwd: string; model: StandIn; overrides?: readonly string[] },
  use: (codex: Codex) => Promise<T>,
): Promise<T> {
  const { model } = options;
  const everyAddress = [
    "features.plugins=false", "features.apps=false", "features.memories=false", "analytics.enabled=false",
    `chatgpt_base_url="${model.origin}/"`, `openai_base_url="${model.origin}/v1"`,
  ];
  const proxies = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].map((key) => [key, model.origin]));
  const child = spawn(realCodex!, ["app-server", ...[...everyAddress, ...(options.overrides ?? [])].flatMap((override) => ["-c", override]), "--listen", "stdio://"], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH, HOME: options.owner.home, CODEX_HOME: options.codexHome, TMPDIR: fixture("tmp"),
      // The made-up token service. No agent is ever started with this variable: here it keeps the made-up sign-in on this machine.
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${model.origin}/oauth/token`, ...proxies,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const answers = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let turnEnds: Array<() => void> = [];
  let serial = 0;
  const codex: Codex = {
    notes: [], approvalsAsked: [],
    ask: ((method: string, params: unknown) => new Promise((resolve, reject) => {
      answers.set(++serial, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id: serial, method, params })}\n`);
    })) as Ask,
    turnEnded: () => new Promise<void>((resolve, reject) => {
      const late = setTimeout(() => reject(new Error("Codex did not end the turn in time")), 90_000);
      turnEnds.push(() => { clearTimeout(late); resolve(); });
    }),
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    if (message.method && message.id !== undefined) {
      // A question from Codex to the client. Only approvals are expected, and each is given.
      codex.approvalsAsked.push(message.method);
      child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: "accept" } })}\n`);
      return;
    }
    if (message.method) {
      codex.notes.push({ method: message.method, params: message.params ?? {} });
      if (message.method === "turn/completed") turnEnds.splice(0).forEach((ended) => ended());
      return;
    }
    const answer = answers.get(message.id!);
    answers.delete(message.id!);
    if (message.error) answer?.reject(new Error(String(message.error.message)));
    else answer?.resolve(message.result);
  });
  try {
    await codex.ask("initialize", { clientInfo: { name: "letagents-test", title: "test", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await use(codex);
  } finally {
    turnEnds = [];
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

/** What a conversation with the stand-in model is started with, besides its access. */
const STAND_IN_THREAD = { model: "stand-in", modelProvider: "standin", historyMode: "legacy" };
const READ_ONLY_SANDBOX = { type: "readOnly", networkAccess: false };
const PERMISSION_ERROR = /Operation not permitted/;

type Call = (callId: string) => ModelItem;
/** The model asks for a shell command. `escalated`: it asks to run it outside the sandbox, which needs an approval. */
const shell = (cmd: string, options: { escalated?: boolean } = {}): Call => (callId) => ({
  type: "function_call", call_id: callId, name: "exec_command",
  arguments: JSON.stringify({ cmd, login: false, ...(options.escalated ? { sandbox_permissions: "require_escalated", justification: "A made-up reason." } : {}) }),
});
/** The model asks for Codex's own image tool, which reads a file without the shell. */
const viewImage = (path: string): Call => (callId) => ({ type: "function_call", call_id: callId, name: "view_image", arguments: JSON.stringify({ path }) });

let turnSerial = 0;
/**
 * One turn in which the model asks for each call in order and then stops.
 * Returns what Codex sent back to the model for each call, as text.
 */
async function turn(codex: Codex, model: StandIn, threadId: string, calls: readonly Call[], access: Record<string, unknown> = {}): Promise<string[]> {
  const ids = calls.map((_, index) => `call_${turnSerial}_${index}`);
  turnSerial += 1;
  const before = model.requests.length;
  calls.forEach((call, index) => model.plan.push(() => [call(ids[index]!)]));
  model.plan.push(() => [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]);
  const ended = codex.turnEnded();
  await codex.ask("turn/start", { threadId, input: [{ type: "text", text: "Run the commands." }], ...access });
  await ended;
  assert.equal(model.plan.length, 0, "the model was asked for every call and for its last word");
  const outputs = model.requests.slice(before).flatMap((request) => request.input ?? []).filter((item) => String(item.type).endsWith("_output"));
  return ids.map((id) => {
    const output = outputs.find((item) => item.call_id === id)?.output;
    assert.notEqual(output, undefined, `Codex answered ${id}`);
    return typeof output === "string" ? output : JSON.stringify(output);
  });
}

/** The profile name Codex reports each time a conversation's settings change, from a point in what it said. */
function reportedProfiles(codex: Codex, from: number): Array<string | null> {
  return codex.notes.slice(from).filter((note) => note.method === "thread/settings/updated")
    .map((note) => (note.params.threadSettings as { activePermissionProfile: { id: string } | null }).activePermissionProfile?.id ?? null);
}

test("inside a model turn, a profile that denies the sign-in file keeps a Read-only agent's commands from it, by its own path and through the agents' home, and Codex itself still signs in and refreshes it", installed, async (t) => {
  const model = await standIn(t);
  const owner = ownerHome(model);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  const linkedSignIn = join(owner.agentHome, "auth.json");
  assert.equal(lstatSync(linkedSignIn).isSymbolicLink(), true, "the agents' home reaches the owner's sign-in through a link");
  const overrides = profileOverrides({
    letagents_read_only: { extends: ":read-only", deny: [owner.signIn] },
    only_the_link: { extends: ":read-only", deny: [linkedSignIn] },
  }, "letagents_read_only");

  await withCodex({ owner, codexHome: owner.agentHome, cwd: fixture("workspace"), model, overrides }, async (codex) => {
    const access = { approvalPolicy: "never", permissions: "letagents_read_only" };
    const started = await codex.ask<Started>("thread/start", { ...access, ...STAND_IN_THREAD });
    // What a launch could check: the profile by name, and the sandbox the Read-only level already looks for.
    assert.deepEqual(started.activePermissionProfile, { id: "letagents_read_only", extends: ":read-only" });
    assert.deepEqual(started.sandbox, READ_ONLY_SANDBOX);

    const [throughLink, ownersPath, history] = await turn(codex, model, started.thread.id, [
      shell(`cat ${linkedSignIn}`), shell(`cat ${owner.signIn}`), shell(`cat ${join(owner.codexHome, "history.jsonl")}`),
    ], { ...access, approvalsReviewer: "user" });
    assert.match(throughLink!, PERMISSION_ERROR, "the sign-in is refused through the link");
    assert.match(ownersPath!, PERMISSION_ERROR, "the sign-in is refused at the owner's own path");
    assert.match(history!, /MADE-UP-HISTORY/, "a file beside it, which the profile does not name, is still read");
    // A deny that names only the link refuses the file by both paths too. A launch names both, so that it rests on neither alone.
    const linkOnly = { approvalPolicy: "never", permissions: "only_the_link" };
    const other = await codex.ask<Started>("thread/start", { ...linkOnly, ...STAND_IN_THREAD });
    const refused = await turn(codex, model, other.thread.id, [shell(`cat ${linkedSignIn}`), shell(`cat ${owner.signIn}`)], linkOnly);
    for (const output of refused) assert.match(output, PERMISSION_ERROR, "with only the link denied");
    assert.equal(JSON.stringify(model.requests).includes(REFRESH_BEFORE), false, "nothing of the sign-in reached the model");

    // Codex's own process is not in the sandbox: it reads the denied file, and rewrites it in place when it refreshes it.
    const account = await codex.ask<{ account: { email?: string } | null }>("account/read", { refreshToken: true });
    assert.equal(account.account?.email, "check@letagents.invalid");
    assert.ok(model.refreshes >= 1, "Codex asked the made-up token service");
  });
  assert.equal(lstatSync(linkedSignIn).isSymbolicLink(), true, "the link is still a link");
  assert.equal(readFileSync(owner.signIn, "utf8").includes(REFRESH_AFTER), true, "the owner's own file holds the refreshed sign-in");
});

test("Codex's own image tool obeys the deny: it returns an image it may read, and refuses a denied file for permission, not for its format", installed, async (t) => {
  const model = await standIn(t);
  const owner = ownerHome(model);
  const workspace = fixture("workspace");
  // The smallest picture there is: one pixel.
  const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const privateFolder = join(owner.home, ".ssh");
  mkdirSync(privateFolder);
  writeFileSync(join(privateFolder, "made-up.png"), picture);
  writeFileSync(join(workspace, "open.png"), picture);
  writeFileSync(join(workspace, "not-a-picture.json"), '{"made-up":true}\n');
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  const overrides = profileOverrides({ letagents_read_only: { extends: ":read-only", deny: [owner.signIn, privateFolder] } }, "letagents_read_only");

  await withCodex({ owner, codexHome: owner.agentHome, cwd: workspace, model, overrides }, async (codex) => {
    const access = { approvalPolicy: "never", permissions: "letagents_read_only" };
    const started = await codex.ask<Started>("thread/start", { ...access, ...STAND_IN_THREAD });
    const [open, deniedPicture, deniedSignIn, throughLink, wrongFormat] = await turn(codex, model, started.thread.id, [
      viewImage(join(workspace, "open.png")), viewImage(join(privateFolder, "made-up.png")),
      viewImage(owner.signIn), viewImage(join(owner.agentHome, "auth.json")), viewImage(join(workspace, "not-a-picture.json")),
    ], access);
    // Every tool the model is offered at this level. `view_image` is the one that reads a file without the
    // shell. A Codex that offers another tool fails here, so that someone asks what that tool can read.
    assert.deepEqual(
      (model.requests[0]!.tools ?? []).map((tool) => tool.name ?? tool.type).sort(),
      ["create_goal", "exec_command", "get_goal", "multi_agent_v1", "request_user_input", "update_goal", "view_image", "web_search", "write_stdin"],
    );
    assert.match(open!, /"type":"input_image"/, "a picture the profile does not name is handed to the model");
    assert.match(open!, /data:image\/png;base64,/);
    // A real picture at a denied path: only the permission stands between it and the model.
    assert.match(deniedPicture!, /^unable to read image at .*Operation not permitted/);
    assert.match(deniedSignIn!, /^unable to read image at .*Operation not permitted/);
    assert.match(throughLink!, /^unable to read image at .*Operation not permitted/);
    // What the tool says of a file it may read that is no picture: other words.
    assert.match(wrongFormat!, /invalid or unsupported image data/);
    assert.doesNotMatch(wrongFormat!, PERMISSION_ERROR);
    assert.equal(JSON.stringify(model.requests).includes(REFRESH_BEFORE), false);
  });
});

test("with a deny in its profile, a command that the owner or Codex's reviewer approves stays in the sandbox: it reads no denied file, writes nowhere more, has no network and cannot commit; without a deny it leaves the sandbox", installed, async (t) => {
  const model = await standIn(t);
  const owner = ownerHome(model);
  const workspace = fixture("workspace");
  const outside = fixture("outside-the-workspace");
  const identity = ["-c", "user.name=Fake Owner", "-c", "user.email=owner@example.invalid"];
  const git = (...args: string[]) => execFileSync("git", [...identity, ...args], { cwd: workspace, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "A made-up commit");
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  const overrides = profileOverrides({
    without_deny: { extends: ":read-only" },
    deny_read_only: { extends: ":read-only", deny: [owner.signIn] },
    deny_workspace: { extends: ":workspace", deny: [owner.signIn] },
  }, "deny_read_only");
  // Answered 404 by the stand-in service when the command has a network, and not reached at all when it has none.
  const reach = `/usr/bin/curl -s --noproxy '*' -o /dev/null -w 'http=%{http_code}' --max-time 5 ${model.origin}/reach; echo " curl-exit=$?"`;

  await withCodex({ owner, codexHome: owner.agentHome, cwd: workspace, model, overrides }, async (codex) => {
    let serial = 0;
    /** One conversation in which the model asks to run four commands outside the sandbox, and each is approved. */
    const approved = async (start: Record<string, unknown>) => {
      const marker = join(outside, `approved-${serial++}`);
      // Codex's sandbox keeps a repository's own folder from being written, so a commit always has to ask.
      const commit = `echo ${serial} >> b.txt && git add -A && git ${identity.map((part) => JSON.stringify(part)).join(" ")} commit -q -m more; echo "commit-exit=$?"`;
      const asked = { client: codex.approvalsAsked.length, reviewer: model.reviews };
      const started = await codex.ask<Started>("thread/start", { ...start, ...STAND_IN_THREAD });
      const [, signIn, network, committed] = await turn(codex, model, started.thread.id, [
        shell(`touch ${marker}`, { escalated: true }), shell(`cat ${owner.signIn}`, { escalated: true }), shell(reach, { escalated: true }), shell(commit, { escalated: true }),
      ]);
      return {
        wroteOutside: existsSync(marker), signIn: signIn!, network: network!, committed: /commit-exit=0\b/.test(committed!),
        ownerApprovals: codex.approvalsAsked.length - asked.client, reviewerApprovals: model.reviews - asked.reviewer,
      };
    };
    const leftTheSandbox = (result: Awaited<ReturnType<typeof approved>>, what: string) => {
      assert.equal(result.wroteOutside, true, `${what}: the approved command wrote outside the workspace`);
      assert.equal(result.signIn.includes(REFRESH_BEFORE), true, `${what}: the approved command read the sign-in`);
      assert.match(result.network, /http=404/, `${what}: the approved command reached the network`);
      assert.equal(result.committed, true, `${what}: the approved command committed`);
    };
    const stayedInTheSandbox = (result: Awaited<ReturnType<typeof approved>>, what: string) => {
      assert.equal(result.wroteOutside, false, `${what}: the approved command wrote nothing outside the workspace`);
      assert.match(result.signIn, PERMISSION_ERROR, `${what}: the approved command was refused the sign-in`);
      assert.match(result.network, /curl-exit=7/, `${what}: the approved command had no network`);
      assert.equal(result.committed, false, `${what}: the approved command could not commit`);
    };

    // Ask before writes: the owner is asked, and here says yes each time.
    const askBeforeWrites = { approvalPolicy: "on-request" };
    const today = await approved({ ...askBeforeWrites, sandbox: "read-only" });
    assert.deepEqual([today.ownerApprovals, today.reviewerApprovals], [4, 0]);
    leftTheSandbox(today, "as LetAgents starts Codex today");
    const withoutDeny = await approved({ ...askBeforeWrites, permissions: "without_deny" });
    assert.equal(withoutDeny.ownerApprovals, 4);
    leftTheSandbox(withoutDeny, "with a profile that denies nothing");
    const withDeny = await approved({ ...askBeforeWrites, permissions: "deny_read_only" });
    assert.equal(withDeny.ownerApprovals, 4, "the owner is still asked, and the approval changes nothing");
    stayedInTheSandbox(withDeny, "with a profile that denies one file");

    // An approved change to a file is another matter: Codex applies it itself, and it still lands.
    const asked = codex.approvalsAsked.length;
    const patched = await codex.ask<Started>("thread/start", { ...askBeforeWrites, permissions: "deny_read_only", ...STAND_IN_THREAD });
    const [applied] = await turn(codex, model, patched.thread.id, [
      shell("apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch\nPATCH"),
    ]);
    assert.deepEqual(codex.approvalsAsked.slice(asked), ["item/fileChange/requestApproval"]);
    assert.match(applied!, /Success/);
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "two\n");

    // Auto: Codex's own reviewer is asked in the owner's place, and here says yes each time.
    model.reviewerAllows = true;
    const auto = { approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
    const autoToday = await approved({ ...auto, sandbox: "workspace-write" });
    assert.equal(autoToday.ownerApprovals, 0, "the owner is not asked");
    assert.ok(autoToday.reviewerApprovals >= 4, "the reviewer is asked about each command");
    leftTheSandbox(autoToday, "at Auto as LetAgents starts Codex today");
    const autoWithDeny = await approved({ ...auto, permissions: "deny_workspace" });
    assert.equal(autoWithDeny.ownerApprovals, 0);
    assert.ok(autoWithDeny.reviewerApprovals >= 4);
    stayedInTheSandbox(autoWithDeny, "at Auto with a profile that denies one file");
  });
});

test("after a later sandboxPolicy Codex reports no profile, whether the deny still holds or is gone, and a conversation started with the old sandbox option never has it", installed, async (t) => {
  const model = await standIn(t);
  const owner = ownerHome(model);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  // The profile is also the launch's default, to show that this alone protects nothing.
  const overrides = profileOverrides({ letagents_read_only: { extends: ":read-only", deny: [owner.signIn] } }, "letagents_read_only");

  await withCodex({ owner, codexHome: owner.agentHome, cwd: fixture("workspace"), model, overrides }, async (codex) => {
    const withProfile = { approvalPolicy: "never", permissions: "letagents_read_only", approvalsReviewer: "user" };
    // What LetAgents sends with every turn today.
    const withSandboxPolicy = { approvalPolicy: "never", sandboxPolicy: READ_ONLY_SANDBOX, approvalsReviewer: "user" };
    const read = shell(`cat ${owner.signIn}`);
    const started = await codex.ask<Started>("thread/start", { approvalPolicy: "never", permissions: "letagents_read_only", ...STAND_IN_THREAD });
    const thread = started.thread.id;
    /** One turn that tries to read the sign-in: what came back, and the profile names Codex reported on the way. */
    const tried = async (access: Record<string, unknown>) => {
      const from = codex.notes.length;
      const [output] = await turn(codex, model, thread, [read], access);
      return { refused: PERMISSION_ERROR.test(output!), read: output!.includes(REFRESH_BEFORE), reported: reportedProfiles(codex, from) };
    };

    // The profile is named again with the turn: nothing changes, and the file is refused.
    assert.deepEqual(await tried(withProfile), { refused: true, read: false, reported: [] });

    // The old option with a turn: Codex reports no profile from here on. The deny itself is still in force.
    assert.deepEqual(await tried(withSandboxPolicy), { refused: true, read: false, reported: [null] });

    // One turn with no sandbox drops the deny for good. Back at the old read-only option, Codex
    // reports what it reported before, no profile, and now the file is read. So once the old option
    // is sent, what Codex reports cannot tell a conversation that still has the deny from one that lost it.
    assert.deepEqual(await tried({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" }), { refused: false, read: true, reported: [null] });
    assert.deepEqual(await tried(withSandboxPolicy), { refused: false, read: true, reported: [null] });

    // Naming the profile with the turn brings it back, and Codex says so.
    assert.deepEqual(await tried(withProfile), { refused: true, read: false, reported: ["letagents_read_only"] });

    // Codex takes one or the other, never both.
    await assert.rejects(
      codex.ask("turn/start", { threadId: thread, input: [{ type: "text", text: "Run the commands." }], ...withProfile, sandboxPolicy: READ_ONLY_SANDBOX }),
      /`permissions` cannot be combined with `sandboxPolicy`/,
    );
    await assert.rejects(
      codex.ask("thread/start", { approvalPolicy: "never", permissions: "letagents_read_only", sandbox: "read-only", ...STAND_IN_THREAD }),
      /`permissions` cannot be combined with `sandbox`/,
    );

    // A conversation started as LetAgents starts one today has no profile and no deny, whatever the launch's default is.
    const asToday = await codex.ask<Started>("thread/start", { approvalPolicy: "never", sandbox: "read-only", ...STAND_IN_THREAD });
    assert.equal(asToday.activePermissionProfile, null);
    assert.deepEqual(asToday.sandbox, READ_ONLY_SANDBOX);
    const [output] = await turn(codex, model, asToday.thread.id, [read], withSandboxPolicy);
    assert.equal(output!.includes(REFRESH_BEFORE), true, "the sign-in is read");
  });
});

test("an owner's writable_roots stay writable at Auto as LetAgents starts it today, whatever sandbox a turn names; they reach no conversation of a launch whose default is a permission profile", installed, async (t) => {
  const model = await standIn(t);
  const ownersRoot = fixture("owner-writable-root");
  const elsewhere = fixture("elsewhere");
  const workspace = fixture("workspace");
  const owner = ownerHome(model, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(ownersRoot)}]\nnetwork_access = true`);
  linkCodexAgentHome(owner.codexHome, owner.agentHome);
  const auto = { approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  // What LetAgents names with every turn of an Auto agent.
  const turnPolicy = { ...auto, sandboxPolicy: { type: "workspaceWrite", networkAccess: false } };
  /** One turn that tries a plain `touch` in the owner's root, in a folder nothing names, and in the workspace. */
  const touched = async (codex: Codex, thread: string, name: string, access: Record<string, unknown>) => {
    await turn(codex, model, thread, [ownersRoot, elsewhere, workspace].map((folder) => shell(`touch ${join(folder, name)}`)), access);
    return { ownersRoot: existsSync(join(ownersRoot, name)), elsewhere: existsSync(join(elsewhere, name)), workspace: existsSync(join(workspace, name)) };
  };
  /** What Codex last said the conversation's sandbox is, since a point in what it said. */
  const lastSandbox = (codex: Codex, from: number) => (codex.notes.slice(from).filter((note) => note.method === "thread/settings/updated")
    .map((note) => (note.params.threadSettings as { sandboxPolicy: Record<string, unknown> }).sandboxPolicy).at(-1) ?? null);

  // As LetAgents starts an Auto agent today: the launch names no permission profile, the conversation names the sandbox.
  await withCodex({ owner, codexHome: owner.agentHome, cwd: workspace, model }, async (codex) => {
    const today = await codex.ask<Started>("thread/start", { ...auto, sandbox: "workspace-write", ...STAND_IN_THREAD });
    // Codex reports the owner's folder and the owner's network setting for it.
    assert.deepEqual([today.sandbox.writableRoots, today.sandbox.networkAccess, today.activePermissionProfile], [[ownersRoot], true, null]);
    // The policy of the turn takes the network away. It does not take the folder away: a command writes there.
    const from = codex.notes.length;
    assert.deepEqual(await touched(codex, today.thread.id, "turn-as-today", turnPolicy), { ownersRoot: true, elsewhere: false, workspace: true });
    assert.deepEqual([lastSandbox(codex, from)?.writableRoots, lastSandbox(codex, from)?.networkAccess], [[ownersRoot], false]);
    // Nor does a turn that names an empty list of folders.
    assert.deepEqual(await touched(codex, today.thread.id, "turn-with-an-empty-list", { ...auto, sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } }),
      { ownersRoot: true, elsewhere: false, workspace: true });
  });

  // A launch whose default is a permission profile, as a Read-only launch has one. An earlier version of this case
  // started Codex this way and took what follows for what happens today.
  const overrides = profileOverrides({ letagents_auto: { extends: ":workspace", deny: [owner.signIn] } }, "letagents_auto");
  await withCodex({ owner, codexHome: owner.agentHome, cwd: workspace, model, overrides }, async (codex) => {
    // A conversation that names the profile never has the owner's folder or network, in the reply or in a turn.
    const withProfile = await codex.ask<Started>("thread/start", { ...auto, permissions: "letagents_auto", ...STAND_IN_THREAD });
    assert.deepEqual(withProfile.activePermissionProfile, { id: "letagents_auto", extends: ":workspace" });
    assert.deepEqual([withProfile.sandbox.type, withProfile.sandbox.writableRoots, withProfile.sandbox.networkAccess], ["workspaceWrite", [], false]);
    assert.deepEqual(await touched(codex, withProfile.thread.id, "turn-with-the-profile", { ...auto, permissions: "letagents_auto" }), { ownersRoot: false, elsewhere: false, workspace: true });
    // A conversation of this launch that names the sandbox is told the owner's folder at its start, and a turn that names the sandbox takes it away.
    const named = await codex.ask<Started>("thread/start", { ...auto, sandbox: "workspace-write", ...STAND_IN_THREAD });
    assert.deepEqual([named.sandbox.writableRoots, named.sandbox.networkAccess], [[ownersRoot], true]);
    const from = codex.notes.length;
    assert.deepEqual(await touched(codex, named.thread.id, "named-sandbox-under-a-default-profile", turnPolicy), { ownersRoot: false, elsewhere: false, workspace: true });
    assert.deepEqual([lastSandbox(codex, from)?.writableRoots, lastSandbox(codex, from)?.networkAccess], [[], false]);
  });
  assert.equal(model.reviews, 0, "no command asked to leave the sandbox, so the reviewer was never asked");
});

test("a deny list of the owner's private Codex files, SSH folder and LetAgents state breaks neither git, node, rg nor apply_patch, and Codex itself still lists and resumes the owner's conversation", installed, async (t) => {
  const model = await standIn(t);
  const owner = ownerHome(model);
  const workspace = fixture("workspace");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fake Owner", "-c", "user.email=owner@example.invalid", ...args], { cwd: workspace, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "A made-up commit");
  mkdirSync(join(owner.home, ".ssh"));
  writeFileSync(join(owner.home, ".ssh", "id_made_up"), "MADE-UP-KEY\n");
  mkdirSync(join(owner.home, ".letagents"));
  writeFileSync(join(owner.home, ".letagents", "mcp-state.json"), '{"made-up":true}\n');

  // The owner's own Codex first: it writes a conversation and its databases into its home.
  const conversation = await withCodex({ owner, codexHome: owner.codexHome, cwd: workspace, model }, async (codex) => {
    const started = await codex.ask<Started>("thread/start", { approvalPolicy: "never", sandbox: "read-only", ...STAND_IN_THREAD });
    await turn(codex, model, started.thread.id, [shell("true")]);
    return started.thread.id;
  });
  for (const folder of ["archived_sessions", "shell_snapshots"]) mkdirSync(join(owner.codexHome, folder), { recursive: true });
  writeFileSync(join(owner.codexHome, "archived_sessions", "made-up.jsonl"), "MADE-UP-ARCHIVE\n");
  const rollout = readdirSync(join(owner.codexHome, "sessions"), { recursive: true }).map(String).find((name) => name.endsWith(".jsonl"));
  assert.ok(rollout, "the owner's conversation is a file in sessions");
  const databases = readdirSync(owner.codexHome).filter((name) => /\.sqlite/.test(name));
  assert.ok(databases.length > 0, "Codex keeps databases in its home");
  linkCodexAgentHome(owner.codexHome, owner.agentHome);

  // Exact paths, each one a file or a folder. Never the whole home: Codex keeps the helper programs its commands call in it.
  const deniedFiles = [owner.signIn, ...["config.toml", "history.jsonl", ...databases].map((name) => join(owner.codexHome, name)), join(owner.home, ".letagents", "mcp-state.json")];
  const deniedFolders = [...["sessions", "archived_sessions", "shell_snapshots"].map((name) => join(owner.codexHome, name)), join(owner.home, ".ssh")];
  for (const path of [...deniedFiles, ...deniedFolders]) assert.equal(existsSync(path), true, "each denied path is there to be read");
  const overrides = profileOverrides({ letagents_auto: { extends: ":workspace", deny: [...deniedFiles, ...deniedFolders] } }, "letagents_auto");
  const hasRg = (() => { try { execFileSync("which", ["rg"], { stdio: "ignore" }); return true; } catch { return false; } })();

  await withCodex({ owner, codexHome: owner.agentHome, cwd: workspace, model, overrides }, async (codex) => {
    // Codex itself reads its config, its databases and the conversation, all of them denied to its commands.
    const listed = await codex.ask<{ data: Array<{ id: string }> }>("thread/list", { modelProviders: [] });
    assert.equal(listed.data.some((thread) => thread.id === conversation), true, "Codex lists the owner's conversation");
    const access = { approvalPolicy: "never", permissions: "letagents_auto" };
    const resumed = await codex.ask<Started>("thread/resume", { threadId: conversation, cwd: workspace, ...access });
    assert.equal(resumed.thread.turns?.length, 1, "Codex resumes it with its turn");
    assert.deepEqual(resumed.activePermissionProfile, { id: "letagents_auto", extends: ":workspace" });

    const works = [
      "git status --short --branch; echo \"git-status=$?\"", "git log --oneline -1; echo \"git-log=$?\"",
      `${JSON.stringify(process.execPath)} -e 1; echo "node=$?"`, ...(hasRg ? ["rg --files .; echo \"rg=$?\""] : []),
    ].join("; ");
    const tried = (label: string, command: string) => `${command} >/dev/null 2>&1 && echo "READ ${label}" || echo "REFUSED ${label}"`;
    const reads = [
      ...deniedFiles.map((path, index) => tried(`file-${index}`, `cat ${path}`)),
      ...deniedFolders.map((path, index) => tried(`folder-${index}`, `ls -A ${path}/`)),
      // The same through the agents' home, where each of them is a link, and inside a denied folder.
      tried("linked-config", `cat ${join(owner.agentHome, "config.toml")}`),
      tried("linked-sessions", `ls -A ${join(owner.agentHome, "sessions")}/`),
      tried("linked-conversation", `cat ${join(owner.agentHome, "sessions", rollout)}`),
      tried("archived-conversation", `cat ${join(owner.codexHome, "archived_sessions", "made-up.jsonl")}`),
      tried("private-key", `cat ${join(owner.home, ".ssh", "id_made_up")}`),
      tried("workspace-file", "cat a.txt"),
    ].join("; ");
    const [patched, worked, read] = await turn(codex, model, conversation, [
      shell("apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch\nPATCH"), shell(works), shell(reads),
    ], access);

    assert.match(patched!, /Success/, "apply_patch, a helper program in Codex's own home, still runs");
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "two\n");
    for (const tool of ["git-status", "git-log", "node", ...(hasRg ? ["rg"] : [])]) assert.match(worked!, new RegExp(`${tool}=0\\b`), `${tool} still works`);
    const refused = [...read!.matchAll(/REFUSED (\S+)/g)].map((match) => match[1]).sort();
    const expected = [
      ...deniedFiles.map((_, index) => `file-${index}`), ...deniedFolders.map((_, index) => `folder-${index}`),
      "linked-config", "linked-sessions", "linked-conversation", "archived-conversation", "private-key",
    ].sort();
    assert.deepEqual(refused, expected, "every denied file and folder is refused, by its path, through its link and inside it");
    assert.match(read!, /READ workspace-file/, "the project is still read");

    // And after the turn Codex still has the conversation, now with two turns, and the owner's sign-in.
    const again = await codex.ask<Started>("thread/resume", { threadId: conversation, cwd: workspace, ...access });
    assert.equal(again.thread.turns?.length, 2);
    const account = await codex.ask<{ account: { email?: string } | null }>("account/read", { refreshToken: false });
    assert.equal(account.account?.email, "check@letagents.invalid");
  });
});

/** A stand-in for the room's own MCP server: it offers the room tools a turn needs, and says so where the adapter asks. */
function standInRoomServer(path: string): string {
  writeFileSync(path, [
    "import { createInterface } from 'node:readline';",
    "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
    "const tools = ['claim_task', 'get_board', 'read_messages', 'send_message'];",
    "const readiness = { uri: 'letagents://runtime/readiness', mimeType: 'application/json', text: JSON.stringify({ format: 1, profile: 'supervised_room_turn', provider: 'codex', tools }) };",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  let asked; try { asked = JSON.parse(line); } catch { return; }",
    "  if (asked.method === 'initialize') send({ id: asked.id, result: { protocolVersion: asked.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'stand-in', version: '1' } } });",
    "  else if (asked.method === 'tools/list') send({ id: asked.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) } });",
    "  else if (asked.method === 'resources/list') send({ id: asked.id, result: { resources: [{ uri: readiness.uri, name: 'readiness', mimeType: readiness.mimeType }] } });",
    "  else if (asked.method === 'resources/read') send({ id: asked.id, result: { contents: [readiness] } });",
    "  else if (asked.id !== undefined) send({ id: asked.id, result: {} });",
    "});",
    "",
  ].join("\n"));
  return path;
}

async function freeLoopbackUrl(): Promise<string> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

test("a Read-only agent that the adapter itself starts has the profile in its launch and in every request: its commands are refused the sign-in file by both paths, git, node and rg still work, and Codex itself signs in with that file and refreshes it in place", installed, async (t) => {
  const model = await standIn(t);
  const owner = ownerHome(model);
  // The stand-in model is the owner's own provider here, and one that takes the owner's sign-in:
  // what Codex signs a request to it with shows that Codex itself read the file its commands are refused.
  writeFileSync(join(owner.codexHome, "config.toml"), [
    'model = "stand-in"', 'model_provider = "standin"', 'cli_auth_credentials_store = "file"', "",
    "[model_providers.standin]", 'name = "standin"', `base_url = "${model.origin}/v1"`,
    'wire_api = "responses"', "requires_openai_auth = true", "supports_websockets = false", "",
  ].join("\n"));
  const accessToken = pretendToken("before");
  writeFileSync(owner.signIn, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: accessToken, access_token: accessToken, refresh_token: REFRESH_BEFORE, account_id: "made-up-account" },
    // Refreshed just now, so Codex has no reason to refresh it before it is asked to.
    last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  const workspace = fixture("workspace");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fake Owner", "-c", "user.email=owner@example.invalid", ...args], { cwd: workspace, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "A made-up commit");
  const roomServer = standInRoomServer(join(fixture("room-server"), "server.mjs"));
  const hasRg = (() => { try { execFileSync("which", ["rg"], { stdio: "ignore" }); return true; } catch { return false; } })();

  const workAttemptId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const profile = codexReadOnlyProfileId(workAttemptId);
  const proxies = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].map((key) => [key, model.origin]));
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const launches: Array<{ pid: number | null; exited: Promise<unknown> }> = [];
  const clients: Array<InstanceType<typeof CodexRpcClient>> = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const launch of launches) {
      if (launch.pid !== null) terminateSpawnedProcess(launch.pid);
      await Promise.race([launch.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
  });
  // The adapter as the daemon uses it, with the product's own launch. Only where things are is a stand-in:
  // the owner's home, the room's server, and the addresses Codex could call.
  const adapter = new CodexProviderAdapter({ codexBin: realCodex!, dependencies: {
    resolveServerUrl: freeLoopbackUrl,
    resolveMcpRuntime: () => ({ entryPath: roomServer, readRoots: [join(roomServer, "..")] }),
    readMcpRuntimeContract: async () => ({ format: 1, profiles: { cursor_supervised_room_turn: { tools: ["claim_task", "get_board", "read_messages", "send_message"] } } }),
    writeSupervisorBridgeContext: async () => {},
    launchServer: async (serverUrl, bin, options) => {
      const launch = await launchManagedCodexAppServer(serverUrl, bin, { ...options, env: { ...options.env, HOME: owner.home, CODEX_HOME: owner.codexHome, ...proxies } });
      launches.push(launch);
      return launch;
    },
    createRpcClient: (serverUrl, notify) => {
      const client = new CodexRpcClient(serverUrl, notify);
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> => {
        sent.push({ method, params: (params ?? {}) as Record<string, unknown> });
        return request<T>(method, params, options);
      };
      clients.push(client);
      return client;
    },
  } });
  const handle = await adapter.spawn({
    workAttemptId, roomId: "room_fake", agentDisplayName: "FakeAgent", cwd: workspace,
    deliveryMode: "daemon_inbox", supervisorEntryId: "supervised_fake", supervisorSocketPath: join(fixture("daemon"), "daemon.sock"),
    supervisorExecutionGenerationId: "generation", supervisorWorkerSession: { agentSessionId: "session", roomCursor: null, apiUrl: "http://127.0.0.1:9" },
    permissionProfileId: "read_only", configurationRevision: 1,
    launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  });

  // The launch: Codex runs with the agents' home, and its own command line holds the profile, with the
  // sign-in file denied at the owner's path and at the link.
  const linkedSignIn = join(owner.agentHome, "auth.json");
  assert.equal(lstatSync(linkedSignIn).isSymbolicLink(), true);
  const commandLine = execFileSync("ps", ["-ww", "-p", String(handle.pid), "-o", "command="], { encoding: "utf8" });
  const overrides = codexReadOnlyProfileOverrides(profile, codexSignInPaths({ HOME: owner.home, CODEX_HOME: owner.codexHome }, owner.agentHome));
  assert.deepEqual(overrides, [
    `permissions.${profile}={ extends = ":read-only", filesystem = { ${JSON.stringify(owner.signIn)} = "deny", ${JSON.stringify(linkedSignIn)} = "deny" } }`,
    `default_permissions=${JSON.stringify(profile)}`,
  ]);
  for (const override of overrides) assert.equal(commandLine.includes(override), true, `the launch gave Codex ${override.split("=")[0]}`);
  assert.deepEqual(readdirSync(join(owner.home, ".letagents")), ["codex-agent-home"], "the launch's checks left nothing beside the agents' home");

  // One room turn, as the daemon gives it: the model asks for the sign-in file both ways, and for what a coding agent needs.
  const works = [
    "git status --short --branch; echo \"git-status=$?\"", "git log --oneline -1; echo \"git-log=$?\"",
    `${JSON.stringify(process.execPath)} -e 1; echo "node=$?"`, ...(hasRg ? ["rg --files .; echo \"rg=$?\""] : []), "cat a.txt",
  ].join("; ");
  const calls = [shell(`cat ${linkedSignIn}`), shell(`cat ${owner.signIn}`), shell(works)];
  const ids = calls.map((_, index) => `adapter_call_${index}`);
  calls.forEach((call, index) => model.plan.push(() => [call(ids[index]!)]));
  model.plan.push(() => [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]);
  const result = await adapter.runRoomTurn(handle, { inboxItemId: "item-1", actionId: "action-1", sourceMessage: { text: "A made-up room message." }, activation: {} });
  // The turn ran to its end on the conversation the adapter started. What the room is told of it is not looked at here.
  assert.equal(typeof result.turnId, "string");
  assert.equal(model.plan.length, 0, "the model was asked for every call and for its last word");
  const outputs = model.requests.flatMap((request) => request.input ?? []).filter((item) => String(item.type).endsWith("_output"));
  const [throughLink, ownersPath, worked] = ids.map((id) => String(outputs.find((item) => item.call_id === id)?.output));
  assert.match(throughLink!, PERMISSION_ERROR, "the sign-in is refused through the link");
  assert.match(ownersPath!, PERMISSION_ERROR, "the sign-in is refused at the owner's own path");
  for (const tool of ["git-status", "git-log", "node", ...(hasRg ? ["rg"] : [])]) assert.match(worked!, new RegExp(`${tool}=0\\b`), `${tool} still works`);
  assert.match(worked!, /\bone\b/, "the project is still read");
  assert.equal(JSON.stringify(model.requests).includes(REFRESH_BEFORE), false, "nothing of the sign-in reached the model");

  // Every request the adapter made: none names a sandbox, and each that gives a conversation or a turn its access names the profile.
  const access = sent.filter((request) => request.method === "thread/start" || request.method === "thread/resume" || request.method === "turn/start");
  assert.deepEqual(access.map((request) => request.method), ["thread/start", "turn/start"]);
  for (const request of access) assert.deepEqual([request.params.permissions, request.params.approvalPolicy], [profile, "never"], request.method);
  assert.deepEqual(sent.filter((request) => Object.hasOwn(request.params, "sandbox") || Object.hasOwn(request.params, "sandboxPolicy")).map((request) => request.method), []);

  // Codex itself is not in the sandbox: it signed its requests to the owner's provider with the token in that file.
  assert.equal(model.authorizations.length > 0 && model.authorizations.every((authorization) => authorization === `Bearer ${accessToken}`), true);
  const account = await clients[0]!.request<{ account: { email?: string } | null }>("account/read", { refreshToken: false });
  assert.equal(account.account?.email, "check@letagents.invalid");
  assert.equal(model.refreshes, 0, "nothing has refreshed the sign-in so far");
  await adapter.stop(handle);

  // And it rewrites the file in place when it refreshes it, with the same profile in force. No agent is given a
  // token service, so this last step starts Codex by hand, with the overrides the launch gave it.
  await withCodex({ owner, codexHome: owner.agentHome, cwd: workspace, model, overrides }, async (codex) => {
    const refreshed = await codex.ask<{ account: { email?: string } | null }>("account/read", { refreshToken: true });
    assert.equal(refreshed.account?.email, "check@letagents.invalid");
  });
  assert.equal(model.refreshes >= 1, true, "Codex asked the made-up token service");
  assert.equal(lstatSync(linkedSignIn).isSymbolicLink(), true, "the link is still a link");
  assert.equal(readFileSync(owner.signIn, "utf8").includes(REFRESH_AFTER), true, "the owner's own file holds the refreshed sign-in");
});
