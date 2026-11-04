import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import type { WakeRule, WakeRuleTestResult, WakeWebhookAgent, WakeWebhookApi } from "../../../../shared/wake-rules.mjs";
import {
  WAKE_WEBHOOK_KEY_HELP,
  WAKE_WEBHOOK_SECRET_NOTICE,
  WAKE_WEBHOOK_TEST_HELP,
  describeWakeTestResult,
  generateWakeWebhookSecret,
  partitionWakeWebhookRules,
  selectOwnWakeWebhookRules,
  useCancelledWakeWebhookRules,
  useWakeWebhookForm,
  validateWakeWebhookDraft,
  wakeWebhookCancelledToggleLabel,
  wakeWebhookEmptyText,
  wakeWebhookLastResultLabel,
} from "../../../../shared/ui/wake-webhook-form";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const agents: WakeWebhookAgent[] = [
  { agent_key: "ada/grokbot", agent_name: "GrokBot", live: true, last_seen_at: "2026-11-04T10:00:00.000Z" },
  { agent_key: "ada/relay", agent_name: "relay", live: false, last_seen_at: "2026-11-03T10:00:00.000Z" },
];

function rule(overrides: Partial<WakeRule> = {}): WakeRule {
  return {
    id: "wake_1",
    room_id: "sky-owl",
    agent_key: "ada/grokbot",
    agent_name: "GrokBot",
    event: "room.message",
    arguments: { mentions_me: true },
    repeat: true,
    expires_at: "2026-12-04T10:00:00.000Z",
    note: null,
    status: "active",
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z",
    fire_count: 0,
    last_fired_at: null,
    wake_message_id: null,
    cancelled_by: null,
    ended_reason: null,
    delivery: { kind: "webhook", paused: false, has_bearer: true, delivered_count: 3, consecutive_failures: 1, over_cap_count: 0, last_status: 503, last_error: "http_5xx", last_attempt_at: "2026-11-04T11:00:00.000Z" },
    ...overrides,
  };
}

function api(overrides: Partial<WakeWebhookApi> = {}): WakeWebhookApi & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    async listAgents(roomId) { calls.push(["listAgents", roomId]); return agents; },
    async add(roomId, agentKey, input) { calls.push(["add", roomId, agentKey, input]); return { rule: rule({ id: "wake_new", agent_key: agentKey }), created: true }; },
    async test(roomId, ruleId) { calls.push(["test", roomId, ruleId]); return { status: 200, error_class: null, delivery_id: "whd_t", resumed: false }; },
    async cancel(roomId, ruleId) { calls.push(["cancel", roomId, ruleId]); return rule({ id: ruleId, status: "cancelled" }); },
    ...overrides,
  };
}

test("the signing secret is 32 base64url characters from 24 random bytes", () => {
  const secret = generateWakeWebhookSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(secret, generateWakeWebhookSecret(), "two secrets differ");
  // Bytes that would need + and / in plain base64 come out as - and _.
  const fixed = generateWakeWebhookSecret((bytes) => { bytes.fill(0xfb); return bytes; });
  assert.equal(fixed, "-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7");
});

