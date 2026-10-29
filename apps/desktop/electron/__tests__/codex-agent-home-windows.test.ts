// The agents' Codex home on a real Windows host: no symbolic link (which
// needs an administrator or Developer Mode), a junction for each folder of the
// owner's home, a hard link for each file, and a `rules` folder nothing can be
// saved into. Off Windows these tests skip; codex-agent-home.test.ts holds the
// POSIX links.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAgentHomeSignInError, linkCodexAgentHome } from "../main/agents/codex-agent-home.js";

const windowsOnly = process.platform === "win32" ? false : "a Windows host is needed";

function sameFile(left: string, right: string): boolean {
  const a = lstatSync(left, { bigint: true });
  const b = lstatSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}

function fixture(): { owner: string; agents: string; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-home-windows-"));
  const owner = join(root, "owner-codex");
  mkdirSync(join(owner, "sessions"), { recursive: true });
  mkdirSync(join(owner, "rules"));
  writeFileSync(join(owner, "rules", "default.rules"), "prefix_rule(pattern=[\"git\"], decision=\"allow\")\n");
  writeFileSync(join(owner, "auth.json"), "{\"tokens\":\"before\"}");
  writeFileSync(join(owner, "config.toml"), "model = \"gpt\"\n");
  return { owner, agents: join(root, "agents", "codex-agent-home"), remove: () => rmSync(root, { recursive: true, force: true }) };
}

test("Windows: the agents' home links folders by junction and files by hard link, and leaves the owner's rules out", { skip: windowsOnly }, (t) => {
  const { owner, agents, remove } = fixture();
  t.after(remove);
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: [], inPlaceOfOwners: [] });
  assert.deepEqual(readdirSync(agents).sort(), ["auth.json", "config.toml", "rules", "sessions"]);
  assert.ok(lstatSync(join(agents, "sessions")).isSymbolicLink(), "a junction reads as a link");
  assert.ok(!lstatSync(join(agents, "auth.json")).isSymbolicLink());
  assert.ok(sameFile(join(agents, "auth.json"), join(owner, "auth.json")), "the sign-in is the owner's own file");
  assert.ok(sameFile(join(agents, "config.toml"), join(owner, "config.toml")));
  assert.deepEqual(readdirSync(join(agents, "rules")), [], "the owner's saved rules are not there");

  // A rewrite in place through either name is the other's too: a refreshed token reaches the owner.
  writeFileSync(join(agents, "auth.json"), "{\"tokens\":\"after\"}");
  assert.equal(readFileSync(join(owner, "auth.json"), "utf8"), "{\"tokens\":\"after\"}");
  // A conversation written through the junction is in the owner's folder.
  writeFileSync(join(agents, "sessions", "one.jsonl"), "{}\n");
  assert.deepEqual(readdirSync(join(owner, "sessions")), ["one.jsonl"]);
});

test("Windows: nothing can be saved into the agents' rules folder, and the next launch makes it again", { skip: windowsOnly }, (t) => {
  const { owner, agents, remove } = fixture();
  t.after(remove);
  linkCodexAgentHome(owner, agents);
  assert.throws(() => writeFileSync(join(agents, "rules", "default.rules"), "prefix_rule()\n"), (error: NodeJS.ErrnoException) => error.code === "EPERM" || error.code === "EACCES");
  assert.throws(() => mkdirSync(join(agents, "rules", "nested")), (error: NodeJS.ErrnoException) => error.code === "EPERM" || error.code === "EACCES");
  // Linking again is the same home, and the read-only folder is replaced without trouble.
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: [], inPlaceOfOwners: [] });
  assert.ok(sameFile(join(agents, "auth.json"), join(owner, "auth.json")));
  assert.deepEqual(readdirSync(join(agents, "rules")), []);
});

test("Windows: a sign-in file of the agents' own stops the launch; a file the owner replaced is kept and reported", { skip: windowsOnly }, (t) => {
  const { owner, agents, remove } = fixture();
  t.after(remove);
  linkCodexAgentHome(owner, agents);
  // The owner's config is saved by rename (as an editor does): the agents' hard link keeps the old file.
  writeFileSync(join(owner, "config.toml.new"), "model = \"newer\"\n");
  rmSync(join(owner, "config.toml"));
  writeFileSync(join(owner, "config.toml"), readFileSync(join(owner, "config.toml.new")));
  rmSync(join(owner, "config.toml.new"));
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: ["config.toml"], inPlaceOfOwners: ["config.toml"] });
  assert.equal(readFileSync(join(agents, "config.toml"), "utf8"), "model = \"gpt\"\n", "content is never deleted");

  // The same for the sign-in: a separate file is two sign-ins, and nothing starts.
  rmSync(join(owner, "auth.json"));
  writeFileSync(join(owner, "auth.json"), "{\"tokens\":\"signed in again\"}");
  appendFileSync(join(agents, "auth.json"), " ");
  assert.throws(() => linkCodexAgentHome(owner, agents), CodexAgentHomeSignInError);
});
