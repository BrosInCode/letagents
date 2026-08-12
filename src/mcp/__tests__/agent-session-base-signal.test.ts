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
  const priorSessions = [{ display_name: "MistyMorrow 2", requested_base_display_name: "MistyMorrow" }];
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 2",
      identityDisplayName: "OwlSolar",
      priorSessions,
    }),
    "MistyMorrow",
    "resume of the decorated label declares the original base so the server converges it",
  );
});

test("restarting an OLDER concurrent sibling still finds its exact-label base", () => {
  // Lineage is most-recent-first: B ("MistyMorrow 1") updated after A
  // ("MistyMorrow 2"). Restarting A replays "MistyMorrow 2"; a latest-only
  // lookup would compare against B, mismatch, and misread A's restart as a
  // deliberate rename — the exact-label lineage match must find A's base.
  const priorSessions = [
    { display_name: "MistyMorrow 1", requested_base_display_name: "MistyMorrow" },
    { display_name: "MistyMorrow 2", requested_base_display_name: "MistyMorrow" },
  ];
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 2",
      identityDisplayName: "OwlSolar",
      priorSessions,
    }),
    "MistyMorrow",
    "older sibling's decorated label resolves through its own recorded base",
  );
});

test("an explicit name that matches no stored label is a deliberate rename", () => {
  const priorSessions = [{ display_name: "MistyMorrow 2", requested_base_display_name: "MistyMorrow" }];
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 47",
      identityDisplayName: "OwlSolar",
      priorSessions,
    }),
    "MistyMorrow 47",
    "a first-time deliberate numeric rename is its own base, not reduced to the prior base",
  );
});

test("no explicit name falls back to the most recent recorded base, then the identity name", () => {
  assert.equal(
    resolveClientRequestedBase({
      identityDisplayName: "OwlSolar",
      priorSessions: [
        { display_name: "MistyMorrow 1", requested_base_display_name: "MistyMorrow" },
        { display_name: "Elder 3", requested_base_display_name: "Elder" },
      ],
    }),
    "MistyMorrow",
    "most recent recorded base wins",
  );
  assert.equal(
    resolveClientRequestedBase({ identityDisplayName: "OwlSolar", priorSessions: [] }),
    "OwlSolar",
  );
  // Legacy sessions with no recorded base are skipped in the fallback.
  assert.equal(
    resolveClientRequestedBase({
      identityDisplayName: "OwlSolar",
      priorSessions: [
        { display_name: "MistyMorrow 2", requested_base_display_name: null },
        { display_name: "Elder 3", requested_base_display_name: "Elder" },
      ],
    }),
    "Elder",
  );
});

test("replaying a prior label whose session has no recorded base keeps the label (fail closed)", () => {
  assert.equal(
    resolveClientRequestedBase({
      explicitDisplayName: "MistyMorrow 2 1 1 1",
      identityDisplayName: "OwlSolar",
      priorSessions: [{ display_name: "MistyMorrow 2 1 1 1", requested_base_display_name: null }],
    }),
    "MistyMorrow 2 1 1 1",
    "legacy sessions without provenance never strip — server also fails closed",
  );
});
