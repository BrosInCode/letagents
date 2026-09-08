import assert from "node:assert/strict";
import test from "node:test";
import { parseCompanyLink } from "../main/company-link.js";

test("company links carry only an immutable organization destination", () => {
  assert.equal(parseCompanyLink("letagents://join/42"), "42");
  for (const value of ["https://join/42", "letagents://evil/42", "letagents://join/acme", "letagents://join/0", "letagents://join/42/extra", "letagents://join/42?api=https://evil.test", "letagents://user@join/42", "letagents://join:99/42", "letagents://join/42#token", "not a URL"]) {
    assert.equal(parseCompanyLink(value), null, value);
  }
});
