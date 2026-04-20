import assert from "node:assert/strict";
import test from "node:test";

import type { Request } from "express";

import {
  parseOptionalAgentPromptKind,
  parseOptionalReplyToMessageId,
  shouldIncludePromptOnlyMessages,
} from "../message-inputs.js";

function requestWithQuery(query: Request["query"]): Request {
  return { query } as Request;
}

test("parseOptionalAgentPromptKind accepts inline and auto values", () => {
  assert.equal(parseOptionalAgentPromptKind(undefined), null);
  assert.equal(parseOptionalAgentPromptKind(null), null);
  assert.equal(parseOptionalAgentPromptKind(""), null);
  assert.equal(parseOptionalAgentPromptKind(" inline "), "inline");
  assert.equal(parseOptionalAgentPromptKind("AUTO"), "auto");
});

test("parseOptionalAgentPromptKind rejects legacy and invalid values with route error text", () => {
  assert.throws(
    () => parseOptionalAgentPromptKind("join"),
    /agent_prompt_kind must be one of: inline, auto/
  );
  assert.throws(
    () => parseOptionalAgentPromptKind("other"),
    /agent_prompt_kind must be one of: inline, auto/
  );
  assert.throws(
    () => parseOptionalAgentPromptKind(1),
    /agent_prompt_kind must be one of: inline, auto/
  );
});

test("parseOptionalReplyToMessageId trims and validates message ids", () => {
  assert.equal(parseOptionalReplyToMessageId(undefined), null);
  assert.equal(parseOptionalReplyToMessageId(null), null);
  assert.equal(parseOptionalReplyToMessageId(""), null);
  assert.equal(parseOptionalReplyToMessageId(" msg_42 "), "msg_42");
});

test("parseOptionalReplyToMessageId rejects malformed reply targets", () => {
  assert.throws(
    () => parseOptionalReplyToMessageId("message_42"),
    /reply_to must be a valid message id/
  );
  assert.throws(
    () => parseOptionalReplyToMessageId("msg_"),
    /reply_to must be a valid message id/
  );
  assert.throws(
    () => parseOptionalReplyToMessageId(42),
    /reply_to must be a valid message id/
  );
});

test("shouldIncludePromptOnlyMessages accepts true-ish query strings only", () => {
  assert.equal(shouldIncludePromptOnlyMessages(requestWithQuery({})), false);
  assert.equal(
    shouldIncludePromptOnlyMessages(requestWithQuery({ include_prompt_only: "1" })),
    true
  );
  assert.equal(
    shouldIncludePromptOnlyMessages(requestWithQuery({ include_prompt_only: "TRUE" })),
    true
  );
  assert.equal(
    shouldIncludePromptOnlyMessages(requestWithQuery({ include_prompt_only: "false" })),
    false
  );
  assert.equal(
    shouldIncludePromptOnlyMessages(requestWithQuery({ include_prompt_only: ["true"] })),
    false
  );
});
