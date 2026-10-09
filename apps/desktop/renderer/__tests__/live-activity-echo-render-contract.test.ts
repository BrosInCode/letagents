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

const streamCssSource = readFileSync(fileURLToPath(new URL(
  "../src/styles/04-room-chat-stream.css",
  import.meta.url,
)), "utf8");
const cssSource = readFileSync(fileURLToPath(new URL(
  "../../../../shared/ui/room-agent-work.css", import.meta.url,
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
  assert.match(streamCssSource, /@import "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/ui\/room-agent-work\.css"/);
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
  assert.ok(lineCount <= 2998, `DesktopRoomShell line count ${lineCount} must not exceed the 2998-line baseline`);
});

test("an agent that waits to try again has a row at rest in the live strip, and the inspector's line for it follows a clock that moves", () => {
  // The shell puts the rows that wait in the same list as the rows that work, so they are in the strip that stays in view.
  assert.match(shellSource, /const localAgentWork = computed\(\(\) =>\s*\[\s*\.\.\.waitingAgentIndicators\(supervisorEntries\.value, props\.room\.identifier\),/);
  // The row is the strip's own button, marked as one that waits. Its look is the strip's: the mark only puts it at rest.
  assert.match(viewportSource, /<button[\s\S]*?:data-waiting="work\.waiting \|\| undefined"[\s\S]*?class="room-local-agent-work"/);
  assert.match(cssSource, /\.room-local-agent-work\[data-waiting\] \.room-local-agent-work-pulse\s*\{[^}]*animation:\s*none;/);
  assert.match(cssSource, /\.room-local-agent-work\[data-waiting\] \.room-local-agent-work-dots\s*\{\s*display:\s*none;/);
  // The inspector reads the wait against the second clock, not against the time of the last state push.
  assert.match(surfaceSource, /const retryClock = useSecondClock\(\(\) => Boolean\(agentScheduledRetry\(props\.projection\.entry\.deliveryReceipts\)\)\);/);
  assert.match(surfaceSource, /const signal = computed\(\(\) => agentInspectorSignal\(props\.projection, retryClock\.value\)\);/);
  // What the owner reads after Try now and Stop trying is true before any turn has started.
  assert.match(shellSource, /pushActionToast\("Request accepted\. The agent tries again as soon as it can start\.", "success", 5_000\);/);
  assert.match(shellSource, /"Stopped the automatic attempts\. The task is still assigned to this agent\. Send it a message to continue\."/);
  assert.doesNotMatch(shellSource, /Trying again now/);
});

test("the work indicator is pinned outside the scrolling list and still feeds the reply motion", () => {
  const template = viewportSource.split("</template>\n\n<script")[0];
  const strip = template.indexOf('ref="liveStripElement" class="room-live-strip"');
  assert.ok(strip > template.indexOf('class="room-new-messages-pill"'), "the strip follows the list and its pills");
  assert.ok(template.indexOf('class="room-local-agent-work-list"') > strip);
  const before = template.slice(0, template.lastIndexOf("<div", strip));
  assert.equal((before.match(/<div\b/g) || []).length - (before.match(/<\/div>/g) || []).length, 1, "only the viewport root is open");
  // The reply still grows out of its work row, so the motion must look in the strip.
  assert.match(viewportSource, /useRoomMessageMotion\(\{\s*element: messagesElement,\s*work: liveStripElement,/);
});
