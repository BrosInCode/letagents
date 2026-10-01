import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { leasedBranchRef } from "../../../../shared/agent-branch.mjs";
import { AutomaticPermissionReviewer } from "../automatic-permission-review.js";
import { requestCommandReview } from "../command-review-http.js";
import type { ClaudeNativePermissionRequest, OpenCodeNativePermissionRequest } from "../../shared/provider-permissions.js";
import type { DaemonManifestEntry } from "../types.js";

async function workspaceFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-auto-review-")));
  // A real workspace is beneath `~/.letagents`. Where it is was not the agent's choice.
  const workspace = join(root, ".letagents", "project");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "package.json"), "{}\n");
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "export {};\n");
  await symlink(join(root, "outside"), join(workspace, "linked"));
  await writeFile(join(root, "outside", "kept.txt"), "kept\n");
  await symlink(join(root, "outside", "kept.txt"), join(workspace, "linked-file.txt"));
  await link(join(root, "outside", "kept.txt"), join(workspace, "second-name.txt"));
  execFileSync("mkfifo", [join(workspace, "pipe")]);
  const entry = { id: "agent", room_id: "room", provider: "open-model", permission_profile_id: "auto_review",
    delivery_mode: "daemon_inbox", workspace_path: workspace } as DaemonManifestEntry;
  const asked: Array<{ commands: readonly string[]; project: string }> = [];
  const verdict = { next: "allow" as "allow" | "ask" | Error };
  const reviewer = new AutomaticPermissionReviewer({
    reviewCommands: async ({ commands, project }) => {
      asked.push({ commands, project });
      if (verdict.next instanceof Error) throw verdict.next;
      return verdict.next;
    },
  });
  const request = (permission: string, patterns: string[], metadata: Record<string, unknown>): OpenCodeNativePermissionRequest =>
    ({ id: "permission", sessionID: "session", permission, patterns, metadata, always: [], tool: { messageID: "message", callID: "call" } });
  const review = (native: OpenCodeNativePermissionRequest, from: DaemonManifestEntry = entry) =>
    reviewer.review({ entry: from, request: native, signal: new AbortController().signal });
  return { root, workspace, entry, asked, verdict, reviewer, request, review, close: () => rm(root, { recursive: true, force: true }) };
}

test("automatic review applies only to a trusted local Open Model agent on Auto, or a Claude agent that asks", async () => {
  const f = await workspaceFixture();
  try {
    assert.equal(f.reviewer.applies(f.entry), true);
    for (const permission_profile_id of ["ask_before_write", "auto_review"]) {
      assert.equal(f.reviewer.applies({ ...f.entry, provider: "claude-code", permission_profile_id }), true, permission_profile_id);
    }
    for (const change of [{ provider: "codex" }, { provider: "cursor" }, { permission_profile_id: "ask_before_write" },
      { provider: "claude-code", permission_profile_id: "read_only" }, { provider: "claude-code", permission_profile_id: "full_access" },
      { provider: "claude-code", delivery_mode: "mcp_polling" }, { provider: "claude-code", id: "supervised_rental_1" },
      { permission_profile_id: "full_access" }, { permission_profile_id: null }, { delivery_mode: "mcp_polling" }, { id: "supervised_rental_1" }]) {
      const other = { ...f.entry, ...change } as DaemonManifestEntry;
      assert.equal(f.reviewer.applies(other), false, JSON.stringify(change));
      assert.equal(await f.review(f.request("bash", ["ls"], { command: "ls" }), other), "ask", JSON.stringify(change));
    }
    assert.equal(f.reviewer.applies(undefined), false);
    for (const workspace_path of [null, undefined, "", "project"]) {
      assert.equal(await f.review(f.request("bash", ["ls"], { command: "ls" }), { ...f.entry, workspace_path } as DaemonManifestEntry), "ask");
    }
    assert.deepEqual(f.asked, []);
  } finally { await f.close(); }
});

