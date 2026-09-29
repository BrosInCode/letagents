import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_INSPECTOR_RECOVERY_DISMISSALS_LIMIT,
  AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY,
  isAgentInspectorRecoveryDismissed,
  rememberAgentInspectorRecoveryDismissal,
  type AgentInspectorRecoveryDismissalStorage,
} from "../src/domain/agent-inspector-recovery-dismissals";

function memoryStorage(initial: string | null = null): AgentInspectorRecoveryDismissalStorage {
  let value = initial;
  return {
    getItem: (key) => key === AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY ? value : null,
    setItem: (key, next) => {
      if (key === AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY) value = next;
    },
  };
}

test("a restored-conversation dismissal survives component remounts", () => {
  const storage = memoryStorage();
  assert.equal(isAgentInspectorRecoveryDismissed(storage, "notice_1"), false);
  rememberAgentInspectorRecoveryDismissal(storage, "notice_1");
  assert.equal(isAgentInspectorRecoveryDismissed(storage, "notice_1"), true);
  assert.equal(isAgentInspectorRecoveryDismissed(storage, "notice_2"), false);
});

test("dismissals are deduplicated, bounded, and tolerate unavailable storage", () => {
  const storage = memoryStorage("not valid json");
  for (let index = 0; index <= AGENT_INSPECTOR_RECOVERY_DISMISSALS_LIMIT; index += 1) {
    rememberAgentInspectorRecoveryDismissal(storage, `notice_${index}`);
  }
  rememberAgentInspectorRecoveryDismissal(storage, "notice_100");
  const persisted = JSON.parse(
    storage.getItem(AGENT_INSPECTOR_RECOVERY_DISMISSALS_STORAGE_KEY) || "[]",
  ) as string[];
  assert.equal(persisted.length, AGENT_INSPECTOR_RECOVERY_DISMISSALS_LIMIT);
  assert.equal(persisted[0], "notice_100");
  assert.equal(new Set(persisted).size, persisted.length);
  assert.doesNotThrow(() => rememberAgentInspectorRecoveryDismissal(null, "notice_1"));
  assert.equal(isAgentInspectorRecoveryDismissed(undefined, "notice_1"), false);
});

test("the notice component keys dismissal to the restoration event, not live receipt updates", () => {
  const component = readFileSync(fileURLToPath(new URL(
    "../src/components/desktop/content/agent-inspector/AgentInspectorContinuationRecovery.vue",
    import.meta.url,
  )), "utf8");
  assert.match(component, /@click="dismiss"/);
  assert.match(component, /rememberAgentInspectorRecoveryDismissal\(dismissalStorage\(\), noticeId\)/);
  assert.match(component, /\(\) => props\.recovery\?\.noticeId \?\? null/);
  assert.doesNotMatch(
    component,
    /\[props\.entryId, props\.recovery\?\.sourceMessageId, props\.recovery\?\.state\]/,
  );
});
