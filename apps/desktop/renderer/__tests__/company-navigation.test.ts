import assert from "node:assert/strict";
import test from "node:test";
import { companyProjectGroups, mergeCompanyRooms } from "../src/domain/company-navigation.js";
import { buildSidebarProjectGroups } from "../src/domain/sidebar-rooms.js";

const room = { github_repo_id: "100", room_id: "github.com/acme/app", display_name: "app", full_name: "acme/app", organization_id: "42", visibility: "private" as const };
const parent = { id: "personal", type: "room" as const, kind: "parent" as const, roomIdentifier: "github.com/alice/personal", title: "personal", meta: "", sectionLabel: "", headline: "", description: "", latestMessageId: null, latestMessageAt: null, hasUnread: false, pinned: false, source: "account" as const };

test("company discovery adds unopened repo rooms without duplicating known ones or losing pins", () => {
  const discovered = mergeCompanyRooms([], [room]);
  assert.equal(discovered[0].gitRoom?.repository.id, "100");
  discovered[0].pinned = true;
  assert.deepEqual(mergeCompanyRooms(discovered, [room]), discovered);
  const projects = buildSidebarProjectGroups({ currentParentRoom: parent, focusRooms: [], accountRooms: discovered });
  const company = companyProjectGroups(projects, "42", [room]);
  assert.equal(company.length, 1);
  assert.equal(company[0].parent.roomIdentifier, room.room_id);
  assert.equal(company[0].parent.pinned, true);
  assert.equal(companyProjectGroups(projects, null, []).length, 2);
});

test("revoked or failed company discovery does not fall back to cached company groups", () => {
  const projects = buildSidebarProjectGroups({ currentParentRoom: parent, focusRooms: [], accountRooms: mergeCompanyRooms([], [room]) });
  assert.deepEqual(companyProjectGroups(projects, "42", []), []);
  assert.equal(companyProjectGroups(projects, null, []).length, 2);
});

test("company filtering preserves existing child rooms and unread state", () => {
  const projects = buildSidebarProjectGroups({ currentParentRoom: parent, focusRooms: [], accountRooms: mergeCompanyRooms([], [room]) });
  const group = projects.find((project) => project.parent.gitRoom?.repository.id === "100")!;
  group.parent.hasUnread = true;
  group.branchRooms.push({ ...parent, id: "branch", kind: "branch", roomIdentifier: "focus_1" });
  assert.equal(companyProjectGroups(projects, "42", [room])[0], group);
  assert.equal(group.branchRooms.length, 1);
  assert.equal(group.parent.hasUnread, true);
});