test("the draft is checked the way the server checks the rule", () => {
  const base = { agentKey: "ada/grokbot", url: "https://hooks.example/grok/abc", bearer: "", note: "" };
  const ok = validateWakeWebhookDraft(base, agents);
  assert.deepEqual(ok, { ok: true, agentKey: "ada/grokbot", input: { url: "https://hooks.example/grok/abc", note: null } });

  const withKey = validateWakeWebhookDraft({ ...base, bearer: " crsr_abcdef0123 ", note: " wake my routine " }, agents);
  assert.deepEqual(withKey, { ok: true, agentKey: "ada/grokbot", input: { url: "https://hooks.example/grok/abc", bearer: "crsr_abcdef0123", note: "wake my routine" } });

  const errors = (draft: Partial<typeof base>) => {
    const result = validateWakeWebhookDraft({ ...base, ...draft }, agents);
    assert.equal(result.ok, false);
    return result.ok ? {} : result.errors;
  };
  assert.deepEqual(Object.keys(errors({ agentKey: "" })), ["agentKey"]);
  assert.deepEqual(Object.keys(errors({ agentKey: "bob/other" })), ["agentKey"], "only the viewer's own agents");
  assert.match(errors({ url: "" }).url!, /Enter/);
  assert.match(errors({ url: "http://hooks.example/x" }).url!, /https/);
  assert.match(errors({ url: "hooks.example/x" }).url!, /https/);
  assert.match(errors({ url: "https://user:pw@hooks.example/x" }).url!, /user name/);
  assert.match(errors({ url: "https://hooks.example:8443/x" }).url!, /443/);
  assert.match(errors({ url: `https://hooks.example/${"a".repeat(2048)}` }).url!, /2048/);
  assert.match(errors({ bearer: "short" }).bearer!, /8 to 512/);
  assert.match(errors({ bearer: "has a space" }).bearer!, /8 to 512/);
  assert.match(errors({ bearer: "k".repeat(513) }).bearer!, /8 to 512/);
  assert.match(errors({ bearer: "clé-très-secrète" }).bearer!, /ASCII/);
  assert.match(errors({ note: "n".repeat(281) }).note!, /280/);
  assert.match(errors({ note: "line\u0007" }).note!, /plain text/);
  assert.deepEqual(Object.keys(errors({ agentKey: "", url: "" })).sort(), ["agentKey", "url"], "every problem is reported at once");
});

test("a test result reads as Accepted, a rejected key, or the error class", () => {
  const describe = (result: WakeRuleTestResult) => describeWakeTestResult(result);
  assert.deepEqual(describe({ status: 200, error_class: null, delivery_id: "whd_1", resumed: false }), { tone: "ok", text: "Accepted" });
  assert.deepEqual(describe({ status: 204, error_class: null, delivery_id: "whd_1", resumed: false }), { tone: "ok", text: "Accepted" });
  assert.deepEqual(describe({ status: 200, error_class: null, delivery_id: "whd_1", resumed: true }), { tone: "ok", text: "Accepted; the rule is active again" });
  assert.deepEqual(describe({ status: 401, error_class: "http_4xx", delivery_id: "whd_1", resumed: false }), { tone: "rejected", text: "The receiver rejected the key" });
  assert.deepEqual(describe({ status: 403, error_class: "http_4xx", delivery_id: "whd_1", resumed: false }), { tone: "rejected", text: "The receiver rejected the key" });
  assert.deepEqual(describe({ status: 404, error_class: "http_4xx", delivery_id: "whd_1", resumed: false }), { tone: "failed", text: "http_4xx (404)" });
  assert.deepEqual(describe({ status: 503, error_class: "http_5xx", delivery_id: "whd_1", resumed: false }), { tone: "failed", text: "http_5xx (503)" });
  assert.deepEqual(describe({ status: 0, error_class: "timeout", delivery_id: "whd_1", resumed: false }), { tone: "failed", text: "timeout" });
  assert.deepEqual(describe({ status: 0, error_class: "url_not_allowed", delivery_id: null, resumed: false }), { tone: "failed", text: "url_not_allowed" });
});

test("the list holds the viewer's webhook rules only, held ones first, and words the last result", () => {
  const own = rule();
  const paused = rule({ id: "wake_2", status: "paused", created_at: "2026-11-04T12:00:00.000Z" });
  const ended = rule({ id: "wake_3", status: "cancelled", created_at: "2026-11-04T13:00:00.000Z" });
  const email = rule({ id: "wake_4", delivery: { kind: "email", paused: false } });
  const timer = rule({ id: "wake_5", event: "timer", arguments: { at: "2026-11-05T10:00:00.000Z" }, delivery: null });
  const theirs = rule({ id: "wake_6", agent_key: "bob/other", agent_name: "other" });
  assert.deepEqual(selectOwnWakeWebhookRules([own, paused, ended, email, timer, theirs], agents).map((item) => item.id), ["wake_2", "wake_1", "wake_3"]);
  assert.equal(wakeWebhookLastResultLabel(own), "last http_5xx (503)");
  assert.equal(wakeWebhookLastResultLabel(rule({ delivery: { kind: "webhook", paused: false, last_status: 200, last_error: null, last_attempt_at: "2026-11-04T11:00:00.000Z" } })), "last 200");
  assert.equal(wakeWebhookLastResultLabel(rule({ delivery: { kind: "webhook", paused: false, last_status: null, last_error: null, last_attempt_at: null } })), "no delivery yet");
});

