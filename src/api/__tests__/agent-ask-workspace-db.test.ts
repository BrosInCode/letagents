import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const gitBase = mkdtempSync(path.join(tmpdir(), "ask-git-"));
process.env.LETAGENTS_ASK_GIT_BASE_URL = `file://${gitBase}`;
const dbm = url ? await import("../db/client.js") : null;
const core = url ? await import("../db.js") : null;
const asks = url ? await import("../agent-asks/store.js") : null;
const ws = url ? await import("../agent-asks/workspace.js") : null;
const pool = dbm?.pool;
const options = { skip: !url, concurrency: false };
// Built at runtime so the source never holds a key-shaped string (same as secret-firewall.test.ts).
const FAKE_STRIPE_LIVE = "sk_live_" + "x".repeat(24);
const SERVER_SECRET_FILE = path.join(mkdtempSync(path.join(tmpdir(), "ask-server-")), "secret.txt");
const workspaceDir = (askId: string) => path.join(tmpdir(), "letagents-ask-workspaces", askId);
if (url) {
  test.beforeEach(async () => {
    rmSync(path.join(tmpdir(), "letagents-ask-workspaces"), { recursive: true, force: true });
    await pool!.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
    await migrate(dbm!.db, { migrationsFolder: path.resolve("drizzle") });
  });
  test.after(() => pool!.end());
}

