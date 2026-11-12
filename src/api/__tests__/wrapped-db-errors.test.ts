/**
 * Drizzle 0.45 wraps a driver error: the wrapper's `code` is undefined, its
 * message is "Failed query: <sql>", and the Postgres error (SQLSTATE `code`,
 * `constraint`, and a message naming the constraint) is its `cause`. Each
 * check below must see through that wrapper.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { isUniqueViolation } = await import("../rental/usage-ingest.js");
const patchProposal = await import("../rental/patch-proposal.js");
const journal = await import("../rental/signed-change-journal.js");
const { isUniqueViolationOf, pgErrorMentions } = await import("../db/pg-errors.js");

function wrapped(cause: Record<string, unknown>, params = "1") {
  return Object.assign(new Error(`Failed query: insert into "x" values ($1)\nparams: ${params}`), { cause });
}

const meterDuplicate = {
  code: "23505",
  constraint: "rental_usage_meters_session_idempotency_uq",
  message: 'duplicate key value violates unique constraint "rental_usage_meters_session_idempotency_uq"',
};
const proposalDuplicate = {
  code: "23505",
  constraint: "rental_patch_proposals_session_idempotency_uq",
  message: 'duplicate key value violates unique constraint "rental_patch_proposals_session_idempotency_uq"',
};

test("usage ingest sees a wrapped duplicate meter row", () => {
  assert.equal(isUniqueViolation(wrapped(meterDuplicate)), true);
  // A Postgres error without the constraint field: its message decides.
  assert.equal(isUniqueViolation(wrapped({ code: "23505", message: meterDuplicate.message })), true);
  // Hostile: the provider's idempotency key in Drizzle's params spells the name.
  assert.equal(isUniqueViolation(wrapped({ code: "23503", message: "violates foreign key constraint" }, "rental_usage_meters_session_idempotency_uq")), false);
  assert.equal(isUniqueViolation(meterDuplicate), true, "an unwrapped error still counts");
  assert.equal(isUniqueViolation(wrapped({ code: "23503", message: "foreign key" })), false);
});

test("patch proposals and the signed change journal see a wrapped duplicate idempotency key", () => {
  for (const check of [patchProposal.isIdempotencyUniqueViolation, journal.isIdempotencyUniqueViolation]) {
    assert.equal(check(wrapped(proposalDuplicate)), true);
    assert.equal(check(proposalDuplicate), true);
    assert.equal(check(wrapped({ ...proposalDuplicate, constraint: "rental_patch_proposals_pkey", message: "duplicate key value violates unique constraint \"rental_patch_proposals_pkey\"" })), false, "another constraint");
    assert.equal(check(new Error("rental_patch_proposals_session_idempotency_uq")), false, "a message alone is not a duplicate key");
  }
});

test("isUniqueViolationOf: the constraint field decides; the message only when the field is absent, by the whole name", () => {
  const name = "rental_patch_proposals_session_idempotency_uq";
  assert.equal(isUniqueViolationOf(wrapped(proposalDuplicate), name), true);
  // The field names another constraint, even one whose name starts with this one.
  assert.equal(isUniqueViolationOf(wrapped({ code: "23505", constraint: `${name}_v2`, message: `duplicate key value violates unique constraint "${name}_v2"` }), name), false);
  assert.equal(isUniqueViolationOf(wrapped({ code: "23505", constraint: "other_uq", message: `mentions ${name} somehow` }), name), false, "the field wins over the message");
  // No field: the whole name in the Postgres message.
  assert.equal(isUniqueViolationOf(wrapped({ code: "23505", message: `duplicate key value violates unique constraint "${name}"` }), name), true);
  assert.equal(isUniqueViolationOf(wrapped({ code: "23505", message: `duplicate key value violates unique constraint "${name}_v2"` }), name), false);
  // Hostile: the name only in Drizzle's params; the Postgres error is about another constraint.
  assert.equal(isUniqueViolationOf(wrapped({ code: "23505", message: 'duplicate key value violates unique constraint "rental_patch_proposals_pkey"' }, name), name), false);
  assert.equal(isUniqueViolationOf(wrapped({ code: "23503", constraint: name }), name), false, "not a duplicate key");
});

test("pgErrorMentions reads only the Postgres error, never Drizzle's message with its params", () => {
  const name = "rental_usage_meters_session_idempotency_uq";
  assert.equal(pgErrorMentions(wrapped({ code: "23505", message: `violates "${name}"` }), name), true);
  // Hostile: a provider-chosen idempotency key in the params spells the name.
  assert.equal(pgErrorMentions(wrapped({ code: "23505", message: 'violates "other_uq"' }, `'${name}'`), name), false);
  assert.equal(pgErrorMentions(new Error(`Failed query: ...\nparams: ${name}`), name), false, "no Postgres error at all");
  assert.equal(pgErrorMentions(wrapped({ code: "23505", message: `violates "${name}_v2"` }), name), false, "whole name only");
  let deep: unknown = { code: "23505", message: name };
  for (let i = 0; i < 6; i += 1) deep = { cause: deep };
  assert.equal(pgErrorMentions(deep, name), false, "more than five causes deep");
});
