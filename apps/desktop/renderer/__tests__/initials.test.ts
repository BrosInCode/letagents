import assert from "node:assert/strict";
import test from "node:test";

import { loginInitials, wordInitials } from "../src/domain/initials";

test("wordInitials takes the first letter of the first two words", () => {
  assert.equal(wordInitials("Alice Smith", "?"), "AS");
  assert.equal(wordInitials("alice smith jones", "?"), "AS");
  assert.equal(wordInitials("alice", "?"), "A");
});

test("wordInitials falls back when the label is empty", () => {
  assert.equal(wordInitials("", "LA"), "LA");
  assert.equal(wordInitials("   ", "A"), "A");
});

test("loginInitials uppercases the first two characters", () => {
  assert.equal(loginInitials("emmymay"), "EM");
  assert.equal(loginInitials("x"), "X");
  assert.equal(loginInitials(""), "");
});
