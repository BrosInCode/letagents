<template>
  <section v-if="rows.length || recent.length" ref="root" class="wake-rules" aria-label="Wake rules">
    <TransitionGroup tag="ul" name="wake-rule" class="wake-rules-active">
      <li
        v-for="row in rows"
        :key="row.rule.id"
        class="wake-rule"
        :data-rule-id="row.rule.id"
        :data-state="row.cancelled ? 'cancelled' : 'active'"
      >
        <span class="wake-rule-mark"><WakeGlyph :state="row.cancelled ? 'ended' : 'waiting'" /></span>
        <div class="wake-rule-copy">
          <p class="wake-rule-kicker">{{ row.cancelled ? "Cancelled" : `Waiting ${describe(row.rule).preposition}` }}</p>
          <strong>{{ describe(row.rule).object }}</strong>
          <span v-if="row.rule.note" class="wake-rule-note">{{ row.rule.note }}</span>
          <span class="wake-rule-meta">
            <template v-if="row.rule.event === 'timer'">
              Wakes in <time :datetime="row.rule.arguments.at" :title="fullTime(row.rule.arguments.at)">{{ until(row.rule.arguments.at!) }}</time>
            </template>
            <template v-else>
              <time :datetime="row.rule.created_at" :title="`Since ${fullTime(row.rule.created_at)}`">{{ span(row.rule.created_at) }}</time> so far
              · {{ row.rule.repeat ? "Repeats until" : "Expires" }}
              <time :datetime="row.rule.expires_at" :title="fullTime(row.rule.expires_at)">{{ clock(row.rule.expires_at) }}</time>
            </template>
          </span>
          <span v-if="row.error" class="wake-rule-error" role="status">{{ row.error }}</span>
        </div>
        <button
          v-if="row.cancelled"
          type="button"
          class="wake-rule-action"
          data-tone="undo"
          :disabled="busy.has(row.rule.id)"
          @click="undo(row.rule)"
        >Undo</button>
        <button
          v-else-if="api"
          type="button"
          class="wake-rule-action"
          :disabled="busy.has(row.rule.id)"
          :aria-label="`Cancel wake rule: waiting ${describe(row.rule).preposition} ${describe(row.rule).object}`"
          @click="cancel(row.rule)"
        >Cancel</button>
      </li>
    </TransitionGroup>

    <details v-if="recent.length" class="wake-rules-recent">
      <summary>Recent wakes <span>{{ recent.length }}</span></summary>
      <ul>
        <li v-for="rule in recent" :key="rule.id" :data-status="rule.status">
          <WakeGlyph :state="rule.status === 'fired' ? 'woke' : 'ended'" still />
          <span class="wake-rules-recent-copy">
            <strong>{{ outcomeLabel(rule) }}</strong>
            <span>{{ describe(rule).preposition === "until" ? `until ${describe(rule).object}` : describe(rule).object }}</span>
          </span>
          <button
            v-if="rule.wake_message_id"
            type="button"
            class="wake-rules-recent-time"
            :title="`Show the wake message · ${fullTime(endedAt(rule))}`"
            @click="emit('open-message', rule.wake_message_id)"
          ><time :datetime="endedAt(rule)">{{ clock(endedAt(rule)) }}</time></button>
          <time v-else class="wake-rules-recent-time" :datetime="endedAt(rule)" :title="fullTime(endedAt(rule))">{{ clock(endedAt(rule)) }}</time>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  describeWakeRule,
  formatWakeClock,
  formatWakeSpan,
  type WakeRule,
  type WakeRuleApi,
} from "../wake-rules.mjs";
import WakeGlyph from "./WakeGlyph.vue";

const props = withDefaults(defineProps<{
  roomId: string;
  /** The agent's active rules, soonest first. */
  rules: readonly WakeRule[];
  recent?: readonly WakeRule[];
  /** Without an API the panel is read-only. */
  api?: Pick<WakeRuleApi, "cancel" | "restore"> | null;
}>(), { recent: () => [], api: null });
const emit = defineEmits<{ "open-message": [messageId: string] }>();

/** How long a cancelled rule stays in place with Undo before it leaves. */
const UNDO_WINDOW_MS = 8000;
const now = ref(new Date());
const busy = reactive(new Set<string>());
const errors = reactive(new Map<string, string>());
const cancelled = reactive(new Map<string, { rule: WakeRule; timer: ReturnType<typeof setTimeout> }>());
/**
 * Restored rules stay on screen until the room's lists catch up: back among
 * the active rules, or among recent ones if anything that happened while it
 * was cancelled woke the agent straight away.
 */