test("a last result that came from a test says so; one from a room message does not", () => {
  const delivery = (overrides: NonNullable<WakeRule["delivery"]>) => rule({ delivery: overrides });
  const base = { kind: "webhook" as const, paused: false, last_attempt_at: "2026-11-04T11:00:00.000Z" };
  assert.equal(wakeWebhookLastResultLabel(delivery({ ...base, last_status: 200, last_error: null, last_attempt_was_test: true })), "last test 200");
  assert.equal(wakeWebhookLastResultLabel(delivery({ ...base, last_status: 503, last_error: "http_5xx", last_attempt_was_test: true })), "last test http_5xx (503)");
  assert.equal(wakeWebhookLastResultLabel(delivery({ ...base, last_status: 0, last_error: "timeout", last_attempt_was_test: true })), "last test timeout");
  assert.equal(wakeWebhookLastResultLabel(delivery({ ...base, last_status: 200, last_error: null, last_attempt_was_test: false })), "last 200");
  assert.equal(wakeWebhookLastResultLabel(delivery({ ...base, last_status: 200, last_error: null })), "last 200", "a server that does not send the flag: no word added");
  assert.equal(
    wakeWebhookLastResultLabel(delivery({ kind: "webhook", paused: false, last_status: null, last_error: null, last_attempt_at: null, last_attempt_was_test: true })),
    "no delivery yet",
    "no attempt, nothing to call a test",
  );
});

test("only a cancelled rule is held back; the button reads Show cancelled (N), then Hide cancelled", () => {
  const rules = [
    rule({ id: "wake_1" }),
    rule({ id: "wake_2", status: "paused" }),
    rule({ id: "wake_3", status: "pending_confirmation" }),
    rule({ id: "wake_4", status: "retired" }),
    rule({ id: "wake_5", status: "expired" }),
    rule({ id: "wake_6", status: "cancelled" }),
    rule({ id: "wake_7", status: "cancelled" }),
  ];
  const parts = partitionWakeWebhookRules(rules);
  assert.deepEqual(parts.listed.map((item) => item.id), ["wake_1", "wake_2", "wake_3", "wake_4", "wake_5"], "active, paused, pending and ended-by-itself rules stay listed");
  assert.deepEqual(parts.cancelled.map((item) => item.id), ["wake_6", "wake_7"]);
  assert.equal(wakeWebhookCancelledToggleLabel(2, false), "Show cancelled (2)");
  assert.equal(wakeWebhookCancelledToggleLabel(2, true), "Hide cancelled");
  assert.equal(wakeWebhookEmptyText(0), "No webhook wake-ups for your agents in this room yet.");
  assert.equal(wakeWebhookEmptyText(3), "No active webhook wake-ups for your agents in this room.");
});

test("the cancelled rules start hidden, the button shows and hides them, and a count of zero closes it again", () => {
  const all = ref<WakeRule[]>([rule({ id: "wake_1" }), rule({ id: "wake_2", status: "cancelled" }), rule({ id: "wake_3", status: "cancelled" })]);
  const view = useCancelledWakeWebhookRules(all);
  assert.equal(view.shown.value, false, "collapsed by default");
  assert.deepEqual(view.listed.value.map((item) => item.id), ["wake_1"]);
  assert.equal(view.toggleLabel.value, "Show cancelled (2)");
  view.toggle();
  assert.equal(view.shown.value, true);
  assert.equal(view.toggleLabel.value, "Hide cancelled");
  assert.deepEqual(view.cancelled.value.map((item) => item.id), ["wake_2", "wake_3"]);
  view.toggle();
  assert.equal(view.shown.value, false);
  assert.equal(view.toggleLabel.value, "Show cancelled (2)");

  // A second instance has its own state: nothing is shared or saved between components.
  view.toggle();
  const other = useCancelledWakeWebhookRules(all);
  assert.equal(other.shown.value, false);

  // The count follows the rules; an open list closes when its last rule goes, and a later cancel starts closed.
  all.value = [rule({ id: "wake_1" }), rule({ id: "wake_2", status: "cancelled" })];
  assert.equal(view.toggleLabel.value, "Hide cancelled", "still open while a cancelled rule remains");
  all.value = [rule({ id: "wake_1" })];
  assert.equal(view.shown.value, false);
  view.toggle();
  assert.equal(view.shown.value, false, "nothing to show, nothing to toggle");
  all.value = [rule({ id: "wake_1" }), rule({ id: "wake_4", status: "cancelled" })];
  assert.equal(view.toggleLabel.value, "Show cancelled (1)");
});

