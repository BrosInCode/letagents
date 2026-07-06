import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DesktopManagedAgentSession } from "../ipc-types.js";
import {
  buildDesktopManagedAgentReplyChangeContext,
  clearDesktopManagedAgentReplyChangeState,
  desktopManagedAgentReplyChangeSignature,
  localDesktopManagedAgentReplyChangeAttachments,
  rememberDesktopManagedAgentReplyChangeAttachment,
} from "../main/agents/managed-agent-reply-changes.js";

test("managed agent reply change context attaches once per working tree state", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-reply-changes-"));
  const sessionKey = "test:reply-changes-attach-once";
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-qm", "init"]);
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");

    const first = await buildDesktopManagedAgentReplyChangeContext({
      sessionKey,
      session: session(repo),
    });
    assert.equal(first.summary?.changedFileCount, 1);
    assert.ok(first.signature);
    assert.ok(first.attachmentDraft, "first reply for a dirty tree attaches a change summary");
    assert.equal(localDesktopManagedAgentReplyChangeAttachments(first).length, 1);

    rememberDesktopManagedAgentReplyChangeAttachment(sessionKey, first.attachmentDraft);
    const repeat = await buildDesktopManagedAgentReplyChangeContext({
      sessionKey,
      session: session(repo),
    });
    assert.equal(repeat.signature, first.signature);
    assert.equal(repeat.attachmentDraft, null, "unchanged tree does not re-attach");
    assert.deepEqual(localDesktopManagedAgentReplyChangeAttachments(repeat), []);

    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
    const changed = await buildDesktopManagedAgentReplyChangeContext({
      sessionKey,
      session: session(repo),
    });
    assert.notEqual(changed.signature, first.signature);
    assert.ok(changed.attachmentDraft, "a new tree state attaches again");
  } finally {
    clearDesktopManagedAgentReplyChangeState(sessionKey);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("managed agent reply change context skips attaching when the turn made no changes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-reply-changes-"));
  const sessionKey = "test:reply-changes-before-signature";
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-qm", "init"]);
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");

    const beforeSignature = await desktopManagedAgentReplyChangeSignature(session(repo));
    assert.ok(beforeSignature);

    const context = await buildDesktopManagedAgentReplyChangeContext({
      sessionKey,
      session: session(repo),
      beforeSignature,
    });
    assert.equal(
      context.attachmentDraft,
      null,
      "pre-existing dirt is not attributed to a turn that changed nothing",
    );
    assert.equal(context.summary?.changedFileCount, 1, "the summary itself still reports the tree");
  } finally {
    clearDesktopManagedAgentReplyChangeState(sessionKey);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("clearing reply change state lets the same tree attach again", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-reply-changes-"));
  const sessionKey = "test:reply-changes-clear";
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-qm", "init"]);
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");

    const first = await buildDesktopManagedAgentReplyChangeContext({
      sessionKey,
      session: session(repo),
    });
    rememberDesktopManagedAgentReplyChangeAttachment(sessionKey, first.attachmentDraft);
    clearDesktopManagedAgentReplyChangeState(sessionKey);

    const afterClear = await buildDesktopManagedAgentReplyChangeContext({
      sessionKey,
      session: session(repo),
    });
    assert.ok(afterClear.attachmentDraft, "cleared session state does not suppress attachments");
  } finally {
    clearDesktopManagedAgentReplyChangeState(sessionKey);
    rmSync(repo, { recursive: true, force: true });
  }
});

function session(repoRootPath: string): DesktopManagedAgentSession {
  return {
    id: "session_reply_changes",
    providerId: "claude-code",
    runtime: "claude-code",
    roomIdentifier: "room_reply_changes",
    roomDisplayName: null,
    repoRootPath,
    repoBranch: "main",
    status: "completed",
    deliveryMode: "desktop_events",
    permissionProfileId: "read_only",
    permissionProfile: {
      id: "read_only",
      label: "Read-only",
      status: "available",
      risk: "low",
      isDefault: false,
      description: "Read-only",
      detail: "Read-only",
    },
    canStop: true,
    agentSessionId: "agent_session_reply_changes",
    actorLabel: "CedarVista",
    agentKey: "claude-code",
    displayName: "CedarVista",
    ownerLabel: "Local desktop",
    ideLabel: "Claude Code",
    model: null,
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastError: null,
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
