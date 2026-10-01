import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const now = source("../src/components/desktop/content/agent-inspector/AgentInspectorNow.vue");
const styles = source("../src/components/desktop/content/agent-inspector/agent-inspector.css");
const diagnosticsStyles = source("../src/components/desktop/content/agent-inspector/agent-inspector-diagnostics.css");

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(String.raw`(?:^|[\n}])\s*${escaped}\s*\{([^}]*)\}`).exec(css);
  assert.ok(match, `${selector} has a rule`);
  return match[1]!;
}

describe("agent inspector long-text contract", () => {
  it("lets every tab's rows shrink to the panel instead of growing to the widest token", () => {
    for (const selector of [
      ".agent-inspector-overview",
      ".agent-inspector-work",
      ".agent-inspector-settings",
      ".agent-inspector-participant-scroll",
    ]) {
      assert.match(rule(styles, selector), /display: grid; grid-template-columns: minmax\(0, 1fr\);/, selector);
    }
  });

  it("wraps the Now summary inside its card", () => {
    assert.match(now, /<div class="agent-inspector-now-copy">\s*<p id="agent-inspector-now-title">/);
    assert.match(rule(styles, ".agent-inspector-now-copy"), /min-width: 0;/);
    assert.match(rule(styles, ".agent-inspector-now strong"), /overflow-wrap: anywhere;/);
  });

  it("wraps raw runtime text everywhere the inspector renders it", () => {
    for (const selector of [
      ".agent-inspector-status-copy",
      ".agent-inspector-action-message",
      ".agent-inspector-charter",
      ".agent-inspector-context-list dd",
      ".agent-inspector-continuation-recovery p",
      ".agent-inspector-delivery-progress div > span",
      ".agent-inspector-work-note p",
      ".agent-inspector-settings-note, .agent-inspector-danger > p",
      ".agent-inspector-settings-error",
    ]) {
      assert.match(rule(styles, selector), /overflow-wrap: anywhere;/, selector);
    }
    for (const selector of [
      ".diagnostics-intro > p",
      ".diagnostics-next > p:last-child",
      ".diagnostics-retained-error p",
    ]) {
      assert.match(rule(diagnosticsStyles, selector), /overflow-wrap: anywhere;/, selector);
    }
  });
});
