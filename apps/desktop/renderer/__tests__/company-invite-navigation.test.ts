import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import { useAppCompanyNavigation } from "../src/composables/app/useAppCompany";

test("finishing a join cannot mark a replacement company invitation as joined", async () => {
  let finish!: (value: boolean) => void;
  const app = {
    company: { choose: () => new Promise<boolean>((resolve) => { finish = resolve; }) },
    companyInvite: ref({ kind: "join", organization: { login: "First", avatar_url: null } }),
    companyInviteRevision: ref(1), pendingCompanyInvite: ref("42"), inviteJustJoined: ref(false),
  };
  const { runCompanyInviteAction } = useAppCompanyNavigation(app);
  const joining = runCompanyInviteAction("join");
  app.pendingCompanyInvite.value = "43";
  app.companyInviteRevision.value += 1;
  finish(true);
  await joining;
  assert.equal(app.inviteJustJoined.value, false);
});

test("an unchanged invitation shows successful join even if its room list is still loading", async () => {
  const app = {
    company: { choose: async () => true },
    companyInvite: ref({ kind: "join", organization: { login: "First", avatar_url: null } }),
    companyInviteRevision: ref(1), pendingCompanyInvite: ref("42"), inviteJustJoined: ref(false),
  };
  await useAppCompanyNavigation(app).runCompanyInviteAction("join");
  assert.equal(app.inviteJustJoined.value, true);
});
