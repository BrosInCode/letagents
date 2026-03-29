import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildGitHubRepoRoomId,
  extractReferencedTaskId,
  formatGitHubPullRequestEventMessage,
  formatGitHubRepositoryEventMessage,
  verifyGitHubWebhookSignature,
} from "../github-app.js";

test("verifyGitHubWebhookSignature accepts a valid sha256 signature", () => {
  const body = Buffer.from(JSON.stringify({ action: "opened", number: 42 }));
  const secret = "super-secret";
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(verifyGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(verifyGitHubWebhookSignature(body, signature, "wrong-secret"), false);
});

test("buildGitHubRepoRoomId normalizes GitHub repository names to discoverable room ids", () => {
  assert.equal(buildGitHubRepoRoomId("BrosInCode/LetAgents"), "github.com/brosincode/letagents");
});

test("extractReferencedTaskId returns the first explicit task reference from title or body", () => {
  assert.equal(
    extractReferencedTaskId(
      "task_22: wire GitHub webhook ingestion",
      "follow-up in body for task_99 should not win"
    ),
    "task_22"
  );
  assert.equal(extractReferencedTaskId("No task here", null), null);
});

test("formatGitHubPullRequestEventMessage includes linked task context for supported actions", () => {
  const message = formatGitHubPullRequestEventMessage({
    action: "opened",
    repositoryFullName: "brosincode/letagents",
    senderLogin: "EmmyMay",
    linkedTaskId: "task_22",
    pullRequest: {
      number: 98,
      title: "task_22: add webhook ingestion",
      html_url: "https://github.com/BrosInCode/letagents/pull/98",
    },
  });

  assert.equal(
    message,
    "PR #98 opened by EmmyMay in brosincode/letagents linked to task_22: task_22: add webhook ingestion https://github.com/BrosInCode/letagents/pull/98"
  );
});

test("formatGitHubRepositoryEventMessage formats rename events correctly", () => {
  const message = formatGitHubRepositoryEventMessage({
    action: "renamed",
    repositoryFullName: "BrosInCode/letagents",
    oldFullName: "BrosInCode/old-name",
    senderLogin: "EmmyMay",
  });

  assert.equal(
    message,
    "Repository renamed from BrosInCode/old-name to BrosInCode/letagents by EmmyMay"
  );
});

test("formatGitHubRepositoryEventMessage formats transfer events correctly", () => {
  const message = formatGitHubRepositoryEventMessage({
    action: "transferred",
    repositoryFullName: "NewOrg/letagents",
    oldFullName: "OldOrg/letagents",
    senderLogin: "EmmyMay",
  });

  assert.equal(
    message,
    "Repository transferred from OldOrg/letagents to NewOrg/letagents by EmmyMay"
  );
});

test("formatGitHubRepositoryEventMessage returns null for unsupported actions", () => {
  const message = formatGitHubRepositoryEventMessage({
    action: "deleted",
    repositoryFullName: "BrosInCode/letagents",
  });

  assert.equal(message, null);
});
