import assert from "node:assert/strict";
import test from "node:test";

import type { Response } from "express";
import type { GitRoomBinding, Project } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  getProjectAccessRoomId,
  isRepoBackedProject,
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  requireAdmin,
  requireGitRoomParticipant,
  requireParticipant,
  resolveGitHubRoomEntryDecision,
  resolveProjectRepoRoomAccessDecision,
  resolveRepoRoomAccessDecision,
  unsupportedRepoProviderMessage,
} = await import("../rooms/access.js");

function project(id: string, parentRoomId: string | null = null): Project {
  return {
    id,
    parent_room_id: parentRoomId,
  } as Project;
}

function gitRoomBinding(roomId: string): GitRoomBinding {
  return {
    room_id: roomId,
    provider: "github",
    host: "github.com",
    repository_id: "repo_1",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "git-rooms",
    default_branch: "main",
    base_ref: null,
    head_ref: "git-rooms",
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: false,
    source: "manual",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  };
}

function jsonResponse() {
  const state: { statusCode: number | null; body: unknown } = {
    statusCode: null,
    body: null,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as Response;

  return { res, state };
}

test("room access helpers identify repo-backed room ids and access room ids", () => {
  assert.equal(isRepoBackedRoomId("github.com/BrosInCode/letagents"), true);
  assert.equal(isRepoBackedRoomId("focus_5"), false);
  assert.equal(isRepoBackedRoomId("ABCX-7291"), false);

  assert.equal(
    getProjectAccessRoomId(project("focus-child", "github.com/BrosInCode/letagents")),
    "github.com/BrosInCode/letagents"
  );
  assert.equal(isRepoBackedProject(project("focus-child", "github.com/BrosInCode/letagents")), true);
  assert.equal(isRepoBackedProject(project("invite-room")), false);
});

test("resolveRepoRoomAccessDecision allows non-repo rooms without auth", async () => {
  assert.deepEqual(
    await resolveRepoRoomAccessDecision({
      roomName: "focus_5",
      sessionAccount: null,
    }),
    { kind: "allow" }
  );
});

const NON_GITHUB_REPO_ROOMS = [
  "gitlab.com/team/project",
  "bitbucket.org/poppix/pdf-service",
  "local/Users/someone",
  // GitLab subgroups: `parseRepoRoomName` reads these as repositories too.
  "gitlab.com/group/sub/project",
  "gitlab.com/group/sub/deeper/project",
  "GitLab.com/Group/Sub/Project",
  // No dot in the host: an SSH config alias (`git@github-work:acme/app.git`) and
  // a plain three-part name stay repo-shaped, so they are refused, not opened.
  "github-work/acme/app",
  "team/design/ideas",
];

test("repo-shaped rooms on a host other than github.com are denied without any provider lookup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no provider lookup may run for a non-GitHub host");
  }) as typeof fetch;
  try {
    for (const roomName of NON_GITHUB_REPO_ROOMS) {
      assert.equal(isRepoBackedRoomId(roomName), true, roomName);
      assert.deepEqual(
        await resolveRepoRoomAccessDecision({ roomName, sessionAccount: null }),
        { kind: "unsupported_repo_provider" },
        `${roomName} anonymous`
      );
      assert.deepEqual(
        await resolveRepoRoomAccessDecision({
          roomName,
          sessionAccount: {
            account_id: "acct_1",
            provider: "github",
            login: "EmmyMay",
            provider_access_token: "secret-token",
          },
        }),
        { kind: "unsupported_repo_provider" },
        `${roomName} signed in`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("project repo access denies non-GitHub repo-backed rooms and focus rooms under them", async () => {
  for (const roomName of NON_GITHUB_REPO_ROOMS) {
    for (const candidate of [project(roomName), project("focus_9", roomName)]) {
      const decision = await resolveProjectRepoRoomAccessDecision(
        { project: candidate, sessionAccount: null },
        {
          getGitRoomBindingForRoom: async () => {
            throw new Error("binding lookup should not run for locator rooms");
          },
          resolveRepoRoomAccessDecision,
        }
      );

      assert.equal(decision.isRepoBacked, true, roomName);
      assert.equal(decision.repoRoomName, roomName);
      assert.deepEqual(decision.decision, { kind: "unsupported_repo_provider" });
    }
  }
});

test("requireParticipant refuses non-GitHub repo-backed rooms for anonymous and signed-in callers", async () => {
  for (const sessionAccount of [
    null,
    { account_id: "acct_1", provider: "github", login: "EmmyMay", provider_access_token: "secret-token" },
  ]) {
    const { res, state } = jsonResponse();

    assert.equal(
      await requireParticipant({ sessionAccount } as never, res, project("bitbucket.org/poppix/pdf-service")),
      false
    );
    assert.equal(state.statusCode, 403);
    assert.deepEqual(state.body, {
      error: "unsupported_repo_provider",
      code: "UNSUPPORTED_REPO_PROVIDER",
      message: unsupportedRepoProviderMessage("bitbucket.org/poppix/pdf-service"),
      room_id: "bitbucket.org/poppix/pdf-service",
    });
  }
});

test("replyRepoRoomAccessDecision answers an unsupported provider with 403, not a sign-in request", () => {
  const { res, state } = jsonResponse();

  assert.equal(
    replyRepoRoomAccessDecision(res, "gitlab.com/team/project", { kind: "unsupported_repo_provider" }),
    false
  );

  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, {
    error: "unsupported_repo_provider",
    code: "UNSUPPORTED_REPO_PROVIDER",
    message: unsupportedRepoProviderMessage("gitlab.com/team/project"),
    room_id: "gitlab.com/team/project",
  });
});

test("isRepoBackedRoomId classifies every room id shape", () => {
  const repoBacked = [
    "github.com/BrosInCode/letagents",
    "github.com/o/r",
    "bitbucket.org/poppix/pdf-service",
    "local/Users/someone",
    "gitlab.com/team/project",
    // GitLab with three or more segments, however the host is cased.
    "gitlab.com/group/sub/project",
    "gitlab.com/group/sub/deeper/project",
    "GitLab.com/Group/Sub/Project",
    // A host without a dot stays repo-shaped on purpose (see room-ids.ts).
    "github-work/acme/app",
    "team/design/ideas",
  ];
  const notRepoBacked = [
    "focus_5",
    "ABCX-7291",
    "ABCX-7291-L2QP",
    "team-chat",
    "team/design",
    "gitlab.com/group",
    "gitlab.com",
    // Branch rooms and other four-part ids on GitHub or Bitbucket are unchanged.
    "github.com/brosincode/letagents/focus/git:branch:bWFpbg",
    "bitbucket.org/ws/repo/extra",
    "gitlab-example.com/group/sub/project",
    "not-gitlab.com/group/sub/project",
    "gitlab.com.evil.example/group/sub/project",
    "git-room:local:0123456789abcdef:main",
    "git-room:github.com:owner/repo:branch:bWFpbg",
  ];

  for (const roomId of repoBacked) {
    assert.equal(isRepoBackedRoomId(roomId), true, roomId);
  }
  for (const roomId of notRepoBacked) {
    assert.equal(isRepoBackedRoomId(roomId), false, roomId);
  }
});

test("GitLab ids agree between isRepoBackedRoomId and parseRepoRoomName", async () => {
  const { parseRepoRoomName } = await import("../repo-workflow/repo-room.js");

  for (const roomId of [
    "gitlab.com/team/project",
    "gitlab.com/group/sub/project",
    "gitlab.com/group/sub/deeper/project",
    "GitLab.com/Group/Sub/Project",
  ]) {
    assert.equal(parseRepoRoomName(roomId)?.provider, "gitlab", roomId);
    assert.equal(isRepoBackedRoomId(roomId), true, roomId);
  }
  for (const roomId of ["gitlab.com/group", "gitlab.com"]) {
    assert.equal(parseRepoRoomName(roomId), null, roomId);
    assert.equal(isRepoBackedRoomId(roomId), false, roomId);
  }
});

test("a GitLab subgroup room is denied as an unsupported provider, not opened as an ad-hoc room", async () => {
  for (const roomName of ["gitlab.com/group/sub/project", "gitlab.com/group/project"]) {
    assert.deepEqual(
      await resolveRepoRoomAccessDecision({ roomName, sessionAccount: null }),
      { kind: "unsupported_repo_provider" },
      roomName
    );
  }
});

test("every unsupported-provider reply names the host, the shape and the .letagents.json workaround", () => {
  for (const [roomName, host] of [
    ["team/design/ideas", "team"],
    ["github-work/acme/app", "github-work"],
    // A dotted SSH alias, a real unsupported host and `local` get the same hint.
    ["github.com-work/acme/app", "github.com-work"],
    ["gitlab.com/group/sub/project", "gitlab.com"],
    ["bitbucket.org/poppix/pdf-service", "bitbucket.org"],
    ["local/Users/someone", "local"],
  ] as const) {
    const reply = jsonResponse();
    replyRepoRoomAccessDecision(reply.res, roomName, { kind: "unsupported_repo_provider" });
    assert.equal(reply.state.statusCode, 403, roomName);
    const body = reply.state.body as { error: string; code: string; message: string; room_id: string };
    assert.equal(body.error, "unsupported_repo_provider", roomName);
    assert.equal(body.code, "UNSUPPORTED_REPO_PROVIDER", roomName);
    assert.equal(body.room_id, roomName);
    assert.equal(body.message, unsupportedRepoProviderMessage(roomName), roomName);
    assert.match(body.message, /^Repo rooms are supported for github\.com repositories only\. /, roomName);
    assert.ok(body.message.includes(`host '${host}'`), roomName);
    assert.match(body.message, /name without two slashes, for example team-design-ideas/, roomName);
    assert.match(body.message, /\.letagents\.json file with a room field/, roomName);
  }
});

test("project repo access uses locator rooms without binding lookup", async () => {
  let bindingLookups = 0;
  const decision = await resolveProjectRepoRoomAccessDecision(
    {
      project: project("github.com/BrosInCode/letagents"),
      sessionAccount: null,
    },
    {
      getGitRoomBindingForRoom: async () => {
        bindingLookups += 1;
        throw new Error("binding lookup should not run for locator rooms");
      },
      resolveRepoRoomAccessDecision: async ({ roomName }) => {
        assert.equal(roomName, "github.com/BrosInCode/letagents");
        return { kind: "allow" };
      },
    }
  );

  assert.equal(bindingLookups, 0);
  assert.equal(decision.isRepoBacked, true);
  assert.equal(decision.roomName, "github.com/BrosInCode/letagents");
  assert.equal(decision.repoRoomName, "github.com/BrosInCode/letagents");
  assert.equal(decision.binding, null);
  assert.deepEqual(decision.decision, { kind: "allow" });
});

test("project repo access resolves binding-backed rooms to their GitHub repo", async () => {
  const checkedRepoRooms: string[] = [];
  const binding = gitRoomBinding("focus_27");

  const decision = await resolveProjectRepoRoomAccessDecision(
    {
      project: project("focus_27"),
      sessionAccount: null,
    },
    {
      getGitRoomBindingForRoom: async (roomId) => (roomId === "focus_27" ? binding : null),
      resolveRepoRoomAccessDecision: async ({ roomName }) => {
        checkedRepoRooms.push(roomName);
        return { kind: "auth_required" };
      },
    }
  );

  assert.deepEqual(checkedRepoRooms, ["github.com/BrosInCode/letagents"]);
  assert.equal(decision.isRepoBacked, true);
  assert.equal(decision.roomName, "focus_27");
  assert.equal(decision.repoRoomName, "github.com/BrosInCode/letagents");
  assert.equal(decision.binding, binding);
  assert.deepEqual(decision.decision, { kind: "auth_required" });
});

test("replyRepoRoomAccessDecision preserves auth-required response shape", () => {
  const previousBaseUrl = process.env.LETAGENTS_BASE_URL;
  process.env.LETAGENTS_BASE_URL = "https://letagents.test/";
  try {
    const { res, state } = jsonResponse();

    assert.equal(
      replyRepoRoomAccessDecision(res, "github.com/BrosInCode/letagents", {
        kind: "auth_required",
      }),
      false
    );

    assert.equal(state.statusCode, 401);
    assert.deepEqual(state.body, {
      error: "auth_required",
      code: "NOT_AUTHENTICATED",
      message: "Sign in to LetAgents to open this room",
      room_id: "github.com/BrosInCode/letagents",
      device_flow_url:
        "https://letagents.test/auth/device/start?room_id=github.com%2FBrosInCode%2Fletagents",
    });
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.LETAGENTS_BASE_URL;
    } else {
      process.env.LETAGENTS_BASE_URL = previousBaseUrl;
    }
  }
});

test("requireAdmin rejects unauthenticated requests before role lookup", async () => {
  const { res, state } = jsonResponse();

  assert.equal(
    await requireAdmin({ sessionAccount: null } as never, res, project("invite-room")),
    false
  );
  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "Authentication required" });
});