test("saving makes the secret, sends it once, and shows it until dismissed; a second form never shows it again", async () => {
  const transport = api();
  const changed: number[] = [];
  const form = useWakeWebhookForm({
    roomId: ref("sky-owl"), agents: ref(agents), api: transport, onChanged: () => changed.push(1), makeSecret: () => "s".repeat(32),
  });
  assert.equal(form.open.value, false);
  form.show();
  assert.equal(form.open.value, true);
  assert.equal(form.draft.agentKey, "", "two agents: the person picks one");

  // Validation blocks the save and nothing is sent.
  form.draft.url = "http://not-https.example";
  assert.equal(await form.submit(), false);
  assert.deepEqual(Object.keys(form.errors.value).sort(), ["agentKey", "url"]);
  assert.equal(transport.calls.length, 0);
  assert.equal(form.revealedSecret.value, null);

  form.draft.agentKey = "ada/grokbot";
  form.draft.url = "https://hooks.example/grok/abc";
  form.draft.bearer = "crsr_key_0001";
  form.draft.note = "wake my routine";
  assert.equal(await form.submit(), true);
  assert.deepEqual(transport.calls, [["add", "sky-owl", "ada/grokbot", { url: "https://hooks.example/grok/abc", bearer: "crsr_key_0001", note: "wake my routine", secret: "s".repeat(32) }]]);
  assert.deepEqual(form.revealedSecret.value, { ruleId: "wake_new", agentName: "GrokBot", secret: "s".repeat(32), created: true });
  assert.equal(form.open.value, false, "the form closes; the secret takes its place");
  assert.deepEqual(form.draft, { agentKey: "", url: "", bearer: "", note: "" }, "the key and URL are not kept");
  assert.deepEqual(changed, [1]);

  form.dismissSecret();
  assert.equal(form.revealedSecret.value, null);
  form.show();
  assert.equal(form.revealedSecret.value, null, "opening the form again never brings the secret back");
  form.hide();
  assert.equal(form.open.value, false);
});

test("a save the server refuses keeps the form open with the server's sentence", async () => {
  const transport = api({ async add() { throw new Error("The URL is not allowed. Use a public https URL on port 443."); } });
  const form = useWakeWebhookForm({ roomId: ref("sky-owl"), agents: ref([agents[0]!]), api: transport });
  form.show();
  assert.equal(form.draft.agentKey, "ada/grokbot", "one agent is picked for the person");
  form.draft.url = "https://hooks.example/private";
  assert.equal(await form.submit(), false);
  assert.equal(form.open.value, true);
  assert.equal(form.saveError.value, "The URL is not allowed. Use a public https URL on port 443.");
  assert.equal(form.revealedSecret.value, null);
  assert.equal(form.saving.value, false);
});

