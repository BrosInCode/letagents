import assert from "node:assert/strict";
import test from "node:test";
import { companyListsEntry, companyProjectGroups, mergeCompanyRooms, showsCompanyHome } from "../src/domain/company-navigation.js";
import { appFunction } from "./app-source";
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

test("a room the selected company does not list is left for Personal & shared on an explicit open", () => {
  const projects = buildSidebarProjectGroups({ currentParentRoom: parent, focusRooms: [], accountRooms: mergeCompanyRooms([], [room]) });
  const companyParent = projects.find((project) => project.parent.gitRoom?.repository.id === "100")!.parent;
  // An Inbox or My Work item for a personal repo, with Acme selected.
  assert.equal(companyListsEntry(projects, "42", [room], parent.id), false);
  assert.equal(companyListsEntry(projects, "42", [room], companyParent.id), true);
  assert.equal(companyListsEntry(projects, null, [], parent.id), true);
  // Every explicit open goes through the same check: snapshots and sidebar entries.
  for (const name of ["openRoomSnapshot", "selectSidebarEntry"]) {
    assert.match(appFunction(name), /leaveCompanyUnlessListed\(\)/, `${name} leaves a company that does not list the room`);
  }
});

test("the company home replaces a room only for an invitation or a selected company that does not list it", () => {
  const projects = buildSidebarProjectGroups({ currentParentRoom: parent, focusRooms: [], accountRooms: mergeCompanyRooms([], [room]) });
  const closedFocusRoom = { id: "room:focus:focus_9", type: "room" };
  assert.equal(showsCompanyHome({ pendingInvite: null, activeEntry: closedFocusRoom, selectedId: null, sidebarProjects: projects }), false);
  assert.equal(showsCompanyHome({ pendingInvite: null, activeEntry: closedFocusRoom, selectedId: "42", sidebarProjects: companyProjectGroups(projects, "42", [room]) }), true);
  assert.equal(showsCompanyHome({ pendingInvite: null, activeEntry: { id: parent.id, type: "room" }, selectedId: null, sidebarProjects: projects }), false);
  assert.equal(showsCompanyHome({ pendingInvite: "42", activeEntry: { id: "inbox", type: "inbox" }, selectedId: null, sidebarProjects: projects }), true);
  assert.equal(showsCompanyHome({ pendingInvite: null, activeEntry: { id: "inbox", type: "inbox" }, selectedId: "42", sidebarProjects: [] }), false);
});

