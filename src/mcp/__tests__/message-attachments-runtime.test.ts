import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertMessageFileAttachmentsAvailable, resolveAttachmentWorkspace } from "../server/runtime/message-attachments.js";
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

test("the workspace is the checkout around the working folder, and never a home folder", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-attach-workspace-")));
  const home = join(root, "home");
  const project = join(home, "code", "app");
  const source = join(project, "src");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(project, ".git"));
  mkdirSync(join(home, ".git"));
  const prior = { cwd: process.cwd(), HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.chdir(source);
    const roots = await resolveAttachmentWorkspace();
    assert.equal(roots.workspace, project);
    assert.equal(roots.baseDirectory, source, "relative names resolve against the working folder");
    // A home folder kept in git (dotfiles) is not the project; the working folder is.
    rmSync(join(project, ".git"), { recursive: true });
    assert.equal((await resolveAttachmentWorkspace()).workspace, source);
    for (const folder of [home, root]) {
      process.chdir(folder);
      await assert.rejects(resolveAttachmentWorkspace(), /Attachments need a project folder/, folder);
    }
  } finally {
    process.chdir(prior.cwd);
    for (const name of ["HOME", "USERPROFILE"] as const) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
