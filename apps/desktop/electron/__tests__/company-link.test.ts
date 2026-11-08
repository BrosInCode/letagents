import assert from "node:assert/strict";
import test from "node:test";
import { parseCompanyLink } from "../main/company-link.js";

test("company links carry only an immutable organization destination", () => {
  assert.equal(parseCompanyLink("letagents://company/42"), "42");
  for (const value of ["https://company/42", "letagents://join/42", "letagents://evil/42", "letagents://company/acme", "letagents://company/0", "letagents://company/42/extra", "letagents://company/42?api=https://evil.test", "letagents://user@company/42", "letagents://company:99/42", "letagents://company/42#token", "not a URL"]) {
    assert.equal(parseCompanyLink(value), null, value);
  }
});
