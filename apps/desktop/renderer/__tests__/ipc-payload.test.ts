import assert from "node:assert/strict";
import test from "node:test";
import { reactive, ref } from "vue";

import { toIpcPayload } from "../src/domain/ipc-payload";

test("vue reactive objects are not structured-clone-safe without conversion", () => {
  const gitRoom = reactive({ provider: "git", ref: { type: "branch", name: "staging" } });
  assert.throws(() => structuredClone(gitRoom), /could not be cloned/);
});

test("toIpcPayload produces a structured-clone-safe deep copy of reactive state", () => {
  const gitRoom = reactive({
    provider: "git",
    host: "local",
    ref: { type: "branch", name: "staging", defaultBranch: "main" },
    visibility: "local",
  });
  const payload = toIpcPayload({ roomIdentifier: "room_1", roomGitRoom: gitRoom, model: null });
  const cloned = structuredClone(payload);
  assert.deepEqual(cloned, {
    roomIdentifier: "room_1",
    roomGitRoom: {
      provider: "git",
      host: "local",
      ref: { type: "branch", name: "staging", defaultBranch: "main" },
      visibility: "local",
    },
    model: null,
  });
});

test("toIpcPayload passes primitives and null through and drops undefined members", () => {
  assert.equal(toIpcPayload(null), null);
  assert.equal(toIpcPayload(undefined), undefined);
  assert.equal(toIpcPayload("x"), "x");
  const viaRef = ref({ nested: { flag: true }, missing: undefined });
  const payload = toIpcPayload({ value: viaRef.value });
  assert.deepEqual(structuredClone(payload), { value: { nested: { flag: true } } });
});
