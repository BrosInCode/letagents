import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { DesktopProjectBinding, DesktopRoomInfo } from "../../electron/ipc-types";
import { projectBindingAliases } from "../../electron/project-bindings";
import {
  managedAgentRootPathForRoom,
  managedAgentRepoStatusForRoom,
  preferredManagedAgentRepoRootPath,
  supervisedProviderLaunchPolicy,
} from "../src/domain/managed-agents";
import {
  activeRepoRoomContext,
  canonicalRepoIdentity,
  readRepositoryRootBindings,
  resolveActiveProjectRootPath,
  roomWithInheritedProjectContext,
} from "../src/domain/room-project-context";

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

function binding(
  context: { roomIdentifier: string; gitRoom?: DesktopRoomInfo["gitRoom"] },
  rootPath = "/project/main",
): DesktopProjectBinding {
  return {
    id: "binding_1",
    aliases: projectBindingAliases(context),
    rootPath,
    source: context.gitRoom?.host === "github.com" ? "git_remote" : "local_git",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
}

test("a listed focus room inherits its parent project Git context", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const inherited = roomWithInheritedProjectContext(room(), parent, true);
  assert.equal(inherited.gitRoom, projectGitRoom);
});

test("a focus room never inherits an unrelated parent project", () => {
  const parent = room({ identifier: "other_project", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  assert.equal(roomWithInheritedProjectContext(room(), parent).gitRoom, null);
});

test("an explicit focus Git context wins over its parent context", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const ownGitRoom = { ...projectGitRoom, ref: { ...projectGitRoom.ref, name: "feature/focus" } };
  assert.equal(roomWithInheritedProjectContext(room({ gitRoom: ownGitRoom }), parent, true).gitRoom, ownGitRoom);
});

test("a restored branch focus room starts from its matching worktree", () => {
  const parent = room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom });
  const focusRoom = roomWithInheritedProjectContext(room({ parentRoomId: "project_room" }), parent);
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
  const verified = managedAgentRepoStatusForRoom(repoStatus, focusRoom, true);
  assert.equal(preferredManagedAgentRepoRootPath(verified, focusRoom.gitRoom), "/project/feature-launch");
  assert.equal(managedAgentRepoStatusForRoom(repoStatus, focusRoom, false), null);
});

test("Add Agent consumes the durable project root when live Git status is absent", () => {
  const focusRoom = roomWithInheritedProjectContext(
    room(),
    room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom }),
    true,
  );
  assert.equal(managedAgentRootPathForRoom({
    room: focusRoom,
    repoStatus: null,
    gitRoomMatchesActiveRepo: false,
    durableProjectRootPath: "/project/main",
    homePath: "/Users/emmy",
  }), "/project/main");
});

test("Add Agent uses a matching branch worktree ahead of the source project root", () => {
  const focusRoom = roomWithInheritedProjectContext(
    room(),
    room({ identifier: "project_room", kind: "main", parentRoomId: null, gitRoom: projectGitRoom }),
    true,
  );
  assert.equal(managedAgentRootPathForRoom({
    room: focusRoom,
    repoStatus: {
      rootPath: "/project/main",
      mainRootPath: "/project/main",
      defaultBranch: "main",
      worktrees: [{ path: "/project/feature-launch", branch: "feature/launch", head: "abc", isCurrent: false }],
    },
    gitRoomMatchesActiveRepo: true,
    durableProjectRootPath: "/project/main",
    homePath: "/Users/emmy",
  }), "/project/feature-launch");
});

test("runtime project resolution uses only the authoritative desktop binding", () => {
  const durable = binding({ roomIdentifier: "github.com/brosincode/letagents", gitRoom: githubGitRoom });
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/brosincode/letagents/focus/git:branch:c3RhZ2luZw",
    activeRootGitRoom: githubGitRoom,
    projectBindings: [durable],
  }), "/project/main");
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "github.com/brosincode/letagents",
    activeRootGitRoom: githubGitRoom,
    projectBindings: [],
  }), null);
});

