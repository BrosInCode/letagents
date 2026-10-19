import assert from "node:assert/strict";
import test from "node:test";
import { defaultRoomDisplayName, generateRoomDisplayName, resolveRoomDisplayName } from "../rooms/display-name.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { toProject } = await import("../db/mappers.js");

test("canonical project rooms use the repository name; standalone rooms keep their defaults", () => {
  for (const [identifier, expected] of [
    ["github.com/brosincode/letagents", "letagents"],
    ["gitlab.com/team/subgroup/MyProject", "MyProject"],
    ["bitbucket.org/team/project", "project"],
    ["github.com/team/focus", "focus"],
  ]) assert.equal(defaultRoomDisplayName(identifier), expected);
  for (const id of ["ROOM-1234", "Design conversations", "focus_123", "github.com/team/repo/focus/git:branch:bWFpbg"]) {
    assert.equal(defaultRoomDisplayName(id), generateRoomDisplayName(id));
  }
});

test("legacy default project names resolve without changing custom or focus names", () => {
  const id = "github.com/brosincode/letagents";
  assert.equal(resolveRoomDisplayName(id, generateRoomDisplayName(id), "main"), "letagents");
  assert.equal(resolveRoomDisplayName(id, "Release planning", "main"), "Release planning");
  assert.equal(resolveRoomDisplayName(id, generateRoomDisplayName(id), "focus"), generateRoomDisplayName(id));
  assert.equal(resolveRoomDisplayName("ABCD-1234", "Design team", "main"), "Design team");
});

test("room reads expose the project label without mutating stored identity or history", () => {
  const id = "github.com/brosincode/letagents";
  const row = { id, kind: "main", display_name: generateRoomDisplayName(id), created_at: "2026-10-16T00:00:00Z" };
  const room = toProject(row as never);
  assert.equal(room.display_name, "letagents");
  assert.equal(room.id, id);
  assert.equal(room.name, id);
  assert.equal(room.created_at, row.created_at);
  assert.equal(row.display_name, generateRoomDisplayName(id));
  assert.equal(toProject({ ...row, display_name: "Release planning" } as never).display_name, "Release planning");
});