test("an edit runs only when every file is an ordinary file inside the project", async () => {
  const f = await workspaceFixture();
  try {
    const inside = join(f.workspace, "src", "a.ts");
    assert.equal(await f.review(f.request("edit", ["src/a.ts"], { filepath: inside, diff: "+x" })), "allow");
    assert.equal(await f.review(f.request("edit", ["src/new/b.ts"], { filepath: join(f.workspace, "src", "new", "b.ts"), diff: "+x" })), "allow");
    // Outside a Git repository OpenCode names the file from the file system root.
    assert.equal(await f.review(f.request("edit", [inside.slice(1)], { filepath: inside, diff: "+x" })), "allow");
    assert.equal(await f.review(f.request("edit", [join(f.workspace, "src", "new", "b.ts").slice(1)], { filepath: join(f.workspace, "src", "new", "b.ts") })), "allow");
    assert.equal(await f.review(f.request("edit", ["docs/My Notes.md"], { filepath: join(f.workspace, "docs", "My Notes.md") })), "allow");
    // A hook has no extension, so source named like one is still the agent's work.
    for (const path of ["src/post-processor.ts", "docs/pre-commit.md", "src/hooks/useCommit.ts", "hooks/pre-commit.test.ts"]) {
      assert.equal(await f.review(f.request("edit", [path], { filepath: join(f.workspace, path), diff: "+x" })), "allow", path);
    }
    // OpenCode always says which file it means a second time. A request that does not is not one this rule knows.
    for (const metadata of [{}, { diff: "+x" }, { filepath: "src/a.ts" }, { filepath: 7 }, { filepath: null }]) {
      assert.equal(await f.review(f.request("edit", ["src/a.ts"], metadata)), "ask", JSON.stringify(metadata));
    }
    // A patch names several files, no single absolute one, and what it does to each.
    const patched = (path: string, type = "update", movePath?: string) => ({ filePath: join(f.workspace, path), relativePath: movePath ?? path,
      type, patch: "+x", additions: 1, deletions: 0, ...(movePath === undefined ? {} : { movePath: join(f.workspace, movePath) }) });
    assert.equal(await f.review(f.request("edit", ["src/a.ts", "README.md"],
      { filepath: "src/a.ts, README.md", diff: "+x", files: [patched("src/a.ts"), patched("README.md", "add")] })), "allow");
    assert.equal(await f.review(f.request("edit", ["src/a.ts"], { filepath: "src/a.ts", diff: "+x", files: [patched("src/a.ts", "move", "src/b.ts")] })), "allow");
    for (const files of [
      // The request names only where the file is now. Where it goes is what matters.
      [patched("src/a.ts", "move", ".git/hooks/pre-commit")], [patched("src/a.ts", "move", ".env")], [patched("src/a.ts", "move", "package.json")],
      [patched("src/a.ts", "move", ".github/workflows/ci.yml")], [patched("src/a.ts", "move", "linked/x")], [patched("src/a.ts", "move", "../outside/x")],
      [patched("src/a.ts", "move", "second-name.txt")],
      [{ ...patched("src/a.ts", "move", "src/b.ts"), movePath: join(f.root, "outside", "x") }], [{ ...patched("src/a.ts", "move", "src/b.ts"), movePath: "src/b.ts" }],
      [patched("src/a.ts", "move")], [{ ...patched("src/a.ts"), movePath: 7 }],
      // Removing a file, or a kind of change this rule does not know.
      [patched("src/a.ts", "delete")], [patched("src/a.ts", "rename")], [{ ...patched("src/a.ts"), type: undefined }],
      // The list does not say the same thing as the request.
      [patched("src/b.ts")], [patched("src/a.ts"), patched("src/b.ts")], [], [{ ...patched("src/a.ts"), filePath: "src/a.ts" }], [null], ["src/a.ts"],
      "src/a.ts", { 0: patched("src/a.ts"), length: 1 },
    ]) {
      assert.equal(await f.review(f.request("edit", ["src/a.ts"], { filepath: "src/a.ts", diff: "+x", files })), "ask", JSON.stringify(files).slice(0, 140));
    }

    // Each request says its file twice, as OpenCode does, so the name alone is what refuses it.
    const named = (patterns: string[]): Record<string, unknown> => patterns.length === 1 && typeof patterns[0] === "string"
      ? { filepath: patterns[0].startsWith(f.root.slice(1)) ? `/${patterns[0]}` : `${f.workspace}/${patterns[0]}`, diff: "+x" }
      : { filepath: patterns.join(", "), diff: "+x", files: patterns.map((path) => ({ filePath: `${f.workspace}/${path}`, type: "update" })) };
    assert.equal(await f.review(f.request("edit", ["src/a.ts"], named(["src/a.ts"]))), "allow");
    assert.equal(await f.review(f.request("edit", ["src/a.ts", "src/b.ts"], named(["src/a.ts", "src/b.ts"]))), "allow");
    for (const patterns of [
      ["../outside/x"], [join(f.root, "outside", "x").slice(1)], ["src/../../outside/x"], [join(f.root, "outside", "x")], [inside],
      [join(f.workspace, ".env").slice(1)], [join(f.workspace, "package.json").slice(1)], [join(f.workspace, ".git", "config").slice(1)],
      [join(f.workspace, "linked", "x").slice(1)], ["linked/x"],
      // A link to a file, a second name for a file that also lives outside, and a folder.
      ["linked-file.txt"], ["second-name.txt"], ["src"],
      // Something that is not a file: what is written to it goes to whatever reads it.
      ["pipe"],
      [".env"], [".env.local"], ["config/.env"], [".git/config"], [".git/hooks/pre-commit"],
      ["secrets/prod.json"], ["deploy/id_rsa"], ["certs/server.pem"], [".npmrc"], [".ssh/config"],
      ["src/a.ts", ".env"], ["src/a.ts", "src/A.ts"],
      // Files that say what the agent may do, or what a command allowed by name will run.
      ["AGENTS.md"], ["docs/AGENTS.md"], ["CLAUDE.md"], ["CONTEXT.md"], ["opencode.json"], ["opencode.jsonc"], [".opencode/agent/x.md"],
      [".claude/settings.json"], [".codex/hooks.json"], [".cursor/rules/x.mdc"], [".cursorrules"], [".agents/skills/x/SKILL.md"], [".gemini/settings.json"],
      [".mcp.json"], [".letagents.json"], [".letagents-work-attempt.json"], [".letagents/x"],
      [".github/workflows/ci.yml"], [".GitHub/workflows/ci.yml"], [".gitlab-ci.yml"], [".circleci/config.yml"], [".husky/pre-commit"],
      [".githooks/pre-push"], [".pre-commit-config.yaml"], ["lefthook.yml"], ["lefthook.yaml"], ["lefthook-local.yml"], [".gitattributes"], [".gitmodules"], [".gitignore"], [".envrc"],
      [".vscode/tasks.json"], [".devcontainer/devcontainer.json"],
      ["jest.config.js"], ["vitest.config.ts"], ["vitest.workspace.ts"], ["eslint.config.mjs"], ["web/vite.config.ts"],
      [".eslintrc.js"], [".mocharc.js"], [".yarnrc.yml"], [".pnpmfile.cjs"], [".cargo/config.toml"],
      ["tsconfig.json"], ["tsconfig.build.json"], ["tsconfig.build.prod.json"], ["babel.config.json"], ["jest.config.json"], ["pnpm-workspace.yaml"], ["web/TSConfig.json"], ["jsconfig.json"], ["go.mod"],
      ["node_modules/.bin/tsc"], ["node_modules/typescript/lib/tsc.js"], ["web/node_modules/x/index.js"],
      ["conftest.py"], ["tests/conftest.py"], ["pyproject.toml"], ["Cargo.toml"], ["build.rs"],
      ["package.json"], ["Package.JSON"], ["packages/web/package.json"], ["Makefile"], ["makefile"], ["GNUmakefile"], ["build/rules.mk"],
      ["justfile"], ["Taskfile.yml"], ["src/a.ts", "package.json"],
      // A Git hook by name, in whatever folder `core.hooksPath` may name.
      ["githooks/pre-commit"], ["hooks/pre-push"], ["scripts/commit-msg"], ["pre-commit"], ["tools/git/post-checkout"], ["hooks/post-merge"],
      ["hooks/prepare-commit-msg"], ["hooks/reference-transaction"], ["hooks/fsmonitor-watchman"], ["hooks/Pre-Commit"],
      // A name macOS opens as another name: a long s, a sharp s, a ligature, a wide letter, a mark added to a letter.
      [".\u1e9eh/config"], ["package.j\u017fon"], ["AGENT\u017f.md"], [".mcp.j\u017fon"], ["opencode.j\u017fon"], ["Make\ufb01le"], ["vite.con\ufb01g.ts"], ["ju\ufb06file"],
      ["\u017fetup.py"], ["\u017fecrets/prod.json"], [".\u017f\u017fh/config"], [".\u00dfh/config"], ["\uff50ackage.json"], ["package.json\u200b"],
      ["src/caf\u00e9.ts"], ["src/cafe\u0301.ts"], ["src/\u202ea.ts"],
      // A name with a space or a dot at its end, a control character, or no name at all.
      ["package.json "], [" package.json"], ["package.json."], ["src/a.ts\u0000"], ["src/a\n.ts"], ["src/a\u007f.ts"],
      [], [""], ["src//a.ts"], ["./src/a.ts"], ["src\\a.ts"], ["src/"],
      Array.from({ length: 65 }, (_, index) => `src/f${index}.ts`),
      [7 as unknown as string],
    ] as string[][]) {
      assert.equal(await f.review(f.request("edit", patterns, named(patterns))), "ask", JSON.stringify(patterns).slice(0, 120));
    }
    // The named file is not the file the request lists.
    for (const [patterns, metadata] of [
      [[inside.slice(1)], { filepath: join(f.workspace, "src", "b.ts") }],
      [["src/a.ts"], { filepath: join(f.workspace, "src", "b.ts") }],
      [["src/a.ts"], { filepath: join(f.workspace, "package.json") }],
      [["src/a.ts"], { filepath: join(f.root, "outside", "a.ts") }],
      [["src/a.ts"], { filepath: "/etc/hosts" }],
      [["etc/hosts"], { filepath: "/etc/hosts" }],
      [["src/a.ts", "src/b.ts"], { filepath: inside }],
    ] as Array<[string[], Record<string, unknown>]>) {
      assert.equal(await f.review(f.request("edit", patterns, metadata)), "ask", JSON.stringify([patterns, metadata]).slice(0, 120));
    }
    assert.deepEqual(f.asked, [], "an edit is decided on this machine and sent nowhere");
  } finally { await f.close(); }
});

