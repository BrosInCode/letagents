import assert from "node:assert/strict";
import test from "node:test";

import { assertSquareImageDimensions, parseSipsDimensions } from "./packaging-validation.mjs";

test("sips dimensions accept a square source icon", () => {
  const dimensions = parseSipsDimensions("/tmp/logo.png\n  pixelWidth: 1024\n  pixelHeight: 1024\n");
  assert.deepEqual(assertSquareImageDimensions(dimensions), { width: 1024, height: 1024 });
});

test("application icons reject non-square source images", () => {
  assert.throws(
    () => assertSquareImageDimensions({ width: 1024, height: 768 }, "docs/logo.png"),
    /docs\/logo\.png must be square; received 1024x768/,
  );
});

test("malformed sips output is rejected", () => {
  assert.throws(() => parseSipsDimensions("pixelWidth: unknown"), /Could not read positive pixelWidth and pixelHeight/);
});