test("Send test and Cancel call the room's API and keep their result on the row", async () => {
  const results: WakeRuleTestResult[] = [
    { status: 200, error_class: null, delivery_id: "whd_1", resumed: false },
    { status: 401, error_class: "http_4xx", delivery_id: "whd_2", resumed: false },
    { status: 0, error_class: "timeout", delivery_id: "whd_3", resumed: false },
    { status: 200, error_class: null, delivery_id: "whd_4", resumed: true },
  ];
  const transport = api({ async test() { return results.shift()!; } });
  const changed: number[] = [];
  const form = useWakeWebhookForm({ roomId: ref("sky-owl"), agents: ref(agents), api: transport, onChanged: () => changed.push(1) });
  const target = rule();
  await form.sendTest(target);
  assert.deepEqual(form.tests.get("wake_1"), { state: "done", tone: "ok", text: "Accepted" });
  await form.sendTest(target);
  assert.deepEqual(form.tests.get("wake_1"), { state: "done", tone: "rejected", text: "The receiver rejected the key" });
  await form.sendTest(target);
  assert.deepEqual(form.tests.get("wake_1"), { state: "done", tone: "failed", text: "timeout" });
  await form.sendTest(target);
  assert.deepEqual(form.tests.get("wake_1"), { state: "done", tone: "ok", text: "Accepted; the rule is active again" });
  assert.equal(changed.length, 4, "each test refreshes the rules so the counters move");

  const limited = api({ async test() { throw new Error("You sent 5 tests in the last 10 minutes. Wait a few minutes, then try again."); } });
  const limitedForm = useWakeWebhookForm({ roomId: ref("sky-owl"), agents: ref(agents), api: limited });
  await limitedForm.sendTest(target);
  assert.deepEqual(limitedForm.tests.get("wake_1"), { state: "error", tone: "failed", text: "You sent 5 tests in the last 10 minutes. Wait a few minutes, then try again." });

  await form.cancel(target);
  assert.deepEqual(transport.calls.at(-1), ["cancel", "sky-owl", "wake_1"]);
  assert.equal(form.tests.has("wake_1"), false, "a cancelled row drops its test result");
  assert.equal(changed.length, 5);
});

let vite: ViteDevServer;
let WakeWebhookSection: object;
let WakeWebhookRuleList: object;
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  WakeWebhookSection = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/WakeWebhookSection.vue", import.meta.url)))).default;
  WakeWebhookRuleList = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/WakeWebhookRuleList.vue", import.meta.url)))).default;
});
after(async () => {
  await vite?.close();
});

async function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(WakeWebhookSection, { roomId: "sky-owl", api: api(), rules: [], agents, ...props }) }));
}

