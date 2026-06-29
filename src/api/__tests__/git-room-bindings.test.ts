import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { buildManualGitHubRepoRoomBindingInput } = await import("../db.js");

test("buildManualGitHubRepoRoomBindingInput maps GitHub repo rooms to default Git Room bindings", () => {
  assert.deepEqual(
    buildManualGitHubRepoRoomBindingInput("github.com/brosincode/letagents"),
    {
      room_id: "github.com/brosincode/letagents",
      provider: "github",
      host: "github.com",
      repository_id: null,
      repository_full_name: "brosincode/letagents",
      repository_owner: "brosincode",
      repository_name: "letagents",
      ref_type: "default_branch",
      ref_name: null,
      default_branch: null,
      visibility: "unknown",
      is_default: true,
      source: "manual",
    }
  );
});

test("buildManualGitHubRepoRoomBindingInput normalizes GitHub repo casing", () => {
  assert.deepEqual(
    buildManualGitHubRepoRoomBindingInput("GitHub.com/BrosInCode/LetAgents"),
    {
      room_id: "github.com/brosincode/letagents",
      provider: "github",
      host: "github.com",
      repository_id: null,
      repository_full_name: "brosincode/letagents",
      repository_owner: "brosincode",
      repository_name: "letagents",
      ref_type: "default_branch",
      ref_name: null,
      default_branch: null,
      visibility: "unknown",
      is_default: true,
      source: "manual",
    }
  );
});

test("buildManualGitHubRepoRoomBindingInput ignores non-GitHub and nested room ids", () => {
  assert.equal(buildManualGitHubRepoRoomBindingInput("focus_27"), null);
  assert.equal(buildManualGitHubRepoRoomBindingInput("gitlab.com/group/project"), null);
  assert.equal(buildManualGitHubRepoRoomBindingInput("github.com/org/team/project"), null);
});
