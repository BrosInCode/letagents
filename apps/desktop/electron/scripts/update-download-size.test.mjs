import assert from "node:assert/strict";
import test from "node:test";

import { plannedUpdateDownload, previousBlockmapUrl } from "./update-download-size.mjs";

const blockmap = (checksums, sizes) => ({ version: "2", files: [{ name: "file", offset: 0, checksums, sizes }] });

test("an update downloads only the blocks the previous release does not have", () => {
  const previous = blockmap(["a", "b", "c"], [10, 20, 30]);
  assert.deepEqual(plannedUpdateDownload(previous, blockmap(["a", "b", "c"], [10, 20, 30])), { downloadBytes: 0, totalBytes: 60, reusedBytes: 60 });
  assert.deepEqual(plannedUpdateDownload(previous, blockmap(["a", "x", "c", "y"], [10, 25, 30, 5])), { downloadBytes: 30, totalBytes: 70, reusedBytes: 40 });
  // A block whose checksum matches but whose size differs is downloaded, as the updater does.
  assert.deepEqual(plannedUpdateDownload(previous, blockmap(["a"], [11])), { downloadBytes: 11, totalBytes: 11, reusedBytes: 0 });
});

test("the previous blockmap is the feed's update ZIP plus .blockmap, relative to the feed", () => {
  const feed = [
    "version: 0.1.143",
    "files:",
    "  - url: ../../v0.1.143/LetAgents-0.1.143-darwin-arm64.zip",
    "    sha512: abc",
    "path: ../../v0.1.143/LetAgents-0.1.143-darwin-arm64.zip",
  ].join("\n");
  assert.deepEqual(previousBlockmapUrl(feed, "https://downloads.example/desktop/feeds/arm64/latest-mac.yml"), {
    version: "0.1.143",
    url: "https://downloads.example/desktop/v0.1.143/LetAgents-0.1.143-darwin-arm64.zip.blockmap",
  });
  assert.deepEqual(previousBlockmapUrl("version: '1.0.0'\nfiles:\n  - url: https://cdn.example/a.zip\n", "https://x.example/latest-mac.yml"), {
    version: "1.0.0",
    url: "https://cdn.example/a.zip.blockmap",
  });
  // The published feeds are JSON.
  assert.deepEqual(previousBlockmapUrl(JSON.stringify({ version: "0.1.143", files: [{ url: "https://cdn.example/v0.1.143/a.zip" }] }), "https://x.example/latest-mac.yml"), {
    version: "0.1.143",
    url: "https://cdn.example/v0.1.143/a.zip.blockmap",
  });
  assert.throws(() => previousBlockmapUrl("files: []", "https://x.example/latest-mac.yml"), /no version or file URL/);
});
