import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRoomInfo } from "../../electron/ipc-types";
import {
  managedAgentRootPathForRoom,
  managedAgentRepoStatusForRoom,
  preferredManagedAgentRepoRootPath,
  supervisedProviderLaunchPolicy,
} from "../src/domain/managed-agents";
import { canonicalRepoIdentity, resolveActiveProjectRootPath, roomWithInheritedProjectContext } from "../src/domain/room-project-context";

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

test("Add Agent keeps a focus room on its durable project root when active repo status is missing", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const focusRoom = roomWithInheritedProjectContext(room(), parent, true);
  assert.equal(managedAgentRootPathForRoom({
    room: focusRoom,
    repoStatus: null,
    gitRoomMatchesActiveRepo: false,
    durableProjectRootPath: "/project/main",
    homePath: "/Users/emmy",
  }), "/project/main");
});

test("Add Agent preserves branch worktree matching ahead of the durable project fallback", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const focusRoom = roomWithInheritedProjectContext(room(), parent, true);
  assert.equal(managedAgentRootPathForRoom({
    room: focusRoom,
    repoStatus: {
      rootPath: "/project/main",
      mainRootPath: "/project/main",
      defaultBranch: "main",
      worktrees: [{
        path: "/project/feature-launch",
        branch: "feature/launch",
        head: "abc1234",
        isCurrent: false,
      }],
    },
    gitRoomMatchesActiveRepo: true,
    durableProjectRootPath: "/project/main",
    homePath: "/Users/emmy",
  }), "/project/feature-launch");
});

test("Add Agent uses home for a room without Git or project context", () => {
  assert.equal(managedAgentRootPathForRoom({
    room: room({ kind: "main", parentRoomId: null, gitRoom: null }),
    repoStatus: {
      rootPath: "/application/startup-repo",
      mainRootPath: "/application/startup-repo",
      defaultBranch: "main",
      worktrees: [],
    },
    gitRoomMatchesActiveRepo: false,
    durableProjectRootPath: null,
    homePath: "/Users/emmy",
  }), "/Users/emmy");
});

test("Add Agent never replaces a durable local project root with stale repo status", () => {
  assert.equal(managedAgentRootPathForRoom({
    room: room({ kind: "main", parentRoomId: null, gitRoom: null }),
    repoStatus: {
      rootPath: "/unrelated/repo",
      mainRootPath: "/unrelated/repo",
      defaultBranch: "main",
      worktrees: [],
    },
    gitRoomMatchesActiveRepo: false,
    durableProjectRootPath: "/project/local-folder",
    homePath: "/Users/emmy",
  }), "/project/local-folder");
});

const workspaceStatus = (roomIdentifier: string | null, rootPath = "/Users/emmy/Projects/project", isGitRepo = true) =>
  ({ rootPath, roomIdentifier, isGitRepo });

test("resolveActiveProjectRootPath returns the stored durable root when present", () => {
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/owner/project",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [{ identifier: "github.com/owner/project", rootPath: "/project/main" }],
    workspaceRepoStatus: workspaceStatus("github.com/owner/project"),
  }), "/project/main");
});

test("resolveActiveProjectRootPath self-heals a lost durable root from an identity-matched workspace", () => {
  // Regression (task_60 follow-up): a focus room whose parent repo room lost its
  // durable root (an older account/app-agent reopen wiped it) inherits the
  // workspace instead of prompting — but only because the workspace's canonical
  // identity matches the room's repo.
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/owner/project",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [{ identifier: "github.com/owner/project", rootPath: null }],
    workspaceRepoStatus: workspaceStatus("github.com/owner/project"),
  }), "/Users/emmy/Projects/project");
});

test("resolveActiveProjectRootPath matches a local git room by host/fullName identity", () => {
  // projectGitRoom is host "local", fullName "owner/project" → identity key
  // "local/owner/project". A local workspace whose roomIdentifier is that key heals.
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "sky-lake",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [{ identifier: "sky-lake", rootPath: null }],
    workspaceRepoStatus: workspaceStatus("local/owner/project"),
  }), "/Users/emmy/Projects/project");
});

test("resolveActiveProjectRootPath self-heals after a relaunch rehydrates a wiped repo entry", () => {
  // A relaunch reloads recentRootRooms from storage; the wiped entry looks like a
  // plain room (rootPath null) but the live snapshot still reports the gitRoom.
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/owner/project",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [
      { identifier: "other-room", rootPath: null },
      { identifier: "github.com/owner/project", rootPath: null },
    ],
    workspaceRepoStatus: workspaceStatus("github.com/owner/project"),
  }), "/Users/emmy/Projects/project");
});

