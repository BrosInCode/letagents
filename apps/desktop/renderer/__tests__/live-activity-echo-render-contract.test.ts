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

test("scroll effects share the coalesced cadence, not the raw prop", () => {
  // The scroll watcher must key off the rate-limited displayed set so it does
  // not scroll on every raw native summary change.
  assert.match(viewportSource, /\(\) => displayedAgentWork\.value\.map\(\(work\) => `\$\{work\.id\}:\$\{work\.summary\}`\)/);
  assert.doesNotMatch(viewportSource, /\(\) => props\.localAgentWork\.map\(\(work\) => `\$\{work\.id\}:\$\{work\.summary\}`\)/);
});

test("an agent's visible reply cancels its older coalesced progress echo", () => {
  assert.match(viewportSource, /workIndicatorSupersededByAgentMessage/);
  assert.match(viewportSource, /currentLocalAgentWork/);
  assert.match(viewportSource, /v-if="displayedAgentWork\.length && !roomLoading"/);
});

const cssSource = readFileSync(fileURLToPath(new URL(
  "../src/styles/04-room-chat-stream.css",
  import.meta.url,
)), "utf8");

const hostSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue",
  import.meta.url,
)), "utf8");

const surfaceSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue",
  import.meta.url,
)), "utf8");

const shellSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/DesktopRoomShell.vue",
  import.meta.url,
)), "utf8");

test("the work indicator renders as a clickable button with accessible name and phrasing content", () => {
  assert.match(viewportSource, /<button[\s\S]*?class="room-local-agent-work"[\s\S]*?:aria-label="`\$\{work\.displayName\}: \$\{work\.summary\}\. Open live activity`"[\s\S]*?@click="\$emit\('open-agent', workIndicatorAgentTarget\(work\)\)"/);
  assert.match(viewportSource, /<span class="room-local-agent-work-copy">/);
  assert.doesNotMatch(viewportSource, /<button[\s\S]*?class="room-local-agent-work"[\s\S]*?<div>/);
  assert.match(viewportSource, /import\s*\{\s*[^}]*workIndicatorAgentTarget[^}]*\}\s*from\s*"[^"]*agent-inspector-identity"/);
});

test("work indicator button has interactive styling, accessible focus, and theme tokens with no dead selectors", () => {
  assert.match(cssSource, /\.room-local-agent-work\s*\{[\s\S]*?cursor:\s*pointer;/);
  assert.doesNotMatch(cssSource, /button\.room-local-agent-work/);
  assert.doesNotMatch(cssSource, /\.room-local-agent-work div/);
  assert.match(cssSource, /\.room-local-agent-work:focus-visible\s*\{[\s\S]*?outline:/);
  assert.match(cssSource, /\.room-local-agent-work:active\s*\{[\s\S]*?background:\s*var\(--accent-active\)/);
  assert.match(cssSource, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{[\s\S]*?\.room-local-agent-work:hover\s*\{[\s\S]*?background:\s*var\(--accent-hover\)/);
  assert.match(cssSource, /\.room-local-agent-work-copy/);
});

test("agent inspector host falls back to composer only when opener row is non-null and disconnected", () => {
  assert.match(hostSource, /if\s*\(restoreFocusOnClose\s*&&\s*restoreFocusElement\)\s*\{/);
  assert.match(hostSource, /restoreFocusElement\.isConnected/);
  assert.match(hostSource, /data-testid="desktop-composer-input"/);
});

test("agent inspector surface connects live stream on mount and watch via shared initialTabEffects and focuses live tab", () => {
  assert.match(surfaceSource, /import\s*\{[^}]*initialTabEffects[^}]*\}\s*from\s*"[^"]*agent-inspector-identity"/);
  assert.match(surfaceSource, /function applyInitialTab[\s\S]*?initialTabEffects/);
  assert.match(surfaceSource, /onMounted\(\(\)\s*=>\s*\{[\s\S]*?applyInitialTab\(\)/);
  assert.match(surfaceSource, /watch\(\[\(\)\s*=>\s*props\.projection\.entryId[\s\S]*?applyInitialTab\(\)/);
  const applyInitialTabBody = /function applyInitialTab\(\): void \{[\s\S]*?\n\}/.exec(surfaceSource)?.[0] ?? "";
  assert.doesNotMatch(applyInitialTabBody, /work-selected/);
  assert.match(surfaceSource, /function focusInitial\(\)[\s\S]*?selectedTab\.value === "live"[\s\S]*?#agent-inspector-live-tab/);
});

test("DesktopRoomShell line count stays strictly under 3000 lines", () => {
  const lineCount = shellSource.trimEnd().split("\n").length;
  assert.ok(lineCount < 3000, `DesktopRoomShell line count ${lineCount} exceeds 3000-line cap`);
  assert.equal(lineCount, 2998, `DesktopRoomShell line count should be exactly 2998 lines (zero-line edit)`);
});
