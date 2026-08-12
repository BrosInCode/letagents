import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DesktopManagedAgentSession } from "../ipc-types.js";
import { buildManagedAgentChangeSummaryAttachmentDraft } from "../main/agents/managed-agent-change-attachments.js";
import { buildDesktopManagedAgentChangeSummary } from "../main/agents/managed-agent-changes.js";

test("managed agent change summary reports staged, unstaged, and untracked Codex repo files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-managed-agent-changes-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-qm", "init"]);

    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "staged file.txt"), "created\n");
    git(repo, ["add", "staged file.txt"]);
    writeFileSync(join(repo, "untracked.txt"), "local\n");

    const summary = await buildDesktopManagedAgentChangeSummary(session(repo));

    assert.equal(summary.error, null);
    assert.equal(summary.isGitRepo, true);
    assert.equal(summary.changedFileCount, 3);
    assert.equal(summary.stagedFileCount, 1);
    assert.equal(summary.unstagedFileCount, 1);
    assert.equal(summary.untrackedFileCount, 1);
    assert.equal(summary.additions, 2);
    assert.equal(summary.deletions, 0);

    const tracked = summary.files.find((file) => file.path === "tracked.txt");
    assert.equal(tracked?.unstaged, true);
    assert.equal(tracked?.additions, 1);

    const staged = summary.files.find((file) => file.path === "staged file.txt");
    assert.equal(staged?.staged, true);
    assert.equal(staged?.status, "added");
    assert.equal(staged?.additions, 1);

    const untracked = summary.files.find((file) => file.path === "untracked.txt");
    assert.equal(untracked?.untracked, true);
    assert.equal(untracked?.status, "untracked");
    assert.equal(untracked?.additions, 0);

    const attachmentDraft = buildManagedAgentChangeSummaryAttachmentDraft(summary);
    assert.ok(attachmentDraft);
    const attachmentPayload = JSON.parse(attachmentDraft.buffer.toString("utf8")) as {
      summary?: Record<string, unknown>;
    };
    assert.equal(attachmentPayload.summary?.changeScope, "working_tree");
    assert.equal("sessionId" in (attachmentPayload.summary ?? {}), false);
    assert.equal("repoRootPath" in (attachmentPayload.summary ?? {}), false);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("managed agent change summary keeps numstat counts for edited renamed files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-managed-agent-changes-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "old.txt"), "one\n");
    git(repo, ["add", "old.txt"]);
    git(repo, ["commit", "-qm", "init"]);

    git(repo, ["mv", "old.txt", "new.txt"]);
    writeFileSync(join(repo, "new.txt"), "one\ntwo\n");
    git(repo, ["add", "new.txt"]);

    const summary = await buildDesktopManagedAgentChangeSummary(session(repo));
    const renamed = summary.files.find((file) => file.path === "new.txt");

    assert.equal(summary.changedFileCount, 1);
    assert.equal(summary.additions, 1);
    assert.equal(renamed?.previousPath, "old.txt");
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.staged, true);
    assert.equal(renamed?.additions, 1);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("managed agent change summary collapses untracked directories", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-managed-agent-changes-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-qm", "init"]);

    mkdirSync(join(repo, "generated", "nested"), { recursive: true });
    writeFileSync(join(repo, "generated", "a.txt"), "a\n");
    writeFileSync(join(repo, "generated", "nested", "b.txt"), "b\n");

    const summary = await buildDesktopManagedAgentChangeSummary(session(repo));

    assert.equal(summary.changedFileCount, 1);
    assert.equal(summary.untrackedFileCount, 1);
    assert.equal(summary.files[0]?.path, "generated/");
    assert.equal(summary.files[0]?.status, "untracked");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("managed agent change summary truncates file rows without losing totals", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-managed-agent-changes-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "agent@example.com"]);
    git(repo, ["config", "user.name", "Agent"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-qm", "init"]);

    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");

    const summary = await buildDesktopManagedAgentChangeSummary(session(repo), { fileLimit: 1 });

    assert.equal(summary.changedFileCount, 2);
    assert.equal(summary.files.length, 1);
    assert.equal(summary.hiddenFileCount, 1);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("managed agent change summary returns a displayable error for non-git folders", async () => {
  const folder = mkdtempSync(join(tmpdir(), "letagents-managed-agent-changes-"));
  try {
    const summary = await buildDesktopManagedAgentChangeSummary(session(folder));

    assert.equal(summary.isGitRepo, false);
    assert.match(summary.error ?? "", /Could not inspect this agent's Git changes/);
    assert.equal(summary.changedFileCount, 0);
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function session(repoRootPath: string): DesktopManagedAgentSession {
  return {
    id: "session_1",
    providerId: "codex",
    runtime: "codex",
    roomIdentifier: "github.com/example/repo",
    roomDisplayName: null,
    repoRootPath,
    repoBranch: "main",
    status: "running",
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
    agentSessionId: "agent_session_1",
    actorLabel: "NorthForge",
    agentKey: "codex",
    displayName: "NorthForge",
    ownerLabel: "Local desktop",
    ideLabel: "Codex",
    model: null,
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastError: null,
  };
}
