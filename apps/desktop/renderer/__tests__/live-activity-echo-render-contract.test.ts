import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const viewportSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/room-chat/RoomMessageViewport.vue",
  import.meta.url,
)), "utf8");

test("the work indicator renders the live activity echo and collapses many agents", () => {
  assert.match(viewportSource, /coalesceWorkIndicatorEchoes/);
  assert.match(viewportSource, /collapseWorkIndicators/);
  // Collapses the rate-limited displayed set, not the raw prop.
  assert.match(viewportSource, /const collapsedAgentWork = computed\(\(\) => collapseWorkIndicators\(displayedAgentWork\.value\)\)/);
  assert.match(viewportSource, /v-for="work in collapsedAgentWork\.visible"/);
  assert.match(viewportSource, /data-testid="room-local-agent-work-echo"/);
  assert.match(viewportSource, /data-testid="room-local-agent-work-overflow"/);
  assert.match(viewportSource, /collapsedAgentWork\.hiddenCount/);
});

test("the echo update is rate-limited with a trailing flush and cleaned up on unmount", () => {
  assert.match(viewportSource, /coalesceWorkIndicatorEchoes\(\s*echoState/);
  assert.match(viewportSource, /WORK_INDICATOR_ECHO_MIN_INTERVAL_MS/);
  assert.match(viewportSource, /echoFlushTimer = window\.setTimeout\(applyEchoCoalescing/);
  assert.match(viewportSource, /window\.clearTimeout\(echoFlushTimer\)/);
});
