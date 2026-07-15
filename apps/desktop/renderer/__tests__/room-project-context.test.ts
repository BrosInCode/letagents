import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRoomInfo } from "../../electron/ipc-types";
import {
  managedAgentRepoStatusForRoom,
  preferredManagedAgentRepoRootPath,
} from "../src/domain/managed-agents";
import { roomWithInheritedProjectContext } from "../src/domain/room-project-context";

const projectGitRoom: NonNullable<DesktopRoomInfo["gitRoom"]> = {
  provider: "git",
  host: "local",
  repository: { id: "repo_1", fullName: "owner/project", owner: "owner", name: "project" },
  ref: { type: "branch", name: "feature/launch", defaultBranch: "main", baseRef: null, headRef: null, headRepository: null },
  visibility: "local",
  accessMode: "local",
  isDefault: false,
  source: "local_git",
};

function room(overrides: Partial<DesktopRoomInfo> = {}): DesktopRoomInfo {
  return {
    identifier: "focus_1",
    code: "",
    name: "Focus",
    displayName: "Focus",
    role: "participant",
    authenticated: true,
    kind: "focus",
    parentRoomId: "project_room",
    focusKey: "task_1",
    sourceTaskId: "task_1",
    focusStatus: null,
    focusParentVisibility: null,
    focusActivityScope: null,
    focusGitHubEventRouting: null,
    focusSettings: null,
    focusArchivedAt: null,
    concludedAt: null,
    conclusionSummary: null,
    conclusionDetails: null,
    gitRoom: null,
    ...overrides,
  };
}

test("a listed focus room inherits its parent project Git context for Add Agent", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const inherited = roomWithInheritedProjectContext(room(), parent, true);
  assert.equal(inherited.gitRoom, projectGitRoom);
  assert.equal(inherited.gitRoom?.ref.name, "feature/launch");
});

test("a focus room never inherits an unrelated parent project", () => {
  const parent = room({ identifier: "other_project", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  assert.equal(roomWithInheritedProjectContext(room(), parent).gitRoom, null);
});

test("a reopened focus room restores the matching parent project context", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const restoredFocusRoom = room({ parentRoomId: "PROJECT_ROOM" });
  assert.equal(roomWithInheritedProjectContext(restoredFocusRoom, parent).gitRoom, projectGitRoom);
});

test("a restored branch focus room starts from its verified parent worktree", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const restoredFocusRoom = room({ parentRoomId: "project_room" });
  const focusRoom = roomWithInheritedProjectContext(restoredFocusRoom, parent);
  const repoStatus = {
    rootPath: "/project/main",
    mainRootPath: "/project/main",
    defaultBranch: "main",
    worktrees: [{
      path: "/project/feature-launch",
      branch: "feature/launch",
      head: "abc1234",
      isCurrent: false,
      isMain: false,
    }],
  };

  const verifiedRepoStatus = managedAgentRepoStatusForRoom(repoStatus, focusRoom, true);
  assert.equal(preferredManagedAgentRepoRootPath(verifiedRepoStatus, focusRoom.gitRoom), "/project/feature-launch");
  assert.equal(managedAgentRepoStatusForRoom(repoStatus, focusRoom, false), null);
});

test("an explicit focus Git context wins over its parent context", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const ownGitRoom = { ...projectGitRoom, ref: { ...projectGitRoom.ref, name: "feature/focus" } };
  assert.equal(roomWithInheritedProjectContext(room({ gitRoom: ownGitRoom }), parent, true).gitRoom, ownGitRoom);
});