test("the section shows only for a person with an agent in the room, and lists each rule with its state, counts and key", async () => {
  assert.equal((await render({ agents: [] })).includes("wake-webhook"), false, "no agents: nothing to show");

  const html = await render({ rules: [rule(), rule({ id: "wake_2", status: "paused", note: "wake my routine", delivery: { kind: "webhook", paused: true, has_bearer: false, delivered_count: 0, consecutive_failures: 5, over_cap_count: 0, last_status: 401, last_error: "http_4xx", last_attempt_at: "2026-11-04T11:00:00.000Z" } }), rule({ id: "wake_3", status: "cancelled" }), rule({ id: "wake_9", agent_key: "bob/other", agent_name: "other" })] });
  assert.match(html, /data-testid="wake-webhook-add"[^>]*>\s*Wake a bot by webhook/);
  assert.doesNotMatch(html, /data-testid="wake-webhook-form"/, "the form opens on request");
  assert.doesNotMatch(html, /data-testid="wake-webhook-secret"/, "no secret before a save");
  const rows = [...html.matchAll(/data-rule-id="(wake_\d)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, ["wake_2", "wake_1"], "held rules first; a cancelled rule and another account's agent are not listed");
  assert.match(html, /data-rule-id="wake_1"[\s\S]*?Active[\s\S]*?3 delivered ·\s*1 failed in a row ·\s*last http_5xx \(503\) ·\s*Key: yes/);
  assert.match(html, /data-rule-id="wake_2"[\s\S]*?Paused[\s\S]*?wake my routine[\s\S]*?0 delivered ·\s*5 failed in a row ·\s*last http_4xx \(401\) ·\s*Key: no/);
  // Send test and Cancel on held rules only.
  const actionsOf = (id: string) => html.slice(html.indexOf(`data-rule-id="${id}"`)).split("</li>")[0]!;
  assert.match(actionsOf("wake_1"), /Send test/);
  assert.match(actionsOf("wake_1"), />\s*Cancel\s*</);
  assert.match(actionsOf("wake_2"), /Send test/);
  // The cancelled rule is behind a button, closed.
  assert.doesNotMatch(html, /data-rule-id="wake_3"/);
  assert.doesNotMatch(html, /data-testid="wake-webhook-cancelled-rules"/);
  assert.match(html, /data-testid="wake-webhook-cancelled-toggle"[^>]*aria-expanded="false"[^>]*>Show cancelled \(1\)<\/button>/);
  assert.doesNotMatch(html, /hooks\.example|crsr_/, "no URL or key appears anywhere in the list");
  // Vue's SSR writes the apostrophe as an entity.
  assert.match(html, /A test counts against the rule(&#39;|')s hourly budget of 20 wake-ups\./, "the budget note sits under Send test");
  assert.doesNotMatch(await render({ rules: [rule({ status: "cancelled" })] }), /hourly budget/, "no held rule, no Send test, no note");
});

test("a row says \"last test 200\" when the last answer came from a test", async () => {
  const fromTest = rule({ id: "wake_1", delivery: { kind: "webhook", paused: false, has_bearer: true, delivered_count: 2, consecutive_failures: 0, last_status: 200, last_error: null, last_attempt_at: "2026-11-04T11:00:00.000Z", last_attempt_was_test: true } });
  const fromMessage = rule({ id: "wake_2", delivery: { kind: "webhook", paused: false, has_bearer: false, delivered_count: 2, consecutive_failures: 0, last_status: 200, last_error: null, last_attempt_at: "2026-11-04T11:00:00.000Z", last_attempt_was_test: false } });
  const html = await render({ rules: [fromTest, fromMessage] });
  assert.match(html, /data-rule-id="wake_1"[\s\S]*?2 delivered ·\s*0 failed in a row ·\s*last test 200 ·\s*Key: yes/);
  assert.match(html, /data-rule-id="wake_2"[\s\S]*?2 delivered ·\s*0 failed in a row ·\s*last 200 ·\s*Key: no/);
  assert.equal(html.match(/last test/g)?.length, 1, "only the test row says test");
});

test("with no cancelled rule there is no button; with only cancelled rules the list says none are active", async () => {
  const none = await render({ rules: [rule()] });
  assert.doesNotMatch(none, /wake-webhook-cancelled-toggle|Show cancelled/);

  const only = await render({ rules: [rule({ id: "wake_1", status: "cancelled" }), rule({ id: "wake_2", status: "cancelled" })] });
  assert.doesNotMatch(only, /data-rule-id=/, "closed: no rows");
  assert.match(only, /No active webhook wake-ups for your agents in this room\./);
  assert.match(only, /data-testid="wake-webhook-cancelled-toggle"[^>]*>Show cancelled \(2\)<\/button>/);
  assert.doesNotMatch(only, /No webhook wake-ups for your agents in this room yet/, "they existed; this is not the first-time text");
  assert.doesNotMatch(only, /hourly budget/);
  // While rules load, the empty line waits; the button does not.
  assert.doesNotMatch(await render({ rules: [], loading: true }), /No webhook wake-ups|No active webhook/);
});

test("the cancelled list uses the same row as the main list and offers no Send test or Cancel", async () => {
  const form = useWakeWebhookForm({ roomId: ref("sky-owl"), agents: ref(agents), api: api() });
  const cancelled = [
    rule({ id: "wake_8", status: "cancelled", note: "old routine", delivery: { kind: "webhook", paused: false, has_bearer: true, delivered_count: 4, consecutive_failures: 0, last_status: 200, last_error: null, last_attempt_at: "2026-11-04T11:00:00.000Z", last_attempt_was_test: true } }),
    rule({ id: "wake_9", status: "cancelled" }),
  ];
  const html = await renderToString(createSSRApp({ render: () => h(WakeWebhookRuleList, { rules: cancelled, form, label: "Cancelled webhook wake-ups" }) }));
  assert.match(html, /<ul class="wake-webhook-rules" aria-label="Cancelled webhook wake-ups">/);
  assert.deepEqual([...html.matchAll(/data-rule-id="(wake_\d)"/g)].map((match) => match[1]), ["wake_8", "wake_9"]);
  assert.match(html, /data-rule-id="wake_8"[\s\S]*?GrokBot[\s\S]*?Cancelled[\s\S]*?old routine[\s\S]*?4 delivered ·\s*0 failed in a row ·\s*last test 200 ·\s*Key: yes/);
  assert.doesNotMatch(html, /Send test|>\s*Cancel\s*</, "an ended rule has no buttons");
});

test("the section wires the button to the cancelled list: closed at first, the second list only while open", () => {
  const section = source("../../../../shared/ui/WakeWebhookSection.vue");
  assert.match(section, /<WakeWebhookRuleList\s+v-if="listedRules\.length"\s+:rules="listedRules"/);
  assert.match(section, /<button\s+v-if="cancelledRules\.length"\s+type="button"\s+class="wake-webhook-link"[\s\S]*?:aria-expanded="cancelledShown"\s+@click="toggleCancelled"\s*>\{\{ cancelledToggleLabel \}\}<\/button>/);
  assert.match(section, /<WakeWebhookRuleList\s+v-if="cancelledShown"\s+:rules="cancelledRules"/);
  // Local state only: nothing here reads or writes storage.
  assert.doesNotMatch(section, /localStorage|sessionStorage/);
  assert.doesNotMatch(source("../../../../shared/ui/wake-webhook-form.ts"), /localStorage|sessionStorage/);
});

test("the empty list says so, and a load error is announced", async () => {
  const html = await render({ rules: [], error: "Your agents in this room could not be loaded." });
  assert.match(html, /No webhook wake-ups for your agents in this room yet/);
  assert.match(html, /role="alert"[^>]*>Your agents in this room could not be loaded\./);
});

test("the form's help text and the secret notice are the agreed sentences, and the secret block renders only from the form state", () => {
  const section = source("../../../../shared/ui/WakeWebhookSection.vue");
  assert.equal(WAKE_WEBHOOK_KEY_HELP, "The receiver's sender key, sent as Authorization: Bearer. Grok Bot routines need one.");
  assert.equal(WAKE_WEBHOOK_SECRET_NOTICE, "Receivers that verify X-LetAgents-Signature need this secret; LetAgents cannot show it again.");
  assert.match(WAKE_WEBHOOK_TEST_HELP, /A test counts against the rule's hourly budget of 20 wake-ups\./);
  assert.match(section, /\{\{ WAKE_WEBHOOK_TEST_HELP \}\}/);
  assert.match(section, /<small v-else>\{\{ WAKE_WEBHOOK_KEY_HELP \}\}<\/small>/);
  assert.match(section, /v-if="form\.revealedSecret\.value"[\s\S]*?data-testid="wake-webhook-secret-value">\{\{ form\.revealedSecret\.value\.secret \}\}<\/code>[\s\S]*?\{\{ WAKE_WEBHOOK_SECRET_NOTICE \}\}/);
  // The key is typed into a password field; the form binds no URL or key from a saved rule.
  assert.match(section, /v-model="form\.draft\.bearer"\s+type="password"/);
  assert.doesNotMatch(section, /rule\.(url|secret|bearer)|delivery\.(url|secret|bearer)/);
});

test("the room settings panel shows the section for cloud rooms and lists it in the rail only while it has agents", () => {
  const panel = source("../src/components/desktop/content/room-shell/DesktopRoomActionPanel.vue");
  assert.match(panel, /<RoomWakeWebhooks v-if="cloudRoom" :room-identifier="room\.identifier" @summary="wakeSummary = \$event" \/>/);
  assert.match(panel, /cloudRoom\.value && wakeSummary\.value\s*\?\s*\{ id: "wake", title: "Wake-ups", icon: Webhook, summary: wakeSummary\.value \}/);
  const section = source("../src/components/desktop/content/room-shell/RoomWakeWebhooks.vue");
  assert.match(section, /<section\s+v-if="agents\.length"[\s\S]*?data-section="wake"/);
  assert.match(section, /<h3 id="room-settings-heading-wake">Wake a bot by webhook<\/h3>/);
  assert.match(section, /useRoomWakeRules\(roomIdentifier, computed\(\(\) => agents\.value\.length > 0\)\)/);
  assert.match(section, /emit\("summary", null\)/);
});
