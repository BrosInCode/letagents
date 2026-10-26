import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, effectScope, nextTick, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";

import {
  ACTIVITY_JOIN_MERGE_MS,
  ACTIVITY_NOTICE_LIMIT,
  ACTIVITY_NOTICE_MS,
  ACTIVITY_RESUME_GRACE_MS,
  createActivityNoticeQueue,
  elapsedLabel,
  joinedNames,
  pickActivityPill,
  presenceTimelineText,
  type ActivityNotice,
} from "../src/components/desktop/content/room-chat/room-activity";
import { orbStateForActivity, orbStateForTurn, orbStateForWork } from "../src/domain/activity-orb-state";
import { ACTIVITY_ORB_STILL_SECONDS, createActivityOrbClock, drawActivityOrb } from "../src/components/desktop/content/room-chat/activity-orb";
import { buildMessageTimelineEntries } from "../src/components/desktop/content/room-chat/timeline";
import { composerDrafting, type ComposerEventPreview } from "../src/components/desktop/content/room-chat/composer-event-preview";
import type { PresenceChipAgent } from "../src/domain/presence-chips";

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 1_000_000;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    set(run: () => void, ms: number) { const id = next++; pending.set(id, { at: now + ms, run }); return id; },
    clear(handle: unknown) { pending.delete(handle as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

const agent = (name: string, ideLabel: string | null = "Claude Code"): PresenceChipAgent =>
  ({ key: name.toLowerCase(), displayName: name, ideLabel, agentKey: null });
const join = (name: string, id = `join:${name}`): ActivityNotice => ({ kind: "join", id, agents: [agent(name)] });
const leave = (name: string): ActivityNotice => ({ kind: "leave", id: `leave:${name}`, agent: agent(name) });
const preview = (id: string): ComposerEventPreview => ({
  id, kind: "pull-request", tone: "violet", kindLabel: "Pull request", statusLabel: "opened", headline: "PR #1744 opened by Kestrel",
  repositoryLabel: "letagents", refLabel: null, numberLabel: "#1744", stats: { additions: "120", deletions: "8" }, actionLabel: "View", url: null,
});

function queue() {
  const timers = fakeTimers();
  let changes = 0;
  const notices = createActivityNoticeQueue(timers, () => { changes += 1; });
  const shown = () => {
    const current = notices.current();
    if (!current) return null;
    if (current.kind === "join") return `${joinedNames(current.agents)} joined`;
    if (current.kind === "leave") return `${current.agent.displayName} left`;
    return current.id;
  };
  return { timers, notices, shown, changes: () => changes };
}

test("the line shows one pill: Steer first, then a notice, then live work, then typing", () => {
  const work = [{ id: "a", displayName: "Juniper" }];
  const steer = { entryId: "a", displayName: "Juniper" };
  const notice = join("Kestrel");
  assert.equal(pickActivityPill({ steer, notice, work, typing: ["Emmy"] })?.kind, "steer");
  assert.equal(pickActivityPill({ steer: null, notice, work, typing: ["Emmy"] })?.kind, "notice");
  assert.equal(pickActivityPill({ steer: null, notice: null, work, typing: ["Emmy"] })?.kind, "live");
  assert.equal(pickActivityPill({ steer: null, notice: null, work: [], typing: ["Emmy"] })?.kind, "typing");
  assert.equal(pickActivityPill({ steer: null, notice: null, work: [], typing: [] }), null);
});

test("a notice shows for its time, then the next one, then the line is free again", () => {
  const { timers, notices, shown } = queue();
  notices.push(leave("Juniper"));
  notices.push(leave("Kestrel"));
  assert.equal(shown(), "Juniper left", "the first notice shows at once");
  timers.advance(ACTIVITY_NOTICE_MS - 1);
  assert.equal(shown(), "Juniper left");
  timers.advance(1);
  assert.equal(shown(), "Kestrel left", "one at a time, in order");
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(shown(), null);
});

test("joins close together become one line: queued joins merge, and a join soon after a shown join adds to it", () => {
  const { timers, notices, shown } = queue();
  notices.push(leave("Marlow"));
  notices.push(join("Juniper"));
  notices.push(join("Kestrel"));
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(shown(), "Juniper and Kestrel joined", "two waiting joins are one notice");

  timers.advance(ACTIVITY_JOIN_MERGE_MS - 1);
  notices.push(join("Sable"));
  assert.equal(shown(), "Juniper and 2 others joined", "a join just after the line appeared joins it in place");
  assert.equal(notices.waiting().length, 0);
  timers.advance(ACTIVITY_NOTICE_MS - 1);
  assert.equal(shown(), "Juniper and 2 others joined", "the longer line gets its own full time");

  timers.advance(1);
  notices.push(join("Wren"));
  timers.advance(ACTIVITY_JOIN_MERGE_MS);
  notices.push(join("Birch"));
  assert.equal(shown(), "Wren joined", "a later join waits for its own line");
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(shown(), "Birch joined");
});

test("an agent has one waiting notice: a leave replaces its waiting join, and the queue keeps the newest", () => {
  const { notices } = queue();
  notices.push(leave("Marlow"));
  notices.push(join("Juniper"));
  notices.push(leave("Juniper"));
  assert.deepEqual(notices.waiting().map(item => item.id), ["leave:Juniper"]);
  for (let index = 0; index < ACTIVITY_NOTICE_LIMIT + 3; index += 1) notices.push(leave(`Agent${index}`));
  assert.equal(notices.waiting().length, ACTIVITY_NOTICE_LIMIT);
  assert.equal(notices.waiting().at(-1)?.id, `leave:Agent${ACTIVITY_NOTICE_LIMIT + 2}`);
});

test("hover holds a notice; its time left runs again when the hover ends, with a short grace if it had run out", () => {
  const { timers, notices, shown } = queue();
  notices.push(leave("Juniper"));
  notices.push(leave("Kestrel"));
  timers.advance(1_000);
  notices.pause();
  timers.advance(60_000);
  assert.equal(shown(), "Juniper left", "a held notice does not leave");
  notices.resume();
  timers.advance(ACTIVITY_NOTICE_MS - 1_001);
  assert.equal(shown(), "Juniper left", "it keeps the 3 s it had left");
  timers.advance(1);
  assert.equal(shown(), "Kestrel left");

  timers.advance(ACTIVITY_NOTICE_MS - 1);
  notices.pause();
  timers.advance(10_000);
  notices.resume();
  timers.advance(ACTIVITY_RESUME_GRACE_MS - 1);
  assert.equal(shown(), "Kestrel left", "an almost-expired notice stays a moment after the pointer leaves");
  timers.advance(1);
  assert.equal(shown(), null);
});

test("a GitHub update stays off the line while someone writes, and leaves when its source drops it", () => {
  const { timers, notices, shown } = queue();
  notices.setEligible(item => item.kind !== "github");
  notices.push({ kind: "github", id: "github:msg_1", preview: preview("msg_1") });
  assert.equal(shown(), null, "hidden while drafting");
  notices.push(leave("Juniper"));
  assert.equal(shown(), "Juniper left", "other notices still show");
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(shown(), null);
  notices.setEligible(() => true);
  assert.equal(shown(), "github:msg_1", "the draft is gone: the update shows");
  notices.setEligible(item => item.kind !== "github");
  assert.equal(shown(), null, "writing again puts it away at once");
  notices.setEligible(() => true);
  assert.equal(shown(), "github:msg_1", "the draft is cleared before the update expires: it comes back");
  notices.setEligible(item => item.kind !== "github");
  notices.remove("github:msg_1");
  notices.setEligible(() => true);
  assert.equal(shown(), null, "an expired update never comes back");
});

test("a Steer confirmation shows before anything else, and the notice it covered shows again after it", () => {
  const { timers, notices, shown } = queue();
  notices.push(leave("Marlow"));
  notices.pushFirst({ kind: "steered", id: "steered:1", displayName: "Juniper" });
  assert.equal(shown(), "steered:1");
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(shown(), "Marlow left");

  // Two Steers in a row: the older confirmation is not shown again.
  timers.advance(ACTIVITY_NOTICE_MS);
  notices.pushFirst({ kind: "steered", id: "steered:2", displayName: "Juniper" });
  notices.pushFirst({ kind: "steered", id: "steered:3", displayName: "Kestrel" });
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(shown(), null);
});

test("composerDrafting: text, attachments or a reply count as writing; spaces do not", () => {
  assert.equal(composerDrafting({ draft: "  ", attachmentCount: 0, replying: false }), false);
  assert.equal(composerDrafting({ draft: "hi", attachmentCount: 0, replying: false }), true);
  assert.equal(composerDrafting({ draft: "", attachmentCount: 1, replying: false }), true);
  assert.equal(composerDrafting({ draft: "", attachmentCount: 0, replying: true }), true);
});

test("the orb follows the activity's kind and method, never its English summary", () => {
  assert.equal(orbStateForActivity({ kind: "text_delta", method: "item/agentMessage/delta" }), "composing");
  assert.equal(orbStateForActivity({ kind: "provider_event", method: "assistant" }), "composing");
  assert.equal(orbStateForActivity({ kind: "tool_lifecycle", method: "item/webSearch/started" }), "searching");
  assert.equal(orbStateForActivity({ kind: "tool_lifecycle", method: "Read" }), "searching");
  assert.equal(orbStateForActivity({ kind: "item_lifecycle", method: "item/reasoning/summaryTextDelta" }), "searching");
  assert.equal(orbStateForActivity({ kind: "command_output", method: "item/commandExecution/outputDelta" }), "working");
  assert.equal(orbStateForActivity({ kind: "tool_lifecycle", method: "item/fileChange/started" }), "working");
  assert.equal(orbStateForActivity({ kind: "approval", method: "item/commandExecution/requestApproval" }), "breathing");
  assert.equal(orbStateForActivity({ kind: "provider_event", method: "letagents/providerRetry" }), "breathing");
  assert.equal(orbStateForActivity({ kind: "provider_event", method: "letagents/backgroundWork" }), "breathing");
  // The words of a summary do not choose the orb: "Reading" in free text is not a read.
  assert.equal(orbStateForActivity({ kind: "command_output", method: "exec" }), "working");
  assert.equal(orbStateForTurn("publishing"), "composing");
  assert.equal(orbStateForTurn("retrying"), "breathing");
  assert.equal(orbStateForTurn("dispatching"), "working");
  assert.equal(orbStateForWork({ activity: "searching" }), "searching");
  assert.equal(orbStateForWork({}), "working", "a remote agent with no kind known works");
  assert.equal(orbStateForWork({ activity: "searching", waiting: true }), "breathing", "an agent that waits rests");
  assert.equal(orbStateForWork({ activity: "working", waitsForBackgroundWork: true }), "breathing");
  assert.equal(orbStateForWork({ awaitingRoomTurn: true }), "breathing");
});

function orbClock(options: { reduced?: boolean; hidden?: boolean } = {}) {
  const frames: Array<(ms: number) => void> = [];
  const environment = {
    reduced: options.reduced ?? false,
    hidden: options.hidden ?? false,
  };
  const clock = createActivityOrbClock({
    now: () => 5_000,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (handle) => { frames[handle - 1] = () => undefined; },
    reducedMotion: () => environment.reduced,
    documentHidden: () => environment.hidden,
  });
  return { clock, frames, environment };
}

test("reduced motion: each orb gets one still frame and the clock never runs", () => {
  const { clock, frames } = orbClock({ reduced: true });
  const drawn: number[] = [];
  clock.add({ draw: (t) => drawn.push(t), visible: () => true });
  assert.deepEqual(drawn, [ACTIVITY_ORB_STILL_SECONDS], "a still, representative frame at once");
  assert.equal(frames.length, 0, "no animation frame is asked for");
  assert.equal(clock.running(), false);
});

test("one shared clock drives every orb, skips offscreen ones, and stops when the window is hidden or the last orb goes", () => {
  const { clock, frames, environment } = orbClock();
  const a: number[] = [];
  const b: number[] = [];
  let bVisible = true;
  const hostA = { draw: (t: number) => a.push(t), visible: () => true };
  const hostB = { draw: (t: number) => b.push(t), visible: () => bVisible };
  clock.add(hostA);
  clock.add(hostB);
  assert.equal(frames.length, 1, "two orbs, one frame loop");
  assert.deepEqual([a.length, b.length], [1, 1], "each is painted at once, never blank");
  frames.at(-1)!(16);
  assert.deepEqual([a.at(-1), b.at(-1)], [0.016, 0.016], "both on the same time");
  bVisible = false;
  frames.at(-1)!(32);
  assert.equal(b.length, 2, "an offscreen orb is not drawn");
  assert.equal(a.length, 3);
  environment.hidden = true;
  frames.at(-1)!(48);
  assert.equal(clock.running(), false, "a hidden window stops the loop");
  environment.hidden = false;
  clock.refresh();
  assert.equal(clock.running(), true, "and it starts again when the window shows");
  clock.remove(hostA);
  clock.remove(hostB);
  assert.equal(clock.running(), false);
});

test("each orb state draws dots in the ink colour only", () => {
  const fills = new Set<string>();
  let arcs = 0;
  const context = {
    clearRect() {}, beginPath() {}, fill() {}, arc() { arcs += 1; },
    set fillStyle(value: string) { fills.add(value.replace(/,[\d.]+\)$/, ")")); },
  } as unknown as CanvasRenderingContext2D;
  for (const state of ["searching", "working", "composing", "breathing"] as const) drawActivityOrb(context, state, 1.2, 40, "250,250,250");
  assert.ok(arcs > 40);
  assert.deepEqual([...fills], ["rgba(250,250,250)"], "monochrome");
});

test("joins and leaves leave a quiet line in the timeline, in time order", () => {
  const messages = [
    { id: "m1", timestamp: "2026-10-26T10:00:00.000Z", sender: "Emmy", text: "hi", attachments: [], source: "browser" },
    { id: "m2", timestamp: "2026-10-26T10:02:00.000Z", sender: "Emmy", text: "again", attachments: [], source: "browser" },
  ] as never[];
  const lines = [{ id: "presence:j", timestamp: "2026-10-26T10:01:00.000Z", kind: "connected" as const, text: presenceTimelineText("connected", agent("Juniper")) }];
  const entries = buildMessageTimelineEntries(messages, [], lines);
  assert.deepEqual(entries.map(entry => entry.type), ["date", "message", "presence", "message"]);
  const presence = entries[2]!;
  assert.equal(presence.type === "presence" && presence.line.text, "Juniper joined · Claude Code");
  assert.equal(presenceTimelineText("disconnected", agent("Juniper")), "Juniper left");
  assert.equal(presenceTimelineText("connected", agent("Wren", null)), "Wren joined");
});

test("joinedNames and elapsedLabel read naturally", () => {
  assert.equal(joinedNames([agent("A")]), "A");
  assert.equal(joinedNames([agent("A"), agent("B")]), "A and B");
  assert.equal(joinedNames([agent("A"), agent("B"), agent("C")]), "A and 2 others");
  const start = "2026-10-26T10:00:00.000Z";
  assert.equal(elapsedLabel(start, Date.parse(start) + 8_400), "8s");
  assert.equal(elapsedLabel(start, Date.parse(start) + 125_000), "2m");
  assert.equal(elapsedLabel("not a time", 0), "");
});

test("useRoomActivity: presence changes become notices and timeline lines; a room change starts over", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { useRoomActivity } = await vite.ssrLoadModule("/renderer/src/composables/useRoomActivity.ts");
    const chips = await vite.ssrLoadModule("/renderer/src/domain/presence-chips.ts");
    const presence = ref<unknown[]>([]);
    const scope = ref("room-a");
    const drafting = ref(false);
    const previews = ref<ComposerEventPreview[]>([]);
    const realNow = Date.now;
    let now = 10_000_000;
    Date.now = () => now;
    const run = effectScope();
    try {
      const activity = run.run(() => useRoomActivity({
        presence: () => presence.value, scope: () => scope.value, ready: () => true,
        eventPreviews: () => previews.value, drafting: () => drafting.value,
      }))!;
      const worker = (name: string) => ({ sessionKind: "worker", sourceFlags: ["delivery"], freshness: "active", displayName: name, actorLabel: name, ideLabel: "Codex", agentKey: null });
      now += chips.PRESENCE_CHIP_SETTLE_MS + 1;
      presence.value = [worker("Juniper"), worker("Kestrel")];
      await nextTick();
      assert.equal(activity.notice.value?.kind, "join");
      assert.equal(joinedNames((activity.notice.value as { agents: PresenceChipAgent[] }).agents), "Juniper and Kestrel");
      assert.deepEqual(activity.presenceLines.value.map((line: { text: string }) => line.text), ["Juniper joined · Codex", "Kestrel joined · Codex"]);

      drafting.value = true;
      await nextTick();
      previews.value = [preview("msg_9")];
      await nextTick();
      assert.equal(activity.notice.value?.kind, "join", "the update waits behind the shown join");

      scope.value = "room-b";
      await nextTick();
      assert.equal(activity.notice.value, null);
      assert.deepEqual(activity.presenceLines.value, []);
    } finally {
      run.stop();
      Date.now = realNow;
    }
  } finally { await vite.close(); }
});

