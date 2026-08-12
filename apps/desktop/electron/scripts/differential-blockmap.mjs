import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const MIN_CHUNK_BYTES = 16 * 1024;
const AVERAGE_CHUNK_MASK = (32 * 1024) - 1;
const MAX_CHUNK_BYTES = 64 * 1024;

const GEAR_TABLE = new Uint32Array(256);
for (let index = 0; index < GEAR_TABLE.length; index += 1) {
  const seed = createHash("sha256").update(`letagents-update-block:${index}`).digest();
  GEAR_TABLE[index] = seed.readUInt32BE(0);
}

function blockChecksum(bytes) {
  return createHash("blake2b512").update(bytes).digest().subarray(0, 18).toString("base64");
}

/**
 * Build an electron-updater v2 sidecar blockmap with content-defined chunks.
 * Boundaries follow the file content, so unchanged ZIP regions remain reusable
 * even when an earlier archive entry changes size.
 */
export async function createDifferentialBlockmap(inputPath, outputPath = `${inputPath}.blockmap`) {
  const sha512 = createHash("sha512");
  const checksums = [];
  const sizes = [];
  const chunk = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
  let chunkLength = 0;
  let fingerprint = 0;

  function emitChunk() {
    if (chunkLength === 0) return;
    checksums.push(blockChecksum(chunk.subarray(0, chunkLength)));
    sizes.push(chunkLength);
    chunkLength = 0;
    fingerprint = 0;
  }

  for await (const input of createReadStream(inputPath, { highWaterMark: 256 * 1024 })) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    sha512.update(bytes);
    for (const byte of bytes) {
      chunk[chunkLength] = byte;
      chunkLength += 1;
      fingerprint = (((fingerprint << 1) >>> 0) + GEAR_TABLE[byte]) >>> 0;
      if (
        chunkLength >= MAX_CHUNK_BYTES
        || (chunkLength >= MIN_CHUNK_BYTES && (fingerprint & AVERAGE_CHUNK_MASK) === 0)
      ) {
        emitChunk();
      }
    }
  }
  emitChunk();

  const blockmap = {
    version: "2",
    files: [{ name: "file", offset: 0, checksums, sizes }],
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(blockmap)), { level: 9, mtime: 0 });
  await writeFile(outputPath, compressed);
  return {
    blockmap,
    blockmapPath: outputPath,
    blockmapBytes: compressed.length,
    bytes: (await stat(inputPath)).size,
    sha512: sha512.digest("base64"),
  };
}
