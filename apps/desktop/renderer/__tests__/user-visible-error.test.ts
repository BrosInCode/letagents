import assert from "node:assert/strict";
import test from "node:test";

import { safeUserVisibleErrorDetail } from "../src/domain/user-visible-error";

test("desktop API errors omit Electron transport and implementation prefixes", () => {
  assert.equal(
    safeUserVisibleErrorDetail(
      "Error invoking remote method 'desktop:room:conclude-focus-room': DesktopApiError: Connect GitHub to close this Focus Room.",
      "Could not close room.",
    ),
    "Connect GitHub to close this Focus Room.",
  );
});

test("credential redaction ignores Unicode format characters inside labels and token bodies", () => {
  for (const [detail, expected] of [
    ["Authori\u200bzation: Bearer secret-token-123456789", "Authorization:[redacted]"],
    ["access\u2060_token=secret-token-123456789", "access_token=[redacted]"],
    ["Bearer secret\u00ad-token-123456789", "Bearer [redacted]"],
    ["Be\u202earer secret-token-123456789", "Bearer [redacted]"],
  ]) {
    const safe = safeUserVisibleErrorDetail(detail, "Delivery failed.");
    assert.equal(safe, expected);
    assert.doesNotMatch(safe, /secret|\u200b|\u2060|\u00ad|\u202e/i);
  }
});
