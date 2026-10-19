import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConversationPerson } from "../../../../shared/conversation-contracts.d.mts";
import { openConversationWithPerson } from "../src/domain/open-conversation-with-person";
import type { PersonTarget } from "../src/domain/person-target";

const target: PersonTarget = { login: "Ana-Lee", displayName: "Ana Lee", avatarUrl: null };
const ana: ConversationPerson = { id: "acc_ana", login: "ana-lee", display_name: "Ana", avatar_url: null };

function fakeApi(people: ConversationPerson[], failures: { people?: unknown; create?: unknown } = {}) {
  const calls = { people: [] as string[], create: [] as string[][] };
  return {
    calls,
    api: {
      async people(query: string) {
        calls.people.push(query);
        if ("people" in failures) throw failures.people;
        return { people };
      },
      async create(accountIds: string[]) {
        calls.create.push(accountIds);
        if ("create" in failures) throw failures.create;
        return { conversation_id: "conv_123" };
      },
    },
  };
}

describe("openConversationWithPerson", () => {
  it("matches the login case-insensitively, then creates the conversation", async () => {
    const { api, calls } = fakeApi([ana]);
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(calls.people, ["Ana-Lee"]);
    assert.deepEqual(calls.create, [["acc_ana"]]);
    assert.deepEqual(result, { status: "opened", conversationId: "conv_123" });
  });

  it("returns not_found and does not create when no person matches", async () => {
    const { api, calls } = fakeApi([]);
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(result, { status: "not_found" });
    assert.deepEqual(calls.create, []);
  });

  it("returns ambiguous and does not create when two accounts share the login", async () => {
    const { api, calls } = fakeApi([ana, { ...ana, id: "acc_ana_2" }]);
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(result, { status: "ambiguous" });
    assert.deepEqual(calls.create, []);
  });

  it("ignores a fuzzy result with a different login", async () => {
    const { api, calls } = fakeApi([{ ...ana, id: "acc_other", login: "ana-lee-2" }]);
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(result, { status: "not_found" });
    assert.deepEqual(calls.create, []);
  });

  it("returns self for the signed-in login, ignoring case, before any api call", async () => {
    const { api, calls } = fakeApi([ana]);
    const result = await openConversationWithPerson({ ...target, login: "ANA-lee" }, "ana-lee", api);
    assert.deepEqual(result, { status: "self" });
    assert.deepEqual(calls.people, []);
    assert.deepEqual(calls.create, []);
  });

  it("does not treat a missing viewer as a match", async () => {
    const { api } = fakeApi([ana]);
    const result = await openConversationWithPerson(target, null, api);
    assert.deepEqual(result, { status: "opened", conversationId: "conv_123" });
  });

  it("returns not_found without a search for a login under two characters", async () => {
    const { api, calls } = fakeApi([ana]);
    const result = await openConversationWithPerson({ ...target, login: "a" }, "owen", api);
    assert.deepEqual(result, { status: "not_found" });
    assert.deepEqual(calls.people, []);
  });

  it("returns the thrown error message when the people search fails", async () => {
    const { api, calls } = fakeApi([ana], { people: new Error("Search is down") });
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(result, { status: "failed", message: "Search is down" });
    assert.deepEqual(calls.create, []);
  });

  it("returns the thrown error message when create fails", async () => {
    const { api } = fakeApi([ana], { create: new Error("Blocked by policy") });
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(result, { status: "failed", message: "Blocked by policy" });
  });

  it("strips the Electron IPC prefix from a create failure before showing it", async () => {
    const thrown = new Error("Error invoking remote method 'desktop:conversations:create': Error: Try again later");
    const { api } = fakeApi([ana], { create: thrown });
    const result = await openConversationWithPerson(target, "owen", api);
    assert.deepEqual(result, { status: "failed", message: "Try again later" });
  });

  it("uses the generic message when a thrown error has no usable message", async () => {
    const generic = "LetAgents could not open that conversation.";
    for (const thrown of [{ code: 500 }, new Error("   "), "plain text", null]) {
      const { api } = fakeApi([ana], { create: thrown });
      const result = await openConversationWithPerson(target, "owen", api);
      assert.deepEqual(result, { status: "failed", message: generic });
    }
  });
});
