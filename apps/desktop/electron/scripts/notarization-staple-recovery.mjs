import { setTimeout as sleep } from "node:timers/promises";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const TRANSIENT_NETWORK_ERROR = /NSURLErrorDomain\s+Code=-(?:1001|1005)\b/;
const COMMAND_LIMITS = { timeout: 120_000, maxBuffer: 1024 * 1024 };

function isTransientStaplerError(error) {
  return error?.code === 68
    && TRANSIENT_NETWORK_ERROR.test(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`);
}

async function retryStapler(args, { execFile, wait = sleep, warn = console.warn }) {
  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    warn(`Apple ticket connection failed; retrying ${args[1]} (${attempt + 1}/${RETRY_DELAYS_MS.length}).`);
    await wait(delay);
    try {
      await execFile("xcrun", args, COMMAND_LIMITS);
      return;
    } catch (error) {
      if (!isTransientStaplerError(error) || attempt === RETRY_DELAYS_MS.length - 1) throw error;
    }
  }
}

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

  await retryStapler(["stapler", "staple", "-v", options.appPath], { execFile, wait, warn });
}

/** Validation also contacts Apple. A network retry never substitutes for a valid ticket. */
export async function validateStapledTicket(appPath, dependencies) {
  const args = ["stapler", "validate", appPath];
  try {
    await dependencies.execFile("xcrun", args, COMMAND_LIMITS);
    return;
  } catch (error) {
    if (!isTransientStaplerError(error)) throw error;
  }
  await retryStapler(args, dependencies);
}
