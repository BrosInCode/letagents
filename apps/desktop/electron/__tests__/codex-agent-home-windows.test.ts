// The agents' Codex home on a real Windows host: no symbolic link (which
// needs an administrator or Developer Mode), a junction for each folder of the
// owner's home, a hard link for each file, and a `rules` folder nothing can be
// saved into. Off Windows these tests skip; codex-agent-home.test.ts holds the
// POSIX links.
import "./isolated-home.js";
import assert from "node:assert/strict";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("Windows: a link whose owner's file was replaced is linked again while nothing wrote it, and kept or refused once something did", { skip: windowsOnly }, (t) => {
  const { owner, agents, remove } = fixture();
  t.after(remove);
  linkCodexAgentHome(owner, agents);
  const replace = (name: string, content: string) => {
    // Saved as a new file, as an editor saves: the agents' hard link keeps the old one.
    writeFileSync(join(owner, `${name}.new`), content);
    rmSync(join(owner, name));
    writeFileSync(join(owner, name), readFileSync(join(owner, `${name}.new`)));
    rmSync(join(owner, `${name}.new`));
  };
  replace("config.toml", "model = \"newer\"\n");
  replace("auth.json", "{\"tokens\":\"signed in again\"}");
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: [], inPlaceOfOwners: [] });
  assert.ok(sameFile(join(agents, "config.toml"), join(owner, "config.toml")), "the old file is replaced by a link to the new one");
  assert.ok(sameFile(join(agents, "auth.json"), join(owner, "auth.json")), "after a sign-out and sign-in, the new sign-in is linked");

  // Written after it stopped being the owner's: content is never deleted, and a second sign-in stops the launch.
  replace("config.toml", "model = \"newest\"\n");
  appendFileSync(join(agents, "config.toml"), "# the agents' Codex wrote this\n");
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: ["config.toml"], inPlaceOfOwners: ["config.toml"] });
  assert.match(readFileSync(join(agents, "config.toml"), "utf8"), /the agents' Codex wrote this/);
  replace("auth.json", "{\"tokens\":\"third\"}");
  appendFileSync(join(agents, "auth.json"), " ");
  assert.throws(() => linkCodexAgentHome(owner, agents), CodexAgentHomeSignInError);
});

test("Windows: Codex's SQLite databases get no second name, and the agents' own database is neither linked nor reported", { skip: windowsOnly }, (t) => {
  const { owner, agents, remove } = fixture();
  t.after(remove);
  writeFileSync(join(owner, "state_5.sqlite"), "owner database");
  writeFileSync(join(owner, "state_5.sqlite-wal"), "owner journal");
  writeFileSync(join(owner, "logs_1.sqlite"), "owner logs");
  linkCodexAgentHome(owner, agents);
  assert.deepEqual(readdirSync(agents).sort(), ["auth.json", "config.toml", "rules", "sessions"], "no database is linked");
  // The agents' Codex makes its own; the next launch keeps it and says nothing about it.
  writeFileSync(join(agents, "state_5.sqlite"), "agents' database");
  writeFileSync(join(agents, "state_5.sqlite-shm"), "agents' shared memory");
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: [], inPlaceOfOwners: [] });
  assert.equal(readFileSync(join(agents, "state_5.sqlite"), "utf8"), "agents' database");
  assert.equal(readFileSync(join(owner, "state_5.sqlite"), "utf8"), "owner database");
});

test("Windows: a file that is a link in the owner's home is linked as the file it leads to", { skip: windowsOnly }, (t) => {
  const { owner, agents, remove } = fixture();
  t.after(remove);
  const dotfile = join(owner, "..", "dotfiles-config.toml");
  writeFileSync(dotfile, "model = \"from dotfiles\"\n");
  rmSync(join(owner, "config.toml"));
  try {
    symlinkSync(dotfile, join(owner, "config.toml"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("this account may not make a symbolic link"); return; }
    throw error;
  }
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: [], inPlaceOfOwners: [] });
  assert.ok(!lstatSync(join(agents, "config.toml")).isSymbolicLink());
  assert.ok(sameFile(join(agents, "config.toml"), dotfile), "the agents' name is the file the owner's link leads to");
  // Linking again keeps it: it is still the owner's file, not one of the agents' own.
  assert.deepEqual(linkCodexAgentHome(owner, agents), { own: [], inPlaceOfOwners: [] });
});
