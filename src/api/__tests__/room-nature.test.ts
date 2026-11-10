import assert from "node:assert/strict";
import test from "node:test";

import { isRepoBackedRoomId } from "../rooms/room-ids.js";
import {
  classifyRoomId,
  classifyRoomLocator,
  getRoomNature,
  isFocusRoomIdShape,
  isJoinCodeMainRoom,
  isJoinCodeShape,
  isRepoRoomByIdShape,
  isRepoShapedRoomId,
  isReservedMainRoomCreationId,
  matchesFocusRoomIdDatabaseCheck,
  parseFocusRoomLocator,
  parseGitHubRefParentRoomId,
  parseGitHubRepoRoomId,
  resolveRepoAccessTarget,
  type RepoBindingLike,
} from "../rooms/room-nature.js";
import {
  isInviteCode,
  isReservedMainRoomCreationId as routingIsReserved,
  normalizeRoomId,
  normalizeRoomName,
  parseFocusRoomLocator as routingParseFocusRoomLocator,
} from "../rooms/routing.js";

// mappers.ts pulls in the database client, which needs a URL but never
// connects in this file.
process.env.DB_URL ||= "postgresql://unused@127.0.0.1:1/unused";
const { toProject } = await import("../db/mappers.js");

// ── Frozen copies of the staging functions (73cd94dae) ────────────────────
// These are the oracle. They are copied, not imported, so that the module
// under test cannot change them. Do not edit them to make a test pass.

