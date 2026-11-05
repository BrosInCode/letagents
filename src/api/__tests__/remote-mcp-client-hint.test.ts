import assert from "node:assert/strict";
import test from "node:test";

import { clientHintFromUserAgent } from "../remote-mcp/implicit-session.js";

test("the User-Agent product token is the client hint of a stateless request; the rest of the header is dropped", () => {
  assert.equal(clientHintFromUserAgent("openai-mcp/1.0.0"), "openai-mcp");
  assert.equal(clientHintFromUserAgent("openai-mcp/1.0.0 (secret build 42; token=abc)"), "openai-mcp");
  assert.equal(clientHintFromUserAgent("Cursor/1.0.0"), "Cursor");
  assert.equal(clientHintFromUserAgent("  python-httpx/0.27.0"), "python-httpx");
  assert.equal(clientHintFromUserAgent("Mozilla/5.0 (Macintosh)"), "Mozilla");
  assert.equal(clientHintFromUserAgent(["node", "other"]), "node", "a repeated header reads its first value");
  assert.equal(clientHintFromUserAgent("x".repeat(70) + "/1"), null, "a product token over 64 characters is no hint");
  assert.equal(clientHintFromUserAgent("(no product)"), null);
  assert.equal(clientHintFromUserAgent(""), null);
  assert.equal(clientHintFromUserAgent(undefined), null);
});