test("the line renders the Steer offer, notices, live work and typing as one pill", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomActivityLine.vue")).default;
    const render = async (props: Record<string, unknown>) => (await renderToString(createSSRApp(component, {
      notice: null, steer: null, work: [], typingNames: [], ...props,
    }))).replace(/ data-v-[a-f0-9]+/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const work = [{ id: "w1", displayName: "Juniper", summary: "Reading app.ts", startedAt: "2026-10-26T10:00:00.000Z", activity: "searching" }];

    const steer = await render({ steer: { entryId: "w1", displayName: "Juniper" }, work, typingNames: ["Emmy"] });
    assert.match(steer, /<strong>Juniper<\/strong> is mid-turn · your message waits<\/span><button type="button" class="room-activity-action" data-testid="desktop-composer-steer">Steer<\/button>/);
    assert.doesNotMatch(steer, /room-activity-live/, "one pill at a time");
    assert.match(steer, /role="status" aria-live="polite" aria-atomic="true">Juniper is mid-turn\. Your message waits\. Steer is available\.</);

    const live = await render({ work });
    assert.match(live, /data-orb="searching"/, "the orb comes from the agent's activity");
    assert.match(live, /<strong>Juniper<\/strong> <span class="room-activity-shimmer" data-testid="room-activity-live-echo">Reading app\.ts<\/span>/);
    assert.match(live, /aria-expanded="false"/);

    const several = await render({ work: [...work, { ...work[0], id: "w2", displayName: "Kestrel", activity: "working" }] });
    assert.match(several, /<strong>2 agents<\/strong> <span class="room-activity-shimmer">are working<\/span>/);

    const github = await render({ notice: { kind: "github", id: "github:m", preview: preview("m") }, work });
    assert.match(github, /<strong>PR #1744 opened by Kestrel<\/strong>/);
    assert.match(github, />\+120<\/span><span class="room-activity-deleted">−8<\/span>/);
    assert.match(github, /data-testid="room-activity-notice-open">View<\/button>/);

    const typing = await render({ typingNames: ["Emmy"] });
    assert.match(typing, /<strong>Emmy<\/strong> is typing/);

    const steered = await render({ notice: { kind: "steered", id: "s", displayName: "Juniper" } });
    assert.match(steered, /Steering <strong>Juniper<\/strong>&#39;s current turn/);

    assert.equal((await render({})).includes("room-activity-pill"), false, "nothing to say: no pill");
  } finally { await vite.close(); }
});

test("the orb component keeps the thinking-orbs MIT notice and is 20px with a 2x backing store", () => {
  const engine = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-chat/activity-orb.ts", import.meta.url)), "utf8");
  assert.match(engine, /thinking-orbs/);
  assert.match(engine, /MIT License\s+\*\s+\*\s+Copyright \(c\) 2026 Jakub Antalik/);
  const orb = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-chat/ActivityOrb.vue", import.meta.url)), "utf8");
  assert.match(orb, /withDefaults\(defineProps<\{ state: ActivityOrbState; size\?: number \}>\(\), \{ size: 20 \}\)/);
  assert.match(orb, /const backing = props\.size \* 2;/);
  assert.match(orb, /new IntersectionObserver/);
});

test("a pointer or keyboard focus on the line holds its notice through the room's queue", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const line = read("../src/components/desktop/content/room-chat/RoomActivityLine.vue");
  const viewport = read("../src/components/desktop/content/room-chat/RoomMessageViewport.vue");
  const chat = read("../src/components/desktop/content/RoomChatView.vue");
  assert.match(line, /@pointerenter="hold\(true\)"\s+@pointerleave="hold\(false\)"\s+@focusin="hold\(true\)"\s+@focusout="onFocusOut"/);
  assert.match(viewport, /@hold="\$emit\('activity-hold', \$event\)"/);
  assert.match(chat, /@activity-hold="\(held\) => held \? roomActivity\.pause\(\) : roomActivity\.resume\(\)"/);
});

test("each reply anchor carries what the flight measures, there is one per agent, and a waiting row shows no elapsed time", () => {
  const line = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-chat/RoomActivityLine.vue", import.meta.url)), "utf8");
  // captureWork (shared/ui/room-message-motion.ts) needs a pulse, a name and a summary inside the anchor.
  assert.match(line, /class="room-activity-anchor"[\s\S]*?><span class="room-activity-pulse"><\/span><strong><\/strong><span class="room-activity-copy"><span><\/span><\/span><\/span>/);
  // With the list open, its rows are the only anchors, so each agent has exactly one.
  assert.match(line, /<template v-if="!single && !listOpen">/);
  assert.match(line, /:data-motion-work="single && !single\.awaitingRoomTurn && !listOpen \? '' : undefined"/);
  assert.match(line, /work\.waiting \? "" : elapsedLabel\(work\.startedAt, now\)/);
  const motion = readFileSync(fileURLToPath(new URL("../../../../shared/ui/room-message-motion.ts", import.meta.url)), "utf8");
  assert.match(motion, /'\.room-local-agent-work-pulse, \.room-activity-pulse'/);
  assert.match(motion, /'\.room-local-agent-work-copy > span, \.room-activity-copy > span'/);
});
