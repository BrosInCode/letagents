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
const { isUniqueViolationOf, errorChainMentions } = await import("../db/pg-errors.js");

function wrapped(cause: Record<string, unknown>) {
  return Object.assign(new Error('Failed query: insert into "x" values ($1)\nparams: 1'), { cause });
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
  // The fallback: only the cause's message names the constraint.
  assert.equal(isUniqueViolation(wrapped({ message: meterDuplicate.message })), true);
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

test("the shared helpers", () => {
  assert.equal(isUniqueViolationOf(wrapped(proposalDuplicate), "rental_patch_proposals_session_idempotency_uq"), true);
  assert.equal(isUniqueViolationOf(wrapped({ code: "23505", message: "duplicate key ... \"other_uq\"" }), "rental_patch_proposals_session_idempotency_uq"), false);
  assert.equal(errorChainMentions(wrapped({ message: "x y z" }), "y"), true);
  let deep: unknown = { message: "needle" };
  for (let i = 0; i < 6; i += 1) deep = { cause: deep };
  assert.equal(errorChainMentions(deep, "needle"), false, "more than five causes deep");
});