const restored = reactive(new Map<string, WakeRule>());
watch(() => [props.rules, props.recent] as const, ([rules, recent]) => {
  for (const rule of [...rules, ...recent]) {
    if (rule.status !== "cancelled") restored.delete(rule.id);
  }
});

// Undo happens where the action was: a cancelled rule keeps its row until
// the window closes, even after the room's list no longer includes it.
const rows = computed(() => {
  const active = props.rules.filter((rule) => !cancelled.has(rule.id));
  const held = [...cancelled.values()].map(({ rule }) => rule);
  const revived = [...restored.values()].filter((rule) => !cancelled.has(rule.id) && !props.rules.some((candidate) => candidate.id === rule.id));
  return [...active, ...held, ...revived]
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
    .map((rule) => ({ rule, cancelled: cancelled.has(rule.id), error: errors.get(rule.id) ?? null }));
});

const describe = (rule: Pick<WakeRule, "event" | "arguments">) =>
  describeWakeRule(rule, { formatTime: (iso) => formatWakeClock(iso, now.value) });
const clock = (iso: string) => formatWakeClock(iso, now.value);
const span = (iso: string) => formatWakeSpan(now.value.getTime() - Date.parse(iso));
const until = (iso: string) => formatWakeSpan(Date.parse(iso) - now.value.getTime());
const fullTime = (iso: string | undefined) => iso
  ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  : "";
const endedAt = (rule: WakeRule) => rule.last_fired_at ?? rule.updated_at;
const root = ref<HTMLElement | null>(null);

/**
 * Cancel and Undo replace each other in the same place. When the pressed
 * button was focused, focus moves to its replacement instead of the page.
 */
async function keepFocusOnRow(ruleId: string, hadFocus: boolean): Promise<void> {
  if (!hadFocus) return;
  await nextTick();
  root.value?.querySelector<HTMLButtonElement>(`[data-rule-id="${CSS.escape(ruleId)}"] .wake-rule-action`)?.focus();
}

function rowHasFocus(ruleId: string): boolean {
  const active = document.activeElement;
  return Boolean(active && root.value?.querySelector(`[data-rule-id="${CSS.escape(ruleId)}"]`)?.contains(active));
}

function outcomeLabel(rule: WakeRule): string {
  if (rule.status === "fired" || (rule.status === "active" && rule.fire_count > 0)) return "Woke";
  if (rule.status === "expired") return "Stopped waiting";
  if (rule.status === "retired") return rule.ended_reason ? `Ended: ${rule.ended_reason}` : "Ended";
  return rule.cancelled_by ? `Cancelled by ${rule.cancelled_by.label}` : "Cancelled";
}

function release(ruleId: string): void {
  const held = cancelled.get(ruleId);
  if (held) clearTimeout(held.timer);
  cancelled.delete(ruleId);
}

async function cancel(rule: WakeRule): Promise<void> {
  if (!props.api || busy.has(rule.id)) return;
  const hadFocus = rowHasFocus(rule.id);
  busy.add(rule.id);
  errors.delete(rule.id);
  cancelled.set(rule.id, { rule, timer: setTimeout(() => release(rule.id), UNDO_WINDOW_MS) });
  try {
    await props.api.cancel(props.roomId, rule.id);
  } catch (error) {
    release(rule.id);
    errors.set(rule.id, error instanceof Error ? error.message : "Couldn't cancel this wake rule. Try again.");
  } finally {
    busy.delete(rule.id);
  }
  // Undo (or Cancel again, if cancelling failed) is enabled only now.
  await keepFocusOnRow(rule.id, hadFocus);
}

async function undo(rule: WakeRule): Promise<void> {
  if (!props.api || busy.has(rule.id)) return;
  const hadFocus = rowHasFocus(rule.id);
  busy.add(rule.id);
  try {
    restored.set(rule.id, await props.api.restore(props.roomId, rule.id));
    release(rule.id);
  } catch (error) {
    errors.set(rule.id, error instanceof Error ? error.message : "Couldn't restore this wake rule.");
  } finally {
    busy.delete(rule.id);
  }
  await keepFocusOnRow(rule.id, hadFocus);
}

let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  tick = setInterval(() => { now.value = new Date(); }, 30_000);
});
onBeforeUnmount(() => {
  clearInterval(tick);
  for (const ruleId of [...cancelled.keys()]) release(ruleId);
});
</script>

<style src="./wake-rules.css"></style>
