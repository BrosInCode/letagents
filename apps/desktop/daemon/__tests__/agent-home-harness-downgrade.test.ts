import assert from "node:assert/strict";
import test from "node:test";

import {
  HOME_HARNESS_ON,
  deriveProviderConfigurationSnapshot,
  homeHarnessChangeKey,
  storedLaunchPolicy,
} from "../provider-configuration.js";
import {
  deriveProviderConfigurationSnapshot as deriveAsDesktop106,
} from "./fixtures/desktop-0-1-106-provider-configuration.js";
import {
  attestProviderSpawnPolicy as attestAsDesktop106,
  claudeLaunchPolicyArgs as claudeArgsAsDesktop106,
} from "./fixtures/desktop-0-1-106-claude-launch.js";

/**
 * After a desktop downgrade, an agent whose owner turned their own setup on
 * meets a build that does not know what this one stored. The fixtures are
 * the released 0.1.106 code, so these tests run what that build would run:
 * stored policy, to its launch policy, to its attestation, to the arguments
 * it hands the Claude CLI.
 */

const PROFILES = {
  codex: ["full_access", "ask_before_write", "auto_review"],
  "claude-code": ["read_only", "ask_before_write", "auto_review", "full_access"],
} as const;

/** What this build stores for an agent, after the owner turned the switch on and, optionally, off again. */
function storedByThisBuild(provider: keyof typeof PROFILES, permissionProfileId: string, history: "on" | "on_then_off"): Record<string, unknown> {
  const selection = { provider, model: null, reasoningEffort: null, permissionProfileId };
  const created = deriveProviderConfigurationSnapshot({ ...selection, configurationRevision: 1 }, {}).launchPolicy;
  const on = storedLaunchPolicy(
    deriveProviderConfigurationSnapshot({ ...selection, configurationRevision: 2 }, { ...created, ...HOME_HARNESS_ON }),
    { policy: created, runtimeRevision: 1, changedAt: 2 },
  );
  if (history === "on") return on;
  return storedLaunchPolicy(
    deriveProviderConfigurationSnapshot({ ...selection, configurationRevision: 3 }, Object.fromEntries(Object.entries(on).filter(([key]) => key !== "letagentsOwnerIsolation"))),
    { policy: on, runtimeRevision: 1, changedAt: 3 },
  );
}

/** The 0.1.106 launch path for a stored policy: the daemon derives, the adapter attests. */
function launchPolicyAsDesktop106(provider: keyof typeof PROFILES, permissionProfileId: string, stored: unknown): Record<string, unknown> {
  const snapshot = deriveAsDesktop106({ provider, model: null, reasoningEffort: null, permissionProfileId, configurationRevision: 3 }, stored);
  return attestAsDesktop106(provider, {
    workAttemptId: "attempt", roomId: "room", cwd: "/tmp/attempt", model: null, reasoningEffort: null,
    permissionProfileId, configurationRevision: 3, launchPolicy: snapshot.launchPolicy,
  } as never);
}

test("an older build starts a Claude agent isolated, with no unknown flag, whatever this build stored about the owner's setup", () => {
  for (const profile of PROFILES["claude-code"]) {
    const never = deriveProviderConfigurationSnapshot({ provider: "claude-code", model: null, reasoningEffort: null, permissionProfileId: profile, configurationRevision: 1 }, {}).launchPolicy;
    const isolated = claudeArgsAsDesktop106(launchPolicyAsDesktop106("claude-code", profile, never));
    for (const history of ["on", "on_then_off"] as const) {
      const stored = storedByThisBuild("claude-code", profile, history);
      assert.equal(Object.keys(stored).some((key) => key.startsWith("letagents")), true, `${profile}/${history}: this build did store something of its own`);
      const args = claudeArgsAsDesktop106(launchPolicyAsDesktop106("claude-code", profile, stored));
      assert.deepEqual(args, isolated, `${profile}/${history}: exactly the arguments of an agent that never had it`);
      assert.equal(args.some((arg) => /^--letagents/i.test(arg)), false, `${profile}/${history}`);
    }
  }
});

test("the same holds after an older build saves the agent's settings", () => {
  for (const profile of PROFILES["claude-code"]) {
    const stored = storedByThisBuild("claude-code", profile, "on");
    // 0.1.106 stores the derived policy as it is, so what this build wrote travels through its save.
    for (const next of PROFILES["claude-code"]) {
      const savedByOlder = deriveAsDesktop106({ provider: "claude-code", model: null, reasoningEffort: null, permissionProfileId: next, configurationRevision: 4 }, stored).launchPolicy;
      const args = claudeArgsAsDesktop106(launchPolicyAsDesktop106("claude-code", next, savedByOlder));
      assert.equal(args.some((arg) => /^--letagents/i.test(arg)), false, `${profile} -> ${next}`);
      assert.deepEqual(args, claudeArgsAsDesktop106(launchPolicyAsDesktop106("claude-code", next,
        deriveProviderConfigurationSnapshot({ provider: "claude-code", model: null, reasoningEffort: null, permissionProfileId: next, configurationRevision: 1 }, {}).launchPolicy)),
      `${profile} -> ${next}`);
    }
  }
});

test("the older build is what makes the stored form matter: any other value becomes a flag the CLI does not know", () => {
  const stored = storedByThisBuild("claude-code", "ask_before_write", "on");
  // The form this change first used, and every value an older build does not drop.
  for (const [unsafe, flag] of [
    [{ letagentsHomeHarness: true }, "--letagents-home-harness"],
    [{ letagentsOwnerIsolation: true }, "--letagents-owner-isolation"],
    [{ letagentsOwnerIsolation: "off" }, "--letagents-owner-isolation"],
    [{ letagentsOwnerIsolation: 0 }, "--letagents-owner-isolation"],
    [{ letagentsOwnerIsolationChanges: [2] }, "--letagents-owner-isolation-changes"],
  ] as const) {
    const args = claudeArgsAsDesktop106(launchPolicyAsDesktop106("claude-code", "ask_before_write", { ...stored, ...unsafe }));
    assert.equal(args.includes(flag), true, JSON.stringify(unsafe));
  }
  // A value that is not a scalar stops the older launch outright.
  assert.throws(() => claudeArgsAsDesktop106(launchPolicyAsDesktop106("claude-code", "full_access", { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, letagentsOwnerIsolation: { on: true } })));
});

test("an older build hands Codex only false-valued fields it does not know, and keeps the selected access level", () => {
  for (const profile of PROFILES.codex) {
    const never = deriveProviderConfigurationSnapshot({ provider: "codex", model: null, reasoningEffort: null, permissionProfileId: profile, configurationRevision: 1 }, {}).launchPolicy;
    for (const history of ["on", "on_then_off"] as const) {
      const policy = launchPolicyAsDesktop106("codex", profile, storedByThisBuild("codex", profile, history));
      const unknown = Object.fromEntries(Object.entries(policy).filter(([key]) => !Object.hasOwn(never, key)));
      // Codex ignores a field it does not know; the installed Codex is shown doing so in the launch-isolation tests.
      assert.deepEqual(unknown, {
        ...(history === "on" ? { letagentsOwnerIsolation: false } : {}),
        [homeHarnessChangeKey(2)]: false,
        ...(history === "on_then_off" ? { [homeHarnessChangeKey(3)]: false } : {}),
      }, `${profile}/${history}`);
      assert.deepEqual(Object.fromEntries(Object.entries(policy).filter(([key]) => Object.hasOwn(never, key))), never, `${profile}/${history}`);
    }
  }
});
