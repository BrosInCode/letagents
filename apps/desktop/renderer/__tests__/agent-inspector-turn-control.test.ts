import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nextTick, ref, watch } from "vue";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const turnControl = source("../src/components/desktop/content/agent-inspector/AgentInspectorTurnControl.vue");

test("the correction reset watches a value key, never a fresh array", () => {
  // A `watch(() => [a, b, c], …)` getter allocates a new array every run, so
  // Vue's reference comparison fires it on EVERY inspector projection rebuild
  // (once per activity push during a turn) — clearing the correction box out
  // from under the user mid-type. The reset must key on a value-comparable
  // string of the turn identity instead.
  assert.doesNotMatch(
    turnControl,
    /watch\(\s*\(\)\s*=>\s*\[\s*props\.entryId/,
    "the reset watch must not use an array-literal getter",
  );
  assert.match(
    turnControl,
    /watch\(\s*\n?\s*\(\)\s*=>\s*`\$\{props\.entryId\}::\$\{props\.control\?\.workAttemptId[^`]*executionGenerationId/,
    "the reset watch keys on a value-comparable identity string",
  );
});

test("a value-key watch fires only on genuine identity change, not on every prop-object churn", () => {
  // Model the fix's semantics against real Vue: a control object rebuilt with
  // the SAME turn identity (an activity-push projection rebuild) must not fire
  // the reset; only a changed work-attempt/execution identity does.
  const control = ref<{ workAttemptId: string; executionGenerationId: string } | null>({
    workAttemptId: "wa1",
    executionGenerationId: "eg1",
  });
  const entryId = ref("agent_a");
  let resets = 0;
  watch(
    () => `${entryId.value}::${control.value?.workAttemptId ?? ""}::${control.value?.executionGenerationId ?? ""}`,
    () => { resets += 1; },
  );

  return (async () => {
    // Rebuild the control object 5 times with identical identity (the churn).
    for (let i = 0; i < 5; i += 1) {
      control.value = { workAttemptId: "wa1", executionGenerationId: "eg1" };
      await nextTick();
    }
    assert.equal(resets, 0, "projection churn with the same turn identity must not reset the draft");

    control.value = { workAttemptId: "wa2", executionGenerationId: "eg1" };
    await nextTick();
    assert.equal(resets, 1, "a genuinely new correctable turn resets the draft exactly once");
  })();
});