test("resolveActiveProjectRootPath FAILS CLOSED when the workspace is a different repo", () => {
  // The core blocker: never inherit a valid-but-unrelated repository. A mismatched
  // workspace identity must resolve to null so the repo-room boundary requires a pick.
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/owner/project",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [{ identifier: "github.com/owner/project", rootPath: null }],
    workspaceRepoStatus: workspaceStatus("github.com/owner/unrelated", "/Users/emmy/Projects/unrelated"),
  }), null);
});

test("resolveActiveProjectRootPath leaves a genuinely repo-less room unresolved", () => {
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "invite-room",
    activeRootGitRoom: null,
    recentRootRooms: [{ identifier: "invite-room", rootPath: null }],
    workspaceRepoStatus: workspaceStatus("github.com/owner/project"),
  }), null);
});

test("resolveActiveProjectRootPath does not self-heal when the workspace status is missing or non-git", () => {
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/owner/project",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [{ identifier: "github.com/owner/project", rootPath: null }],
    workspaceRepoStatus: null,
  }), null);
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/owner/project",
    activeRootGitRoom: projectGitRoom,
    recentRootRooms: [{ identifier: "github.com/owner/project", rootPath: null }],
    workspaceRepoStatus: workspaceStatus("github.com/owner/project", "/Users/emmy/Projects/project", false),
  }), null);
});

const githubGitRoom: NonNullable<DesktopRoomInfo["gitRoom"]> = {
  provider: "github",
  host: "github.com",
  repository: { id: "gh_1", fullName: "brosincode/letagents", owner: "brosincode", name: "letagents" },
  ref: { type: "branch", name: "main", defaultBranch: "main", baseRef: null, headRef: null, headRepository: null },
  visibility: "private",
  accessMode: "connected",
  isDefault: true,
  source: "git_remote",
};

test("canonicalRepoIdentity reduces a branch-scoped git-room id to its repository", () => {
  assert.equal(
    canonicalRepoIdentity("git-room:github.com:brosincode/letagents:branch:c3RhZ2luZw"),
    "github.com/brosincode/letagents",
  );
  assert.equal(canonicalRepoIdentity("github.com/brosincode/letagents"), "github.com/brosincode/letagents");
  assert.equal(canonicalRepoIdentity("git-room:local:my-checkout:branch:ZmVhdA"), "local/my-checkout");
  assert.equal(canonicalRepoIdentity(null), null);
});

test("resolveActiveProjectRootPath self-heals a BASE repo room from a non-default-branch workspace", () => {
  // RiverRiver's exact reproduction: the focus room is under the BASE repo room
  // while the launched checkout is on `staging`, so the workspace roomIdentifier
  // is branch-scoped. Repository identity matches branch-independently -> heal,
  // no folder prompt.
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/brosincode/letagents",
    activeRootGitRoom: githubGitRoom,
    recentRootRooms: [{ identifier: "github.com/brosincode/letagents", rootPath: null }],
    workspaceRepoStatus: workspaceStatus(
      "git-room:github.com:brosincode/letagents:branch:c3RhZ2luZw",
      "/Users/emmy/Projects/letagents",
    ),
  }), "/Users/emmy/Projects/letagents");
});

test("resolveActiveProjectRootPath fails closed when a branch-scoped workspace is a different repo", () => {
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/brosincode/letagents",
    activeRootGitRoom: githubGitRoom,
    recentRootRooms: [{ identifier: "github.com/brosincode/letagents", rootPath: null }],
    workspaceRepoStatus: workspaceStatus(
      "git-room:github.com:someoneelse/otherrepo:branch:c3RhZ2luZw",
      "/Users/emmy/Projects/other",
    ),
  }), null);
});

test("supervised Claude permission profiles become explicit native CLI policies", () => {
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "read_only"), { permissionMode: "plan" });
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "ask_before_write"), { permissionMode: "default" });
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "full_access"), { permissionMode: "bypassPermissions" });
  assert.throws(() => supervisedProviderLaunchPolicy("claude-code", null), /Choose an available Claude Code permission profile/);
  assert.equal(supervisedProviderLaunchPolicy("codex", "full_access"), undefined);
});
