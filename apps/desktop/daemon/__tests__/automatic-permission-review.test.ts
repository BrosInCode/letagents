import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomaticPermissionReviewer } from "../automatic-permission-review.js";
import { requestCommandReview } from "../command-review-http.js";
import type { OpenCodeNativePermissionRequest } from "../../shared/provider-permissions.js";
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

test("automatic review applies only to a trusted local Open Model agent whose owner chose Auto", async () => {
  const f = await workspaceFixture();
  try {
    assert.equal(f.reviewer.applies(f.entry), true);
    for (const change of [{ provider: "codex" }, { provider: "claude-code" }, { provider: "cursor" }, { permission_profile_id: "ask_before_write" },
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
      // The whole command looks routine and a parsed part does not.
      [["ls", "git push"], { command: "ls" }],
      [["ls"], {}], [["ls"], { command: 7 }], [["ls"], { command: "" }], [[], { command: "ls" }],
      [[7 as unknown as string], { command: "ls" }],
      [Array.from({ length: 17 }, () => "ls"), { command: "ls" }],
    ] as Array<[string[], Record<string, unknown>]>) {
      assert.equal(await f.review(f.request("bash", patterns, metadata)), "ask", JSON.stringify([patterns, metadata]).slice(0, 120));
    }
    assert.deepEqual(f.asked, [], "a command the rules reserve for a person is sent nowhere");
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
  } finally { await f.close(); }
});
