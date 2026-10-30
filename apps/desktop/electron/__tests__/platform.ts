import nodeTest from "node:test";

// The supervisor daemon and the supervised agents it runs are macOS-only
// until tier 3 of the Windows port: the daemon's control socket, singleton,
// process identity, state backups and the provider adapters it drives. The
// desktop suites run on Windows in CI; a test of that behaviour skips itself
// there through this module, with the reason beside it, in one place.
//
// Only tier-3 behaviour may skip. A test of code the Windows app uses without
// supervised agents (the shared capture, review and attachment modules, the
// desktop main process, the renderer) must pass on Windows.
//
// Tier 3: when a behaviour is ported, remove its tests' skips; remove this
// module when nothing imports it.

/**
 * Skip reason for a test of supervised-agent behaviour, for
 * `test(name, { skip: supervisedAgentsOnly }, fn)`. False off Windows.
 */
export const supervisedAgentsOnly: string | false = false;

/**
 * node:test's `test` for a file whose every test runs the daemon or a
 * supervised agent: on Windows each test is skipped with the reason above.
 * Hooks registered with `before`/`after` still run, so they must not start
 * the daemon themselves.
 */
export const supervisedAgentTest: typeof nodeTest = supervisedAgentsOnly
  ? new Proxy(nodeTest, {
    apply(target, thisArg, args: unknown[]) {
      const fn = args.find((arg) => typeof arg === "function");
      const options = args.find((arg) => arg !== null && typeof arg === "object") ?? {};
      const rest = [{ ...options, skip: supervisedAgentsOnly }, ...(fn ? [fn] : [])];
      return Reflect.apply(target, thisArg, typeof args[0] === "string" ? [args[0], ...rest] : rest);
    },
  })
  : nodeTest;