const LEGACY_INVITE_CODE_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2}$/;
function legacyIsInviteCode(value: string): boolean {
  return LEGACY_INVITE_CODE_PATTERN.test(value.toUpperCase());
}
function legacyNormalizeRoomId(identifier: string): string {
  const trimmed = identifier.trim();
  if (LEGACY_INVITE_CODE_PATTERN.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  return normalizeRoomName(trimmed);
}
const LEGACY_THREE_SEGMENT_ROOM_ID = /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/;
function legacyIsRepoBackedRoomId(roomId: string): boolean {
  if (LEGACY_THREE_SEGMENT_ROOM_ID.test(roomId)) return true;
  const segments = roomId.split("/");
  return segments.length >= 3 && segments[0].toLowerCase() === "gitlab.com";
}
function legacyIsReservedRoomId(roomId: string): boolean {
  return /^focus_\d+$/.test(roomId);
}
function legacyIsReservedMainRoomCreationId(roomId: string): boolean {
  const normalized = roomId.trim();
  return /^focus_\d+$/.test(normalized)
    || /^git-room:github\.com:/i.test(normalized)
    || /(?:^|\/)focus\//i.test(normalized);
}
function legacyParseFocusRoomLocator(roomLocator: string) {
  const marker = "/focus/";
  const index = roomLocator.lastIndexOf(marker);
  if (index < 0) return null;
  const parentRoomId = roomLocator.slice(0, index);
  const focusKey = roomLocator.slice(index + marker.length);
  if (!parentRoomId || !focusKey || focusKey.includes("/")) return null;
  return { parentRoomId, focusKey };
}
function legacyManualBindingRepo(roomId: string) {
  const match = /^github\.com\/([^/:\s]+)\/([^/:\s]+)$/i.exec(roomId.trim());
  return match ? { owner: match[1].toLowerCase(), name: match[2].toLowerCase() } : null;
}
function legacyRefParent(parentRoomId: string): string | null {
  return /^github\.com\/([^/\s]+\/[^/\s]+)$/.exec(parentRoomId)?.[1] ?? null;
}
/** resolveRoomOrReply's branch order. */
function legacyLocatorBranch(roomId: string): string {
  if (legacyParseFocusRoomLocator(roomId)) return "focus_locator";
  if (legacyIsInviteCode(roomId)) return "join_code";
  if (legacyIsReservedMainRoomCreationId(roomId)) return "reserved";
  return "room_name";
}

// ── Corpus of real id shapes ──────────────────────────────────────────────

const CORPUS = [
  // repository rooms
  "github.com/brosincode/letagents",
  "github.com/BrosInCode/letagents",
  "GitHub.com/Owner/Repo",
  "GITHUB.COM/acme/app",
  "www.github.com/acme/app",
  "ssh.github.com/acme/app",
  "ssh.github.com:443/acme/app",
  "github.com:443/acme/private",
  "https://github.com/BrosInCode/letagents.git",
  "git@github.com:BrosInCode/letagents.git",
  "ssh://git@ssh.github.com:443/acme/app.git",
  "https://x-access-token:TOKEN@github.com/acme/private.git",
  "github.com/acme/app:extra",
  "github.com/acme/my repo",
  "gitlab.com/group/sub/project",
  "gitlab.com/User/Repo",
  "GitLab.com/a/b/c/d",
  "bitbucket.org/ws/repo",
  "git.example.com/team/app",
  "github-work/acme/app",
  "local/Users/x",
  "team/design/notes",
  "github.com/acme",
  "github.com/acme/app/extra",
  // join codes
  "JA0E-4NYO",
  "ja0e-4nyo",
  "JA0E-4NYO-L2QP",
  "Ja0e-4NyO-l2qp",
  "ABCX-7291",
  "ABCD-12345",
  "ABC-1234",
  "ABCD-1234-EFGH-IJKL",
  " JA0E-4NYO ",
  // focus rooms
  "focus_12",
  "focus_1",
  "focus_0",
  "focus_007",
  "FOCUS_12",
  "focus_12a",
  "focus_",
  "github.com/brosincode/letagents/focus/git:branch:ZmVhdHVyZQ",
  "GitHub.com/Owner/Repo/focus/git:branch:abc",
  "github.com/acme/app/focus/task_7",
  "my-room/focus/task_7",
  "a/focus/b/c",
  "focus/x",
  "/focus/x",
  "git-room:github.com:acme/app",
  "Git-Room:GitHub.com:acme/app",
  // named rooms
  "my-room",
  "letagents",
  "My Room",
  "",
  "  ",
  "a/b",
  "github.com",
];

const CORPUS_WITH_NORMALIZED = [...new Set(CORPUS.flatMap((id) => [id, legacyNormalizeRoomId(id)]))];

test("join-code shape equals the staging isInviteCode for every id", () => {
  for (const id of CORPUS_WITH_NORMALIZED) {
    assert.equal(isJoinCodeShape(id), legacyIsInviteCode(id), id);
    assert.equal(isInviteCode(id), legacyIsInviteCode(id), id);
  }
});

test("normalizeRoomId is unchanged", () => {
  for (const id of CORPUS) {
    assert.equal(normalizeRoomId(id), legacyNormalizeRoomId(id), id);
  }
});

test("repo shape equals the staging isRepoBackedRoomId for every id", () => {
  for (const id of CORPUS_WITH_NORMALIZED) {
    assert.equal(isRepoShapedRoomId(id), legacyIsRepoBackedRoomId(id), id);
    assert.equal(isRepoBackedRoomId(id), legacyIsRepoBackedRoomId(id), id);
  }
});

test("focus shapes, reserved ids and focus locators equal staging", () => {
  for (const id of CORPUS_WITH_NORMALIZED) {
    assert.equal(isFocusRoomIdShape(id), legacyIsReservedRoomId(id), id);
    assert.equal(isReservedMainRoomCreationId(id), legacyIsReservedMainRoomCreationId(id), id);
    assert.equal(routingIsReserved(id), legacyIsReservedMainRoomCreationId(id), id);
    assert.deepEqual(parseFocusRoomLocator(id), legacyParseFocusRoomLocator(id), id);
    assert.deepEqual(routingParseFocusRoomLocator(id), legacyParseFocusRoomLocator(id), id);
  }
});

test("GitHub repo parsers equal the two staging regexes", () => {
  for (const id of CORPUS_WITH_NORMALIZED) {
    assert.deepEqual(parseGitHubRepoRoomId(id), legacyManualBindingRepo(id), id);
    assert.equal(parseGitHubRefParentRoomId(id), legacyRefParent(id), id);
  }
});

test("classifyRoomLocator follows resolveRoomOrReply's branch order", () => {
  for (const id of CORPUS_WITH_NORMALIZED) {
    assert.equal(classifyRoomLocator(id).type, legacyLocatorBranch(id), id);
  }
});

test("classifyRoomId: one expected value per real id", () => {
  const expected: Record<string, string> = {
    "github.com/brosincode/letagents": "repo",
    "GitHub.com/Owner/Repo": "repo",
    "www.github.com/acme/app": "repo",
    "ssh.github.com/acme/app": "repo",
    "ssh.github.com:443/acme/app": "named",
    "gitlab.com/group/sub/project": "repo",
    "bitbucket.org/ws/repo": "repo",
    "github-work/acme/app": "repo",
    "team/design/notes": "repo",
    "github.com/acme": "named",
    "github.com/acme/app/extra": "named",
    "JA0E-4NYO": "join_code",
    "ja0e-4nyo": "join_code",
    "JA0E-4NYO-L2QP": "join_code",
    "ABCD-12345": "named",
    " JA0E-4NYO ": "named",
    "focus_12": "focus",
    "focus_0": "focus",
    "FOCUS_12": "named",
    "github.com/acme/app/focus/task_7": "named",
    "my-room": "named",
    "": "named",
  };
  for (const [id, origin] of Object.entries(expected)) {
    assert.equal(classifyRoomId(id), origin, id);
  }
});

test("toProject code and name are unchanged for every id and kind", () => {
  for (const id of CORPUS_WITH_NORMALIZED) {
    for (const kind of ["main", "focus"]) {
      const row = {
        id,
        display_name: "Room",
        jev_routing_enabled: true,
        kind,
        parent_room_id: kind === "focus" ? "github.com/acme/app" : null,
        focus_key: null,
        source_task_id: null,
        focus_status: null,
        focus_parent_visibility: null,
        focus_activity_scope: null,
        focus_github_event_routing: null,
        focus_archived_at: null,
        git_lifecycle_event_order_at: null,
        concluded_at: null,
        conclusion_summary: null,
        conclusion_details: null,
        organization_id: null,
        created_at: "2026-11-10T00:00:00.000Z",
      };
      const project = toProject(row);
      const invite = legacyIsInviteCode(id);
      assert.equal(project.code, invite ? id : null, id);
      assert.equal(project.name, invite ? undefined : id, id);
      const nature = getRoomNature(row);
      assert.equal(nature.isFocus, kind === "focus");
      assert.equal(nature.accessRoomId, row.parent_room_id ?? id);
      assert.equal(isJoinCodeMainRoom(row), kind === "main" && legacyIsInviteCode(id), id);
    }
  }
});

test("getRoomNature origin per kind", () => {
  assert.equal(getRoomNature({ id: "focus_12", kind: "focus", parent_room_id: "github.com/a/b" }).origin, "focus");
  assert.equal(getRoomNature({ id: "JA0E-4NYO", kind: "main" }).origin, "join_code");
  assert.equal(getRoomNature({ id: "github.com/brosincode/letagents", kind: "main" }).origin, "repo");
  assert.equal(getRoomNature({ id: "my-room", kind: "main" }).origin, "named");
});

// ── The two repo-access behaviours ────────────────────────────────────────

type Binding = RepoBindingLike & { room_id: string };

/** Frozen copy of staging resolveProjectRepoAccessTarget (rooms/access.ts). */
async function legacyResolveProjectRepoAccessTarget(
  project: { id: string; parent_room_id: string | null },
  getBinding: (roomId: string) => Promise<Binding | null>,
) {
  const accessRoomId = project.parent_room_id ?? project.id;
  if (legacyIsRepoBackedRoomId(accessRoomId)) {
    return { roomName: accessRoomId, repoRoomName: accessRoomId, binding: null };
  }
  for (const roomId of [...new Set([accessRoomId, project.id])]) {
    const binding = await getBinding(roomId);
    if (!binding) continue;
    if (binding.provider !== "github") continue;
    return { roomName: roomId, repoRoomName: `${binding.host}/${binding.repository_full_name}`, binding };
  }
  return null;
}

test("repo access: shape-only and binding-fallback behaviours both equal staging", async () => {
  const bindings = new Map<string, Binding>([
    ["focus_9", { room_id: "focus_9", provider: "github", host: "github.com", repository_full_name: "acme/app" }],
    ["my-room", { room_id: "my-room", provider: "github", host: "github.com", repository_full_name: "acme/bound" }],
  ]);
  const getBinding = async (roomId: string) => bindings.get(roomId) ?? null;
  const projects = [
    { id: "github.com/acme/app", kind: "main", parent_room_id: null },
    { id: "focus_3", kind: "focus", parent_room_id: "github.com/acme/app" },
    { id: "focus_9", kind: "focus", parent_room_id: "my-room" },
    { id: "my-room", kind: "main", parent_room_id: null },
    { id: "JA0E-4NYO", kind: "main", parent_room_id: null },
    { id: "team/design/notes", kind: "main", parent_room_id: null },
  ];
  for (const project of projects) {
    assert.equal(isRepoRoomByIdShape(project), legacyIsRepoBackedRoomId(project.parent_room_id ?? project.id));
    assert.deepEqual(
      await resolveRepoAccessTarget(project, getBinding),
      await legacyResolveProjectRepoAccessTarget(project, getBinding),
      project.id,
    );
  }
  // The disagreement the module keeps: a bound room whose id is not repo-shaped.
  const bound = projects[3]!;
  assert.equal(isRepoRoomByIdShape(bound), false);
  assert.equal((await resolveRepoAccessTarget(bound, getBinding))?.repoRoomName, "github.com/acme/bound");
});

test("the focus id check in code accepts ids the database check rejects", () => {
  assert.equal(isFocusRoomIdShape("focus_0"), true);
  assert.equal(matchesFocusRoomIdDatabaseCheck("focus_0"), false);
  assert.equal(isFocusRoomIdShape("focus_007"), true);
  assert.equal(matchesFocusRoomIdDatabaseCheck("focus_007"), false);
  assert.equal(matchesFocusRoomIdDatabaseCheck("focus_12"), true);
});
