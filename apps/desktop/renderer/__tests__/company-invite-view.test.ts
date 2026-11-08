import assert from "node:assert/strict";
import test from "node:test";
import { companyInviteView, isCompanyLinkId } from "../../../../shared/ui/company-invite/view.js";
import { companyLinkIdFromInput } from "../src/domain/join-room-input.js";

const base = { id: "42", status: "ready" as const, organizations: [], invitations: [], ssoRequired: [], viewerLogin: "alex" };
const org = { github_org_id: "42", login: "herotel", avatar_url: null, role: "member" as const, setup: true, joined: false };

test("a company link shows what GitHub says about the person and the organization", () => {
  assert.equal(companyInviteView({ ...base, organizations: [org] }).kind, "join");
  assert.equal(companyInviteView({ ...base, organizations: [{ ...org, setup: false }] }).kind, "waiting");
  assert.equal(companyInviteView({ ...base, organizations: [{ ...org, setup: false, role: "owner" }] }).kind, "setup");
  const joined = companyInviteView({ ...base, organizations: [{ ...org, joined: true }], justJoined: true, roomCount: 3 });
  assert.deepEqual(joined, { kind: "joined", organization: { login: "herotel", avatar_url: null }, roomCount: 3, justJoined: true });
  assert.equal(companyInviteView({ ...base, invitations: [{ github_org_id: "42", login: "herotel", avatar_url: null }] }).kind, "invited");
  assert.equal(companyInviteView({ ...base, ssoRequired: [{ github_org_id: "42", login: null }] }).kind, "sso");
  assert.deepEqual(companyInviteView(base), { kind: "not_member", viewerLogin: "alex" });
});

test("a missing permission or an outage never reads as 'not a member'", () => {
  assert.deepEqual(companyInviteView({ ...base, status: "github_access_required", accessReason: "signin" }), { kind: "github_access_required", reason: "signin" });
  assert.equal(companyInviteView({ ...base, status: "unavailable" }).kind, "unavailable");
  assert.equal(companyInviteView({ ...base, status: "loading" }).kind, "loading");
  assert.equal(companyInviteView({ ...base, id: "herotel" }).kind, "invalid");
});

test("company link IDs and pasted company links accept GitHub's numeric organization IDs only", () => {
  assert.equal(isCompanyLinkId("42"), true);
  for (const value of ["0", "042", "herotel", "42/rooms", "", "1".repeat(21)]) assert.equal(isCompanyLinkId(value), false, value);
  assert.equal(companyLinkIdFromInput("https://letagents.chat/company/42"), "42");
  assert.equal(companyLinkIdFromInput("  letagents://company/42 "), "42");
  for (const value of [
    "https://evil.test/company/42", "https://letagents.chat/company/herotel", "https://letagents.chat/company/42?x=1",
    "https://user@letagents.chat/company/42", "letagents://join/42", "ABCD-1234", "https://letagents.chat/in/room",
  ]) assert.equal(companyLinkIdFromInput(value), null, value);
});
