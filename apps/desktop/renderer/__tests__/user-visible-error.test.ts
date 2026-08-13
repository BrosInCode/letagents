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
