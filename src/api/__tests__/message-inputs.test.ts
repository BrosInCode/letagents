import assert from "node:assert/strict";
import test from "node:test";

import type { Request } from "express";

import {
  parseCreateMessageBody,
  parseOptionalAgentPromptKind,
  parseOptionalReplyToMessageId,
  parseOptionalThreadRootMessageId,
  shouldIncludePromptOnlyMessages,
} from "../messages/inputs.js";
import { RequestValidationError } from "../validation-error.js";

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
  for (const invalid of ["msg_0", "msg_01", "msg_2147483648", "msg_9007199254740993"]) {
    assert.throws(
      () => parseOptionalReplyToMessageId(invalid),
      /reply_to must be a valid message id/,
    );
  }
});

test("parseOptionalThreadRootMessageId trims and validates message ids", () => {
  assert.equal(parseOptionalThreadRootMessageId(undefined), null);
  assert.equal(parseOptionalThreadRootMessageId(null), null);
  assert.equal(parseOptionalThreadRootMessageId(""), null);
  assert.equal(parseOptionalThreadRootMessageId(" msg_7 "), "msg_7");
  assert.throws(
    () => parseOptionalThreadRootMessageId("message_7"),
    /thread_root_id must be a valid message id/,
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

test("parseCreateMessageBody passes through well-formed bodies", () => {
  const body = parseCreateMessageBody({
    sender: "EmmyMay",
    text: "hello",
    reply_to: "msg_3",
    thread_root_id: "msg_1",
    attachments: ["upl_0123456789abcdef"],
    client_message_id: "client-1",
  });
  assert.equal(body.sender, "EmmyMay");
  assert.equal(body.text, "hello");
  assert.equal(body.reply_to, "msg_3");
  assert.equal(body.thread_root_id, "msg_1");
  assert.equal(body.client_message_id, "client-1");
  assert.equal(body.agent_session_id, null);
});

test("parseCreateMessageBody rejects non-object bodies", () => {
  for (const value of [undefined, null, "text", 42, ["sender"]]) {
    assert.throws(() => parseCreateMessageBody(value), RequestValidationError);
  }
});

test("parseCreateMessageBody rejects non-string scalar fields", () => {
  assert.throws(() => parseCreateMessageBody({ sender: 42, text: "hi" }), /sender must be a string/);
  assert.throws(() => parseCreateMessageBody({ sender: "a", text: { nested: true } }), /text must be a string/);
  assert.throws(
    () => parseCreateMessageBody({ sender: "a", text: "hi", client_message_id: 9 }),
    /client_message_id must be a string/,
  );
  assert.throws(
    () => parseCreateMessageBody({ sender: "a", text: "hi", agent_session_id: 9 }),
    /agent_session_id must be a string/,
  );
});

test("parseCreateMessageBody treats null and missing optional fields as absent", () => {
  const body = parseCreateMessageBody({ sender: null, text: "hi", client_message_id: null });
  assert.equal(body.sender, null);
  assert.equal(body.client_message_id, null);
});