test("a display-name room alias resolves through stable repository identity", () => {
  const durable = binding({ roomIdentifier: "github.com/brosincode/letagents", gitRoom: githubGitRoom });
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: "sky-lake",
    activeRootGitRoom: githubGitRoom,
    projectBindings: [durable],
  }), "/project/main");
});

test("legacy renderer roots are parsed only as migration input", () => {
  const storage = {
    getItem: () => JSON.stringify({
      "GITHUB.COM/OWNER/PROJECT": " /project/new ",
      invalid: " ",
    }),
  };
  assert.deepEqual(readRepositoryRootBindings(storage, "bindings", [
    { identifier: "github.com/legacy/repo", rootPath: "/project/legacy" },
  ]), {
    "github.com/legacy/repo": "/project/legacy",
    "github.com/owner/project": "/project/new",
  });
});

test("project association is room-level and Add Agent cannot open a folder picker", () => {
  const shell = readFileSync(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url), "utf8");
  const actionBar = readFileSync(new URL("../src/components/desktop/content/add-agent/AddAgentActionBar.vue", import.meta.url), "utf8");
  assert.match(shell, /project-connection-needed/);
  assert.match(shell, /Connect this room to its local project before adding an agent/);
  assert.doesNotMatch(shell, /@choose-repo/);
  assert.match(actionBar, /Connect project from the room/);
  assert.doesNotMatch(actionBar, /emit\('choose-repo'\)/);
});

test("canonicalRepoIdentity reduces branch-scoped identifiers", () => {
  assert.equal(
    canonicalRepoIdentity("github.com/brosincode/letagents/focus/git:branch:c3RhZ2luZw"),
    "github.com/brosincode/letagents",
  );
  assert.equal(canonicalRepoIdentity("git-room:local:my-checkout:branch:ZmVhdA"), "local/my-checkout");
  assert.equal(canonicalRepoIdentity(null), null);
});

const skyLakeGroup = {
  parent: {
    id: "room:parent:github.com/brosincode/letagents",
    roomIdentifier: "github.com/brosincode/letagents",
    gitRoom: githubGitRoom,
  },
  branchRooms: [] as { id: string }[],
  focusRooms: [{ id: "room:focus:focus_37" }],
};

test("a focus room resolves the binding of its project-group parent", () => {
  const context = activeRepoRoomContext("room:focus:focus_37", [
    { parent: { id: "room:parent:frost-spring", roomIdentifier: "frost-spring", gitRoom: null }, branchRooms: [], focusRooms: [] },
    skyLakeGroup,
  ]);
  assert.equal(context?.roomIdentifier, "github.com/brosincode/letagents");
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: context?.roomIdentifier,
    activeRootGitRoom: context?.gitRoom,
    projectBindings: [binding({ roomIdentifier: "github.com/brosincode/letagents", gitRoom: githubGitRoom })],
  }), "/project/main");
});

test("a grouped non-project room never inherits another project's binding", () => {
  const nonProjectGroup = {
    parent: { id: "room:parent:frost-spring", roomIdentifier: "frost-spring", gitRoom: null },
    branchRooms: [] as { id: string }[],
    focusRooms: [{ id: "room:focus:focus_99" }],
  };
  const context = activeRepoRoomContext("room:focus:focus_99", [skyLakeGroup, nonProjectGroup]);
  assert.equal(resolveActiveProjectRootPath({
    activeRootIdentifier: context?.roomIdentifier,
    activeRootGitRoom: context?.gitRoom,
    projectBindings: [binding({ roomIdentifier: "github.com/brosincode/letagents", gitRoom: githubGitRoom })],
  }), null);
});

test("supervised Claude permission profiles become explicit native CLI policies", () => {
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "read_only"), { permissionMode: "plan" });
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "ask_before_write"), { permissionMode: "default" });
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "full_access"), { permissionMode: "bypassPermissions" });
  assert.throws(() => supervisedProviderLaunchPolicy("claude-code", null), /Choose an available Claude Code permission profile/);
  assert.equal(supervisedProviderLaunchPolicy("codex", "full_access"), undefined);
});