test("requireParticipant refuses every room to a caller with no sign-in, before any lookup", async () => {
  for (const room of [project("invite-room"), project("github.com/BrosInCode/letagents")]) {
    const { res, state } = jsonResponse();
    assert.equal(await requireParticipant({ sessionAccount: null } as never, res, room), false);
    assert.equal(state.statusCode, 401);
    assert.equal((state.body as { code?: string }).code, "NOT_AUTHENTICATED");
    assert.equal((state.body as { room_id?: string }).room_id, room.id);
  }
});

test("Git-room participant access accepts only the worker bearer's exact room", async () => {
  const scopedRequest = {
    authKind: "agent_session",
    sessionAccount: null,
    agentSession: { room_id: "focus_37" },
  } as never;
  const gitBackedFocusRoom = project("focus_37", "github.com/BrosInCode/letagents");

  const allowed = jsonResponse();
  assert.equal(
    await requireGitRoomParticipant(scopedRequest, allowed.res, gitBackedFocusRoom),
    true,
  );
  assert.equal(allowed.state.statusCode, null);

  const denied = jsonResponse();
  assert.equal(
    await requireGitRoomParticipant(scopedRequest, denied.res, project("focus_38", "github.com/BrosInCode/letagents")),
    false,
  );
  assert.equal(denied.state.statusCode, 403);
  assert.deepEqual(denied.state.body, { error: "Worker bearer is scoped to a different room." });
});

test("resolveGitHubRoomEntryDecision redirects non-GitHub repo room entries with an unsupported-provider reason", async () => {
  const decision = await resolveGitHubRoomEntryDecision({
    roomName: "bitbucket.org/poppix/pdf-service",
    sessionAccount: null,
    redirectTo: "/in/bitbucket.org/poppix/pdf-service",
  });

  assert.equal(decision.kind, "redirect");
  assert.ok(decision.kind === "redirect");
  const location = new URL(decision.location, "https://letagents.test");
  assert.equal(location.pathname, "/");
  assert.equal(location.searchParams.get("reason"), "repo_provider_unsupported");
  assert.equal(location.searchParams.get("room"), "bitbucket.org/poppix/pdf-service");
});

test("resolveGitHubRoomEntryDecision allows non-repo room entries", async () => {
  assert.deepEqual(
    await resolveGitHubRoomEntryDecision({
      roomName: "focus_5",
      sessionAccount: null,
      redirectTo: "/in/focus_5",
    }),
    { kind: "allow" }
  );
});
