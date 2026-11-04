import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway self-signed certificate for loopback test servers (valid for
 * `localhost`, `pinned.invalid` and 127.0.0.1), or null when openssl is not
 * installed. The test trusts it as its own certificate authority.
 */
export function makeTestCertificate(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "letagents-wake-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,DNS:pinned.invalid,IP:127.0.0.1",
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
