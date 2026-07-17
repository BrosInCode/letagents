import assert from "node:assert/strict";
import test from "node:test";

import { resolveClientRequestedBase } from "../server/runtime/agent-sessions.js";

test("an explicit fresh name is deliberate intent and is its own base", () => {
  assert.equal(
    resolveClientRequestedBase({ explicitDisplayName: "MistyMorrow", identityDisplayName: "OwlSolar" }),
    "MistyMorrow",
  );
  // A numeric-ending custom name is never demoted: it IS the declared base.
  assert.equal(
    resolveClientRequestedBase({ explicitDisplayName: "Agent 47", identityDisplayName: "OwlSolar" }),
    "Agent 47",
  );
});

test("replaying a prior stored session label reuses that session's recorded base", () => {
  const priorSession = { display_name: "MistyMorrow 2", requested_base_display_name: "MistyMorrow" };
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 2",
      identityDisplayName: "OwlSolar",
      priorSession,
    }),
    "MistyMorrow",
    "resume of the decorated label declares the original base so the server converges it",
  );
});

test("an explicit name that differs from the prior label is a deliberate rename", () => {
  const priorSession = { display_name: "MistyMorrow 2", requested_base_display_name: "MistyMorrow" };
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 47",
      identityDisplayName: "OwlSolar",
      priorSession,
    }),
    "MistyMorrow 47",
    "a first-time deliberate numeric rename is its own base, not reduced to the prior base",
  );
});

test("no explicit name falls back to the prior recorded base, then the identity name", () => {
  assert.equal(
    resolveClientRequestedBase({
      identityDisplayName: "OwlSolar",
      priorSession: { display_name: "MistyMorrow 2", requested_base_display_name: "MistyMorrow" },
    }),
    "MistyMorrow",
  );
  assert.equal(
    resolveClientRequestedBase({ identityDisplayName: "OwlSolar", priorSession: null }),
    "OwlSolar",
  );
  // A legacy prior session with no recorded base contributes nothing.
  assert.equal(
    resolveClientRequestedBase({
      identityDisplayName: "OwlSolar",
      priorSession: { display_name: "MistyMorrow 2", requested_base_display_name: null },
    }),
    "OwlSolar",
  );
});

test("replaying a prior label whose session has no recorded base keeps the label (fail closed)", () => {
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 2 1 1 1",
      identityDisplayName: "OwlSolar",
      priorSession: { display_name: "MistyMorrow 2 1 1 1", requested_base_display_name: null },
    }),
    "MistyMorrow 2 1 1 1",
    "legacy sessions without provenance never strip — server also fails closed",
  );
});
