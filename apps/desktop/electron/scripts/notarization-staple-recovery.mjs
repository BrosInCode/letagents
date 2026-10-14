import { setTimeout as sleep } from "node:timers/promises";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const TRANSIENT_NETWORK_ERROR = /NSURLErrorDomain\s+Code=-(?:1001|1005)\b/;

/** Retry ticket delivery only after notarization succeeded and stapling failed. */
export async function notarizeWithStapleRecovery(options, {
  notarize,
  execFile,
  wait = sleep,
  warn = console.warn,
}) {
  try {
    await notarize(options);
    return;
  } catch (error) {
    // @electron/notarize emits this error only after Apple accepts the submission.
    // Never reinterpret signature, authorization, or notarization rejection errors.
    if (!/^Failed to staple your application with code: 68\b/.test(error?.message ?? "")
      || !TRANSIENT_NETWORK_ERROR.test(error.message)) throw error;
  }

  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    warn(`Apple ticket download lost its connection; retrying stapling (${attempt + 1}/${RETRY_DELAYS_MS.length}).`);
    await wait(delay);
    try {
      await execFile("xcrun", ["stapler", "staple", "-v", options.appPath], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      return;
    } catch (error) {
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      if (error?.code !== 68 || !TRANSIENT_NETWORK_ERROR.test(output)
        || attempt === RETRY_DELAYS_MS.length - 1) throw error;
    }
  }
}
