import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardSource = await readFile(
  new URL("../src/components/desktop/content/RentProviderDashboard.vue", import.meta.url),
  "utf8",
);

test("provider review facts and actions stay bound to the same request", () => {
  assert.match(dashboardSource, /const token = \+\+reviewRequestToken/);
  assert.match(
    dashboardSource,
    /if \(token !== reviewRequestToken \|\| reviewingRequest\.value\?\.id !== request\.id\) return;/,
  );
  assert.match(
    dashboardSource,
    /if \(!session \|\| session\.id !== request\.sessionId\) throw new Error/,
  );
  assert.match(
    dashboardSource,
    /if \(!request \|\| reviewSession\.value\?\.id !== request\.sessionId\)/,
  );
  assert.match(dashboardSource, /function closeReview\(\): void \{ reviewRequestToken \+= 1;/);
});