test("a command is reviewed by the server only after the fixed rules pass on every reading of it", async () => {
  const f = await workspaceFixture();
  try {
    assert.equal(await f.review(f.request("bash", ["npm test"], { command: "npm test" })), "allow");
    assert.equal(await f.review(f.request("bash", ["git status", "git diff"], { command: "git status && git diff" })), "allow");
    assert.deepEqual(f.asked, [
      { commands: ["npm test"], project: f.workspace },
      { commands: ["git status && git diff"], project: f.workspace },
    ]);
    f.verdict.next = "ask";
    assert.equal(await f.review(f.request("bash", ["npm test"], { command: "npm test" })), "ask");
    f.verdict.next = new Error("server unreachable");
    assert.equal(await f.review(f.request("bash", ["npm test"], { command: "npm test" })), "ask");

    f.verdict.next = "allow";
    f.asked.length = 0;
    for (const [patterns, metadata] of [
      [["git push"], { command: "git push" }],
      [["rm -rf build"], { command: "rm -rf build" }],
      [["cat .env"], { command: "cat .env" }],
      [["ls .."], { command: "ls .." }],
      [["cat /etc/passwd"], { command: "cat /etc/passwd" }],
      [["curl https://example.com"], { command: "curl https://example.com" }],
      // The parsed parts look routine and the whole command does not.
      [["ls"], { command: "ls; rm -rf build" }],
      [["ls"], { command: "cd /tmp && ls" }],
      // The whole command looks routine and a parsed part does not, or is not in it.
      [["ls", "git push"], { command: "ls" }],
      [["ls", "git push origin HEAD"], { command: "ls" }], [["git status"], { command: "ls" }], [["ls -la"], { command: "ls" }],
      [["ls"], {}], [["ls"], { command: 7 }], [["ls"], { command: "" }], [[], { command: "ls" }],
      [[7 as unknown as string], { command: "ls" }],
      [Array.from({ length: 17 }, () => "ls"), { command: "ls" }],
    ] as Array<[string[], Record<string, unknown>]>) {
      assert.equal(await f.review(f.request("bash", patterns, metadata)), "ask", JSON.stringify([patterns, metadata]).slice(0, 120));
    }
    assert.deepEqual(f.asked, [], "a command the rules reserve for a person is sent nowhere");
  } finally { await f.close(); }
});

