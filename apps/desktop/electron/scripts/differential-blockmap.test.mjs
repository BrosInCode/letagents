import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { createDifferentialBlockmap } from "./differential-blockmap.mjs";

test("differential blockmaps cover the exact file and remain content-aligned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-blockmap-"));
  try {
    const stableTail = Buffer.alloc(512 * 1024);
    let pseudoRandom = 0x5f3759df;
    for (let index = 0; index < stableTail.length; index += 1) {
      pseudoRandom ^= pseudoRandom << 13;
      pseudoRandom ^= pseudoRandom >>> 17;
      pseudoRandom ^= pseudoRandom << 5;
      stableTail[index] = pseudoRandom & 0xff;
    }
    const firstPath = join(directory, "LetAgents-0.1.0.zip");
    const secondPath = join(directory, "LetAgents-0.1.1.zip");
    await writeFile(firstPath, Buffer.concat([Buffer.from("old-header"), stableTail]));
    await writeFile(secondPath, Buffer.concat([Buffer.from("a-new-longer-header"), stableTail]));

    const first = await createDifferentialBlockmap(firstPath);
    const second = await createDifferentialBlockmap(secondPath);
    const parsed = JSON.parse(gunzipSync(await readFile(second.blockmapPath)).toString("utf8"));

    assert.equal(parsed.version, "2");
    assert.equal(parsed.files[0].sizes.reduce((total, size) => total + size, 0), second.bytes);
    assert.equal(parsed.files[0].checksums.length, parsed.files[0].sizes.length);
    assert.ok(
      second.blockmap.files[0].checksums.some((checksum) => first.blockmap.files[0].checksums.includes(checksum)),
      "content-defined chunks should reuse stable regions after an insertion",
    );
    assert.match(second.sha512, /^[A-Za-z0-9+/]+={0,2}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
