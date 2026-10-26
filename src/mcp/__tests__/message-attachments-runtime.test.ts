import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertMessageFileAttachmentsAvailable,
  pinAttachmentWorkingFolder,
  resolveAttachmentWorkspace,
} from "../server/runtime/message-attachments.js";
import { runInSessionScope, type McpSessionScope } from "../server/runtime/session-scope.js";

function remoteScope(): McpSessionScope {
  return {
    sessionId: "session-test", accountId: "acct", agentInstanceId: "instance-test", clientName: "Claude",
    publicBaseUrl: "https://letagents.chat",
    dispatch: async () => { throw new Error("no API in this test"); },
    state: { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} },
    dirty: false, memory: new Map(), persist: async () => undefined,
  };
}

test("file attachments are refused where this process cannot read the agent's files", () => {
  assert.doesNotThrow(() => assertMessageFileAttachmentsAvailable());
  runInSessionScope(remoteScope(), () => {
    assert.throws(() => assertMessageFileAttachmentsAvailable(), /remote LetAgents MCP endpoint cannot read files/);
  });
  const prior = process.env.LETAGENTS_EXECUTION_PROFILE;
  try {
    for (const profile of ["supervised_room_turn", "supervised_mcp_polling"]) {
      process.env.LETAGENTS_EXECUTION_PROFILE = profile;
      assert.throws(() => assertMessageFileAttachmentsAvailable(), /set_reply_attachments/, profile);
    }
  } finally {
    if (prior === undefined) delete process.env.LETAGENTS_EXECUTION_PROFILE;
    else process.env.LETAGENTS_EXECUTION_PROFILE = prior;
  }
});

/** Run `check` with HOME (USERPROFILE on Windows) set to `home`, and the server pinned to `folder` as it starts. */
async function startedIn(home: string, folder: string, check: () => Promise<void>): Promise<void> {
  const prior = { cwd: process.cwd(), HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.chdir(folder);
    pinAttachmentWorkingFolder();
    await check();
  } finally {
    process.chdir(prior.cwd);
    for (const name of ["HOME", "USERPROFILE"] as const) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
}

test("the workspace is the checkout around the start folder, and never a home folder", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-attach-workspace-")));
  const home = join(root, "home");
  const project = join(home, "code", "app");
  const source = join(project, "src");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(project, ".git"));
  mkdirSync(join(home, ".git"));
  try {
    await startedIn(home, source, async () => {
      const roots = await resolveAttachmentWorkspace();
      assert.equal(roots.workspace, project);
      assert.equal(roots.baseDirectory, source, "relative names resolve against the start folder");
    });
    // A home folder kept in git (dotfiles) is not the project; the start folder is.
    rmSync(join(project, ".git"), { recursive: true });
    await startedIn(home, source, async () => assert.equal((await resolveAttachmentWorkspace()).workspace, source));
    for (const folder of [home, root]) {
      await startedIn(home, folder, () => assert.rejects(resolveAttachmentWorkspace(), /Attachments need a project folder/, folder));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool's configuration folder in the home folder is not a project, but its worktrees are", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-attach-config-")));
  const home = join(root, "home");
  const worktree = join(home, ".cursor", "worktrees", "app", "a1b2");
  for (const folder of [join(home, ".claude"), join(home, ".letagents"), join(home, ".config", "tool"), join(home, "Library", "Tool"), worktree]) {
    mkdirSync(folder, { recursive: true });
  }
  mkdirSync(join(worktree, ".git"));
  try {
    for (const folder of [join(home, ".claude"), join(home, ".letagents"), join(home, ".config", "tool"), join(home, "Library", "Tool"), join(home, ".cursor", "worktrees")]) {
      await startedIn(home, folder, () => assert.rejects(resolveAttachmentWorkspace(), /inside the tool configuration folder/, folder));
    }
    await startedIn(home, worktree, async () => assert.equal((await resolveAttachmentWorkspace()).workspace, worktree));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the workspace never follows the start folder's path after the server started", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-attach-pinned-")));
  const home = join(root, "home");
  const project = join(root, "repo", "app");
  const secrets = join(root, "owner-secrets");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(secrets);
  try {
    await startedIn(home, project, async () => {
      assert.equal((await resolveAttachmentWorkspace()).workspace, project);
      // The agent moves its folder away and puts a link to another folder in its place.
      // (Windows refuses to rename a process's current folder, so this test leaves it first.)
      process.chdir(root);
      renameSync(project, `${project}-moved`);
      symlinkSync(secrets, project, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(resolveAttachmentWorkspace(), /has moved or changed/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