const AGENT_KEY = "Owner/desktop-open-model-0123";
const own = (task: string) => leasedBranchRef(task, AGENT_KEY);
/** The parts of a command as OpenCode lists them: each simple command's words, without its redirects. */
const parts = (command: string) => command.split(/\s*(?:&&|\|\||;|\||\n)\s*/).map((part) => part.replace(/\s*2>&1/g, "").trim()).filter(Boolean);
/** Run a command as the agent would, with a fixed test identity. */
const sh = (cwd: string, command: string) => execFileSync("/bin/sh", ["-c", command], { cwd, stdio: "pipe", env: { ...process.env,
  GIT_AUTHOR_NAME: "QA", GIT_AUTHOR_EMAIL: "qa@example.test", GIT_COMMITTER_NAME: "QA", GIT_COMMITTER_EMAIL: "qa@example.test" } }).toString();

/** A project cloned from a bare `origin` whose default branch is `main`, as LetAgents prepares one. */
async function repositoryFixture(f: Awaited<ReturnType<typeof workspaceFixture>>, agentKey: string | null = AGENT_KEY) {
  const origin = join(f.root, "origin.git");
  const workspace = join(f.root, "repository");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", workspace]);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "export {};\n");
  sh(workspace, `git add src/a.ts && git commit -qm init && git remote add origin ${origin} && git push -q origin main && git fetch -q origin`
    + " && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
  const entry = { ...f.entry, workspace_path: workspace } as DaemonManifestEntry;
  const asked: string[][] = [];
  const verdict = { next: "allow" as "allow" | "ask" };
  const reviewer = new AutomaticPermissionReviewer({ agentKey: () => agentKey,
    reviewCommands: async ({ commands }) => { asked.push([...commands]); return verdict.next; } });
  const review = (command: string, patterns = parts(command), from = entry) =>
    reviewer.review({ entry: from, request: f.request("bash", patterns, { command }), signal: new AbortController().signal });
  const edit = (relative: string) => reviewer.review({ entry, request: f.request("edit", [relative], { filepath: join(workspace, relative) }),
    signal: new AbortController().signal });
  return { origin, workspace, entry, asked, verdict, review, edit, originLog: (branch: string) => sh(origin, `git log -1 --format=%s ${branch}`).trim() };
}

test("routine work on the agent's own branches runs without review, and anything else asks", async () => {
  const f = await workspaceFixture();
  try {
    const r = await repositoryFixture(f);
    for (const command of [
      `git add src/a.ts tests/a.test.ts && git commit -m 'Add a' && git push -u origin HEAD:${own("task_1")}`,
      `git add -u && git commit -q -m "Fix a" && git push origin HEAD:refs/heads/${own("task_1")} 2>&1`,
      `git push origin ${own("task_1")}:${own("task_1")}`, `git push --set-upstream -q origin HEAD:${own("task_9")}`, "git commit --amend --no-edit",
      "git fetch origin main -q && git merge origin/main --no-edit", "git fetch origin --quiet", "git merge -m 'Merge main' origin/main",
      `git merge origin/${own("task_2")}`, `git switch ${own("task_2")}`, `git switch -c ${own("task_3")} -q`,
      `git checkout -b ${own("task_2")} origin/main && git add src/a.ts && git commit -m 'Start' && git push -u origin HEAD:${own("task_2")}`,
    ]) assert.equal(await r.review(command), "allow", command);
    for (const [command, patterns] of [
      ["gh pr view 6 --json state,reviews --jq '.reviews[] | .state'", ["gh pr view 6 --json state,reviews --jq '.reviews[] | .state'"]],
      ["gh pr view --comments", ["gh pr view --comments"]], ["gh pr checks 6", ["gh pr checks 6"]], ["gh pr diff 6 --name-only", ["gh pr diff 6 --name-only"]],
      ["gh pr list --state open --json number,title --label bug", ["gh pr list --state open --json number,title --label bug"]],
      ["gh issue view 3 -c", ["gh issue view 3 -c"]], [`gh pr view ${own("task_1")} -q .state`, [`gh pr view ${own("task_1")} -q .state`]],
    ] as Array<[string, string[]]>) assert.equal(await r.review(command, patterns), "allow", command);
    assert.deepEqual(r.asked, [], "routine work the rules decide alone is sent nowhere");

    for (const command of [
      // A push that does not name its destination goes wherever the checked out branch, its upstream, or a setting says.
      "git push", "git push origin", "git push origin HEAD", "git push -u origin HEAD", `git push origin ${own("task_1")}`,
      // Somewhere else.
      "git push upstream HEAD:" + own("task_1"), "git push origin HEAD:main", "git push origin HEAD:refs/heads/main",
      `git push origin HEAD:refs/tags/${own("task_1")}`, `git push origin HEAD:${leasedBranchRef("task_1", "Owner/other")}`,
      `git push origin HEAD:letagents/task_1/${own("task_1").split("/")[2]}/x`,
      // Force, deletion, tags, and skipped hooks.
      `git push --force origin HEAD:${own("task_1")}`, `git push -f origin HEAD:${own("task_1")}`, `git push origin +HEAD:${own("task_1")}`,
      `git push --force-with-lease origin HEAD:${own("task_1")}`, `git push origin :${own("task_1")}`, `git push --delete origin ${own("task_1")}`,
      `git push --tags origin HEAD:${own("task_1")}`, `git push --no-verify origin HEAD:${own("task_1")}`,
      // Another branch, or a file or folder that `git checkout` would restore.
      `git checkout ${own("task_1")}`, `git checkout -q ${own("task_1")}`, "git checkout main", "git switch main", "git checkout -b feature",
      "git switch -c feature", `git checkout -B ${own("task_1")}`, "git checkout src/a.ts", "git checkout -- src/a.ts", "git checkout .",
      `git checkout --detach ${own("task_1")}`,
      // A merge or new branch from a branch no one reviewed may bring in settings and hooks.
      "git merge origin/feature", `git merge origin/${leasedBranchRef("task_1", "Owner/other")}`, `git checkout -b ${own("task_2")} origin/feature`,
      "git merge main", `git checkout -b ${own("task_2")} main`,
      `git switch -c ${own("task_2")} origin/feature`, "git merge FETCH_HEAD", "git merge -s ours origin/main", "git merge --abort",
      // Files a folder, a pattern, or a setting may hold beyond what the agent wrote.
      "git add .", "git add -A", "git add --all", "git add src", "git add .env", "git add src/.env.local", "git add -f src/a.ts", "git add ../x.ts",
      "git add .github/workflows/ci.yml", "git add secrets.json", "git add package.json -p", "git add '*.env'", "git add 'src/*.ts'",
      "git add ':!src/a.ts'", "git add :/src/a.ts", "git add 'src/[a].ts'", "git add src//a.ts", "git add src/a.ts/",
      // A commit that opens an editor, names someone, skips its hooks, or changes what Git runs.
      "git commit", "git commit --amend", "git commit -m 'x' --author='A <a@example.com>'", "git commit -F msg.txt", "git commit --no-verify -m x",
      "git -c user.name=A -c user.email=1+a@users.noreply.github.com commit -m x", "git -c core.hooksPath=/tmp commit -m x", "git commit -am x",
      // Code from a pull request or another remote, and history rewritten.
      "git fetch origin pull/2/head:pr2", "git fetch origin pull/2/head", "git fetch upstream", "git fetch", "git fetch --upload-pack=x origin",
      "git reset --hard origin/main", "git rebase origin/main", "git branch -D x", "git branch -m x", "git stash", "rm -rf src tests && ls",
      // GitHub writes, another repository, a search that can leave this one, the browser, and filters that read the environment.
      "gh pr create --fill", "gh pr merge 5 --merge", "gh pr comment 6 --body x", "gh pr edit 6 --body x", "gh pr checkout 6", "gh pr close 6",
      "gh pr view 6 --web", "gh pr view 6 -R other/repo", "gh pr view 6 --repo other/repo", "gh api repos/x/y/pulls", "gh auth status", "gh auth token",
      "gh pr view 6 --jq '$ENV'", "gh pr view 6 --jq env.GH_TOKEN", "gh pr view 6 -q 'input'", "gh pr view https://github.com/x/y/pull/1",
      "gh issue view", "gh issue create --title x", "gh pr view 6 7", "gh pr list --search 'repo:victim/private) OR (repo:victim/private'",
      "gh issue list -S 'is:private) OR (is:private'",
    ]) assert.equal(await r.review(command), "ask", command);
    // A part OpenCode found that the rules did not is never decided as if it were not there.
    for (const [command, patterns] of [["git status", ["git status", `git push origin HEAD:${own("task_1")}`]], ["ls", ["ls", "git add src/a.ts"]],
      ["git add src/a.ts", ["git add src/a.ts", "gh pr merge 1"]]] as Array<[string, string[]]>) {
      assert.equal(await r.review(command, patterns), "ask", JSON.stringify(patterns));
    }
    assert.deepEqual(r.asked, []);
  } finally { await f.close(); }
});

test("without the agent's key nothing is its own, and without origin's default branch nothing else is a base", async () => {
  const f = await workspaceFixture();
  try {
    const keyless = await repositoryFixture(f, null);
    for (const command of [`git push origin HEAD:${own("task_1")}`, `git switch ${own("task_1")}`, `git checkout -b ${own("task_1")}`]) {
      assert.equal(await keyless.review(command), "ask", command);
    }
    assert.equal(await keyless.review("git add src/a.ts && git commit -m x && git merge origin/main"), "allow");
    sh(keyless.workspace, "git symbolic-ref --delete refs/remotes/origin/HEAD");
    assert.equal(await keyless.review("git merge origin/main"), "ask");
    // A linked worktree reads origin's default branch from the repository it shares.
    sh(keyless.workspace, "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
    const linked = join(f.root, "worktree");
    sh(keyless.workspace, `git worktree add -q -b ${own("task_5")} ${linked}`);
    const fromLinked = { ...keyless.entry, workspace_path: linked } as DaemonManifestEntry;
    assert.equal(await keyless.review("git merge origin/main", ["git merge origin/main"], fromLinked), "allow");
    assert.equal(await keyless.review("git merge origin/feature", ["git merge origin/feature"], fromLinked), "ask");
  } finally { await f.close(); }
});

test("a folder named like the agent's branch cannot make a push from main go to origin's main", async () => {
  const f = await workspaceFixture();
  try {
    const r = await repositoryFixture(f);
    r.verdict.next = "ask";
    const decoy = `${own("t1")}/note.txt`;
    // The edits and the commit are routine and run on main without asking.
    assert.equal(await r.edit("src/a.ts"), "allow");
    await writeFile(join(r.workspace, "src", "a.ts"), "export const change = 1;\n");
    assert.equal(await r.edit(decoy), "allow");
    await mkdir(join(r.workspace, own("t1")), { recursive: true });
    await writeFile(join(r.workspace, decoy), "x\n");
    const stage = `git add src/a.ts ${decoy} && git commit -m 'Change main'`;
    assert.equal(await r.review(stage), "allow");
    sh(r.workspace, stage);
    // `git checkout` restores the folder and stays on main, so neither it nor a push of `HEAD` alone is decided by rule.
    for (const command of [`git checkout ${own("t1")} && git push origin HEAD`, `git checkout ${own("t1")}`, "git push origin HEAD"]) {
      assert.equal(await r.review(command), "ask", command);
    }
    // The push the rules allow names its destination, so from main it still lands on the agent's branch.
    const push = `git push origin HEAD:${own("t1")}`;
    assert.equal(await r.review(push), "allow");
    sh(r.workspace, push);
    assert.equal(r.originLog("main"), "init");
    assert.equal(r.originLog(own("t1")), "Change main");
    assert.deepEqual(r.asked, []);
  } finally { await f.close(); }
});

test("an upstream or push setting cannot send the agent's push to origin's main", async () => {
  const f = await workspaceFixture();
  try {
    const r = await repositoryFixture(f);
    sh(r.workspace, "git config push.default upstream");
    await writeFile(join(r.workspace, "src", "a.ts"), "export const work = 1;\n");
    // `checkout -b <own> origin/main` makes origin's main the upstream, where a push without a destination goes.
    const start = `git checkout -b ${own("t2")} origin/main && git add src/a.ts && git commit -m 'Agent work'`;
    assert.equal(await r.review(`${start} && git push origin ${own("t2")}`), "ask");
    assert.equal(await r.review(`${start} && git push origin HEAD`), "ask");
    const allowed = `${start} && git push -u origin HEAD:${own("t2")}`;
    assert.equal(await r.review(allowed), "allow");
    sh(r.workspace, allowed);
    assert.equal(r.originLog("main"), "init", "origin's main did not move");
    assert.equal(r.originLog(own("t2")), "Agent work");
    // A push setting that sends the current branch to main does not apply to a push that names its destination.
    sh(r.workspace, "git config remote.origin.push HEAD:refs/heads/main && git commit -q --allow-empty -m 'More work'");
    sh(r.workspace, `git push origin HEAD:${own("t2")}`);
    assert.equal(r.originLog("main"), "init");
    assert.equal(r.originLog(own("t2")), "More work");
  } finally { await f.close(); }
});

test("only the reading and checking parts of routine work go to the server, each as written", async () => {
  const f = await workspaceFixture();
  try {
    const r = await repositoryFixture(f);
    const command = `git add src/a.ts && git commit -m 'Add a' && npm test 2>&1 | tail -5 && git push origin HEAD:${own("task_1")}; git log --format='%h %an' -1`;
    assert.equal(await r.review(command), "allow");
    assert.deepEqual(r.asked, [["npm test 2>&1", "tail -5", "git log --format='%h %an' -1"]]);
    r.verdict.next = "ask";
    assert.equal(await r.review(command), "ask");
    // A command the rules decide no part of is reviewed whole, as before.
    r.asked.length = 0;
    assert.equal(await r.review("git status && npm test"), "ask");
    assert.deepEqual(r.asked, [["git status && npm test"]]);
    r.asked.length = 0;
    // A part that runs what a pipe gives it is never split off and sent alone.
    for (const command of ["git add src/a.ts && echo x | npm test", "git commit -m x && cat a.js | node"]) {
      assert.equal(await r.review(command), "ask", command);
    }
    assert.deepEqual(r.asked, []);
  } finally { await f.close(); }
});
test("a Claude command that only reads runs, and everything else Claude asked about still asks", async () => {
  const f = await workspaceFixture();
  try {
    execFileSync("git", ["init", "-q", "-b", "main", f.workspace]);
    const signal = new AbortController().signal;
    const bash = (command: unknown, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}): ClaudeNativePermissionRequest =>
      ({ id: "request", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tool",
        input: { command, description: "Inspect the project", ...input }, decision_reason: "Contains shell syntax that cannot be statically analyzed", ...extra } });
    for (const permission_profile_id of ["ask_before_write", "auto_review"]) {
      const claude = { ...f.entry, provider: "claude-code", permission_profile_id } as DaemonManifestEntry;
      const review = (request: ClaudeNativePermissionRequest) => f.reviewer.review({ entry: claude, request, signal });
      for (const command of [
        `ls -la ${f.workspace} && git log --oneline -5 && git status`, `ls -la ${f.workspace} && git -C ${f.workspace} log --oneline -5 && git -C ${f.workspace} status -sb`, "git status --short; echo '---branches---'; git branch -a",
        "git status --short && echo '---' && sed -n '255,300p' src/a.ts", "git log -1 --format='%an <%ae>' && git log --oneline | head -5",
        "gh pr view 8 --json number,headRefOid,mergeable,state", "grep -rn foo src | head -20", "cat src/a.ts | wc -l",
      ]) {
        assert.equal(await review(bash(command)), "allow", command);
        assert.equal(await review(bash(command, {}, { timeout: 60_000 })), "allow", command);
      }
      for (const request of [
        // Claude named a path outside the project, or the command runs in another folder.
        bash("sed -n '255,300p' src/app.mjs", { blocked_path: "/private/tmp/ft-qa" }), bash("cd /tmp/ft-qa && sed -n '255,300p' src/app.mjs"),
        bash("cat /tmp/tide-shots/dark.png"), bash("cd src && git log"), bash("git -C src log --oneline"), bash("git -C /tmp/ft-qa log -1 --oneline"), bash("ls ~/.claude/projects"),
        // A background job, a redirect that writes, or a command that writes or runs the project's code.
        bash("ls &"), bash("ls > out.txt"), bash("node --test"), bash("npm test"), bash("node --check src/a.ts"), bash("git add src/a.ts"),
        bash("git push origin HEAD"), bash("rm -rf src"), bash("cat .env"), bash("env"),
        // A read joined to a write still writes.
        bash("gh pr view 8 --json state && gh pr comment 8 --body-file /tmp/c.md"), bash("git status && git commit -m x"),
        bash("ls", {}, { run_in_background: true }), bash("ls", {}, { dangerouslyDisableSandbox: true }), bash(7), bash(""),
        { id: "request", request: { subtype: "can_use_tool", tool_name: "Read", tool_use_id: "tool", input: { file_path: "/tmp/tide-shots/dark.png" } } },
        { id: "request", request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tool", input: { file_path: join(f.workspace, "src", "a.ts"), content: "x" } } },
        { id: "request", request: { subtype: "can_use_tool", tool_name: "bash", tool_use_id: "tool", input: { command: "ls" } } },
        { id: "request", request: { subtype: "other", tool_name: "Bash", tool_use_id: "tool", input: { command: "ls" } } },
        { id: "request" } as unknown as ClaudeNativePermissionRequest,
      ] as ClaudeNativePermissionRequest[]) {
        assert.equal(await review(request), "ask", JSON.stringify(request).slice(0, 160));
      }
    }
    // An Open Model request is never read as Claude's, nor the other way round.
    assert.equal(await f.review(bash("ls") as never), "ask");
    assert.equal(await f.reviewer.review({ entry: { ...f.entry, provider: "claude-code", permission_profile_id: "ask_before_write" } as DaemonManifestEntry,
      request: f.request("bash", ["ls"], { command: "ls" }), signal }), "ask");
    assert.deepEqual(f.asked, [], "a Claude command is decided on this machine and sent nowhere");
  } finally { await f.close(); }
});

test("every other kind of request is left for a person", async () => {
  const f = await workspaceFixture();
  try {
    const edit = { filepath: join(f.workspace, "src", "a.ts"), diff: "+x" };
    // Both requests would be allowed if they were what they look like.
    assert.equal(await f.review(f.request("edit", ["src/a.ts"], edit)), "allow");
    assert.equal(await f.review(f.request("bash", ["ls"], { command: "ls" })), "allow");
    f.asked.length = 0;
    for (const permission of ["external_directory", "webfetch", "websearch", "read", "task", "skill", "doom_loop", "", "BASH", "Edit", "bash ", "edit\n"]) {
      assert.equal(await f.review(f.request(permission, ["src/a.ts"], edit)), "ask", permission);
      assert.equal(await f.review(f.request(permission, ["ls"], { command: "ls" })), "ask", permission);
    }
    assert.deepEqual(f.asked, []);
  } finally { await f.close(); }
});

async function withFetch<T>(respond: (url: string, init: RequestInit) => Response | Promise<Response>, run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

const reviewInput = () => ({ apiOrigin: "https://letagents.example", grantId: "grant/1", supervisorGrant: "grant-secret", grantGeneration: 3,
  roomId: "room", commands: ["npm test"], project: "/Users/dev/shop-api", signal: new AbortController().signal });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the review request carries the grant and exactly the commands, project, and room", async () => {
  await withFetch(() => json({ decision: "allow", reason: "reviewed" }), async (calls) => {
    assert.equal(await requestCommandReview(reviewInput()), "allow");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://letagents.example/supervisor-host-grants/grant%2F1/command-reviews");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(calls[0]!.init.redirect, "error");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer grant-secret");
    assert.equal(headers["x-letagents-supervisor-generation"], "3");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { room_id: "room", commands: ["npm test"], project: "/Users/dev/shop-api" });
  });
});

