import { spawn } from "node:child_process";

export const PACKAGED_READY_MARKER = "LETAGENTS_PACKAGED_SUPERVISOR_READY";

/**
 * Start the packaged app and wait for its ready line.
 *
 * The first of three events decides the result, and no later event changes it:
 * the ready line, an exit before it, or the deadline. At the deadline the
 * result is a timeout at once; the evidence is collected after that decision,
 * so a ready line or an exit that comes while the evidence is collected
 * cannot turn the timeout into a pass or into a different failure.
 */
export function launchPackagedApp({ executable, args = [], env, timeoutMs, collectEvidence = async () => "" }) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let outcome = null;
    const settle = (name) => {
      if (outcome) return false;
      outcome = name;
      clearTimeout(timeout);
      return true;
    };
    const timeout = setTimeout(() => {
      if (!settle("timeout")) return;
      const outputAtDeadline = output;
      // Report where the app waits before the kill; a timeout with no evidence cannot tell a hang from a slow start.
      // A fault of the evidence step must not replace the launch failure or skip the kill.
      Promise.resolve().then(() => collectEvidence(child.pid))
        .catch((error) => `no evidence (${error instanceof Error ? error.message : String(error)})`)
        .then((evidence) => {
          child.kill("SIGKILL");
          reject(new Error(`packaged Electron launch timed out after ${timeoutMs} ms: ${outputAtDeadline}\n${evidence}`));
        });
    }, timeoutMs);
    const capture = (chunk) => {
      output += chunk;
      if (!output.includes(PACKAGED_READY_MARKER) || !settle("ready")) return;
      // Model the user quitting the packaged desktop process. The detached
      // daemon must remain live and answer after this process is gone.
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolveLaunch(output);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => { if (settle("error")) reject(error); });
    child.once("exit", (code) => {
      if (settle("exit")) reject(new Error(`packaged Electron exited ${code}: ${output}`));
    });
  });
}