/** A bare repo at <gitBase>/acme/app.git with one secret file. */
function makeRepo() {
  if (existsSync(path.join(gitBase, "acme", "app.git"))) return;
  const work = mkdtempSync(path.join(tmpdir(), "ask-work-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  mkdirSync(path.join(work, "src"));
  writeFileSync(path.join(work, "src", "auth.ts"), "export function login() {\n  return 'todo: fix auth';\n}\n");
  writeFileSync(path.join(work, ".env"), `API_KEY=${FAKE_STRIPE_LIVE}\n`);
  // A secret committed in an ordinary file, beside a line that is safe to show.
  writeFileSync(path.join(work, "src", "billing.ts"), `// billing setup\nexport const billingKey = "${FAKE_STRIPE_LIVE}";\n`);
  // A link committed in the repo that points at a file on the server.
  writeFileSync(SERVER_SECRET_FILE, "SERVER-SECRET-123\n");
  symlinkSync(SERVER_SECRET_FILE, path.join(work, "src", "leak.txt"));
  git("add", "-A"); git("commit", "-q", "-m", "init");
  mkdirSync(path.join(gitBase, "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", work, path.join(gitBase, "acme", "app.git")]);
}

async function activeAsk() {
  makeRepo();
  const { room } = await core!.getOrCreateCanonicalRoom("github.com/acme/app");
  const sam = await core!.upsertAccount({ provider: "github", provider_user_id: "1", login: "sam" });
  const john = await core!.upsertAccount({ provider: "github", provider_user_id: "2", login: "john" });
  const created = await asks!.createAsk({ askerAccountId: sam.id, roomId: room.id, providerId: "cursor", model: null, modelLabel: "Cursor", amountPercent: null, note: "" });
  await pool!.query("UPDATE agent_asks SET state='active', giver_account_id=$2 WHERE id=$1", [created.ask!.id, john.id]);
  return (await asks!.getAskById(created.ask!.id))!;
}

test("the agent lists, reads and searches the asker's code, never secrets, and every read is recorded", options, async () => {
  const ask = await activeAsk();
  const files = await ws!.listFiles(ask, "");
  assert.deepEqual(files, ["src/auth.ts", "src/billing.ts", "src/leak.txt"]);
  assert.match((await ws!.readRepoFile(ask, "src/auth.ts")).content, /todo: fix auth/);
  await assert.rejects(ws!.readRepoFile(ask, ".env"), /may hold secrets/);
  await assert.rejects(ws!.readRepoFile(ask, "../../etc/passwd"), /inside the repo/);
  assert.deepEqual((await ws!.searchRepo(ask, "fix auth")).map(hit => [hit.path, hit.line]), [["src/auth.ts", 2]]);
  assert.deepEqual((await ws!.searchRepo(ask, "sk_live")), []);
  // A search never shows a line that holds a secret, even when the query matches only the safe part.
  assert.deepEqual((await ws!.searchRepo(ask, "billing")).map(hit => [hit.path, hit.line]), [["src/billing.ts", 1]]);
  const seen = await ws!.listReads(ask.id);
  assert.ok(seen.some(row => row.kind === "file" && row.target === ".env" && row.blocked));
  assert.ok(seen.some(row => row.kind === "file" && row.target === "src/auth.ts" && !row.blocked));
});

test("proposals reject secrets and paths outside the repo, and wait for the asker", options, async () => {
  const ask = await activeAsk();
  await assert.rejects(ws!.proposeChange(ask, "Leak", [{ path: ".env", content: "x" }], "john"), /may hold secrets/);
  await assert.rejects(ws!.proposeChange(ask, "Add key", [{ path: "src/key.ts", content: `const k = '${FAKE_STRIPE_LIVE}';` }], "john"), /contains a secret/);
  await assert.rejects(ws!.proposeChange(ask, "Escape", [{ path: "../x", content: "x" }], "john"), /full new content|inside/);
  const proposal = await ws!.proposeChange(ask, "Fix login", [{ path: "src/auth.ts", content: "export function login() { return 'ok'; }\n" }], "john");
  assert.equal(proposal.state, "waiting");
  const declined = await ws!.decideProposal(ask, proposal.id, false);
  assert.equal(declined?.state, "declined");
  assert.equal(await ws!.decideProposal(ask, proposal.id, true), null);
});

test("an approved change without a connected GitHub App fails with a plain reason", options, async () => {
  const ask = await activeAsk();
  const proposal = await ws!.proposeChange(ask, "Fix login", [{ path: "src/auth.ts", content: "ok\n" }], "john");
  const result = await ws!.decideProposal(ask, proposal.id, true);
  assert.equal(result?.state, "failed");
  assert.match(result?.error ?? "", /GitHub didn't accept the change/);
});

test("the agent's ask is found from its own grant and only while running", options, async () => {
  const ask = await activeAsk();
  const agent = await core!.registerAgentIdentity({ owner_account_id: ask.giver_account_id!, owner_login: "john", owner_label: "john", name: "helper" });
  const { grant } = await core!.createSupervisorHostGrant({ owner_account_id: ask.giver_account_id!, host_id: "h", installation_id: "i",
    allowed_room_ids: [ask.room_id], allowed_agent_keys: [agent.canonical_key], expires_at: new Date(Date.now() + 3600000).toISOString(), scope_key: `ask:${ask.id}` });
  await pool!.query("UPDATE agent_asks SET grant_id=$2 WHERE id=$1", [ask.id, grant.grant_id]);
  const worker = await core!.createRoomAgentSession({ room_id: ask.room_id, session_kind: "worker", runtime: "t", actor_label: "x", agent_key: agent.canonical_key,
    agent_instance_id: "e", display_name: "x", owner_account_id: ask.giver_account_id!, owner_label: "john", ide_label: "Cursor", supervisor_grant_id: grant.grant_id });
  assert.equal((await asks!.askForWorker(worker.session_id))?.id, ask.id);
  await pool!.query("UPDATE agent_asks SET state='ended' WHERE id=$1", [ask.id]);
  assert.equal(await asks!.askForWorker(worker.session_id), null);
});

test("a link in the repo never reads a file on the server", options, async () => {
  const ask = await activeAsk();
  // Cloned without symlinks, the link is a plain file that holds only its target's path.
  const read = await ws!.readRepoFile(ask, "src/leak.txt");
  assert.ok(!read.content.includes("SERVER-SECRET-123"));
  // A link that appears in the copy later is refused too.
  symlinkSync(SERVER_SECRET_FILE, path.join(workspaceDir(ask.id), "src", "late-link.txt"));
  await assert.rejects(ws!.readRepoFile(ask, "src/late-link.txt"), /doesn't exist/);
});

test("concurrent first calls share one clone and all succeed", options, async () => {
  const ask = await activeAsk();
  const [files, read, hits] = await Promise.all([
    ws!.listFiles(ask, ""), ws!.readRepoFile(ask, "src/auth.ts"), ws!.searchRepo(ask, "fix auth"),
  ]);
  assert.ok(files.includes("src/auth.ts"));
  assert.match(read.content, /todo: fix auth/);
  assert.equal(hits.length, 1);
});

test("the installation token reaches git through its environment, never its arguments", () => {
  assert.ok(ws, "workspace module loaded");
  const env = ws!.gitAuthEnv("ghs_secret");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`);
  assert.equal(ws!.gitAuthEnv(null).GIT_CONFIG_COUNT, undefined);
});

test("cleanup removes copies whose gift isn't running and keeps the rest", options, async () => {
  const ask = await activeAsk();
  await ws!.listFiles(ask, "");
  const stray = workspaceDir("ask_stray-copy");
  mkdirSync(stray, { recursive: true });
  await ws!.pruneWorkspaces(async id => id === ask.id);
  assert.equal(existsSync(stray), false);
  assert.equal(existsSync(path.join(workspaceDir(ask.id), ".git")), true);
});

test("a given agent can't change the repo's CI", options, async () => {
  const ask = await activeAsk();
  for (const file of [".github/workflows/ci.yml", ".gitlab-ci.yml", "Jenkinsfile", ".circleci/config.yml"]) {
    await assert.rejects(ws!.proposeChange(ask, "CI", [{ path: file, content: "x\n" }], "john"), /controls the repo's CI/, file);
  }
  assert.equal(ws!.isCiPath("src/github.ts"), false);
});

test("without the GitHub App, the agent can't see the code and is told why", options, async () => {
  const ask = await activeAsk();
  const saved = process.env.LETAGENTS_ASK_GIT_BASE_URL;
  delete process.env.LETAGENTS_ASK_GIT_BASE_URL;
  try {
    await assert.rejects(ws!.listFiles(ask, ""), /connect the LetAgents GitHub App/);
    assert.equal(existsSync(workspaceDir(ask.id)), false, "nothing is cloned");
  } finally {
    process.env.LETAGENTS_ASK_GIT_BASE_URL = saved;
  }
});