test("only the exact reviewed allowance allows, and every other answer asks a person", async () => {
  for (const response of [
    () => json({ decision: "ask", reason: "reviewed" }),
    () => json({ decision: "allow", reason: "needs_person" }),
    () => json({ decision: "allow", reason: "unavailable" }),
    () => json({ decision: "allow" }),
    () => json({ decision: "allow", reason: "reviewed", extra: true }),
    () => json({ decision: "ALLOW", reason: "reviewed" }),
    () => json({ decision: true, reason: "reviewed" }),
    () => json(["allow"]), () => json("allow"), () => json(null),
    () => json({ decision: "allow", reason: "reviewed" }, 403),
    () => json({ decision: "allow", reason: "reviewed" }, 409),
    () => json({ decision: "allow", reason: "reviewed" }, 500),
    () => new Response("allow", { status: 200 }),
    () => { throw new Error("network down"); },
  ]) {
    await withFetch(response, async () => assert.equal(await requestCommandReview(reviewInput()), "ask"));
  }
  for (const change of [{ apiOrigin: "http://letagents.example" }, { apiOrigin: "https://letagents.example/path" }, { grantGeneration: 0 }, { grantGeneration: 1.5 }]) {
    await withFetch(() => json({ decision: "allow", reason: "reviewed" }), async (calls) => {
      assert.equal(await requestCommandReview({ ...reviewInput(), ...change }), "ask", JSON.stringify(change));
      assert.equal(calls.length, 0, "an origin or generation that cannot be trusted is never contacted");
    });
  }
});

