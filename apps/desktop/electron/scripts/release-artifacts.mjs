import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

/** Size and digests of a release file: hex SHA-256 for people, base64 SHA-512 for electron-updater. */
export async function describeArtifact(kind, path) {
  const info = await stat(path);
  return {
    kind,
    name: basename(path),
    bytes: info.size,
    sha256: await digest(path, "sha256", "hex"),
    sha512: await digest(path, "sha512", "base64"),
  };
}