test("the daemon's reviewer asks the server only under the agent's own current authority", async () => {
  const f = await workspaceFixture();
  try {
    const { createAutomaticPermissionReviewer } = await import("../automatic-permission-review.js");
    const expiresAt = new Date(Date.parse("2026-09-29T00:00:00Z") + 60_000).toISOString();
    const grant = { entryId: "agent", roomId: "room", agentKey: "agent-key", grantId: "grant", supervisorGrant: "grant-secret", grantGeneration: 2,
      apiUrl: "https://letagents.example", daemonGeneration: 7, hostId: "host", installationId: "install", ownerAccountId: "owner", expiresAt };
    const worker = { entryId: "agent", daemonGeneration: 7, grantId: "grant", grantGeneration: 2, roomId: "room", agentKey: "agent-key",
      apiUrl: "https://letagents.example", agentSessionId: "session",
      agentSession: { room_id: "room", agent_key: "agent-key", session_id: "session", agent_instance_id: "daemon:agent", session_kind: "worker", ended_at: null } };
    const state = { grant: grant as unknown, worker: worker as unknown, generation: 7, closing: false };
    const sent: unknown[] = [];
    const reviewer = createAutomaticPermissionReviewer({
      custody: { hostGrant: () => state.grant, workerAuthorization: () => state.worker } as never,
      daemonGeneration: () => state.generation, isClosing: () => state.closing, nowMs: () => Date.parse("2026-09-29T00:00:00Z"),
      requestReview: async (input) => { const { signal: _signal, ...rest } = input; sent.push(rest); return "allow"; },
    });
    const review = () => reviewer.review({ entry: f.entry, request: f.request("bash", ["npm test"], { command: "npm test" }), signal: new AbortController().signal });
    assert.equal(await review(), "allow");
    assert.deepEqual(sent, [{ apiOrigin: "https://letagents.example", grantId: "grant", supervisorGrant: "grant-secret", grantGeneration: 2,
      roomId: "room", commands: ["npm test"], project: f.workspace }]);

    sent.length = 0;
    for (const change of [
      () => { state.closing = true; }, () => { state.generation = 8; }, () => { state.grant = undefined; }, () => { state.worker = undefined; },
      () => { state.grant = { ...grant, expiresAt: "2026-09-28T00:00:00Z" }; }, () => { state.grant = { ...grant, roomId: "other" }; },
      () => { state.worker = { ...worker, grantGeneration: 1 }; }, () => { state.worker = { ...worker, agentSession: { ...worker.agentSession, ended_at: "2026-09-28T00:00:00Z" } }; },
      () => { state.grant = { ...grant, apiUrl: "http://letagents.example" }; state.worker = { ...worker, apiUrl: "http://letagents.example" }; },
    ]) {
      Object.assign(state, { grant, worker, generation: 7, closing: false });
      change();
      assert.equal(await review(), "ask", change.toString());
    }
    assert.deepEqual(sent, [], "without current authority the server is never asked");

    // The agent's own branches are named for its key while it has current authority.
    Object.assign(state, { grant, worker, generation: 7, closing: false });
    const command = `git push origin HEAD:${leasedBranchRef("task_1", "agent-key")}`;
    const push = () => reviewer.review({ entry: f.entry, request: f.request("bash", [command], { command }), signal: new AbortController().signal });
    assert.equal(await push(), "allow");
    state.grant = undefined;
    assert.equal(await push(), "ask");
    Object.assign(state, { grant: { ...grant, roomId: "other" }, worker: { ...worker, roomId: "other", agentSession: { ...worker.agentSession, room_id: "other" } } });
    assert.equal(await push(), "ask");
    assert.deepEqual(sent, []);
  } finally { await f.close(); }
});
