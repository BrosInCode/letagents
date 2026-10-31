<template>
  <div class="agents-archive">
    <button
      type="button"
      class="agents-quiet agents-back"
      @click="emit('back', $event)"
    >
      ← Agents
    </button>
    <header class="agents-heading">
      <div>
        <h2 ref="heading" tabindex="-1">
          {{ mode === "past" ? "Past agents" : "Room history" }}
        </h2>
        <p v-if="mode === 'past'">Their work stays in the room.</p>
      </div>
      <button type="button" class="agents-quiet" @click="switchMode($event)">
        {{ mode === "past" ? "Room history" : "Past agents" }} →
      </button>
    </header>
    <div class="agents-tools">
      <input
        :value="query"
        type="search"
        class="agents-search"
        :aria-label="mode === 'past' ? 'Search past agents' : 'Search history'"
        placeholder="Agent, owner, or work"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      /><slot name="scope" />
    </div>
    <div
      v-if="mode === 'history'"
      class="agents-record-tabs"
      aria-label="History view"
    >
      <button
        v-for="tab in ['Work', 'Changes', 'People'] as const"
        :key="tab"
        type="button"
        :aria-pressed="recordTab === tab"
        @click="selectTab(tab, $event)"
      >
        {{ tab }}
      </button>
    </div>
    <div v-if="personFilter" class="agents-filter-note">
      {{ people.find((person) => person.id === personFilter)?.name }}
      <button class="agents-quiet" type="button" @click="personFilter = null">
        Show everyone
      </button>
    </div>
    <slot name="status" />
    <div ref="content" :aria-busy="loading">
      <slot
        v-if="mode === 'history' && recordTab === 'Changes'"
        name="changes"
        :query="query"
      />
      <template v-else-if="mode === 'past' || recordTab === 'People'">
        <div
          v-if="mode === 'past' && visiblePeople.length"
          class="agents-archive-columns"
          aria-hidden="true"
        >
          <span>Agent</span><span>Last work</span><span>Last seen</span>
        </div>
        <AgentDisclosure v-for="person in visiblePeople" :key="person.id">
          <template #summary
            ><span class="agents-person-summary" :data-past="mode === 'past'"
              ><span class="agents-identity"
                ><span class="agents-provider"
                  ><slot name="provider" :person="person">{{
                    person.name.slice(0, 1)
                  }}</slot></span
                ><span class="agents-copy"
                  ><strong>{{ person.name }}</strong
                  ><small>{{
                    [
                      person.kind === "human"
                        ? "Human"
                        : agentProviderLabel(person.provider),
                      person.owner,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  }}</small></span
                ></span
              ><span v-if="mode === 'past'" class="agents-last-work">{{
                workFor(person.id)[0]?.title || "No saved work"
              }}</span
              ><time :title="person.lastSeen || undefined">{{
                historyTime(person.lastSeen)
              }}</time></span
            ></template
          >
          <div class="agents-person-meta">
            <span
              >{{ person.room
              }}<template v-if="person.branch">
                · {{ person.branch }}</template
              ></span
            ><span v-if="person.firstSeen"
              >First seen {{ historyTime(person.firstSeen) }}</span
            >
            <button
              v-if="person.kind === 'human' && person.login"
              type="button"
              class="agents-quiet agents-person-more"
              :aria-label="`More about ${person.name}`"
              @click="openPerson(person, $event)"
            >
              …
            </button>
          </div>
          <h3 class="agents-detail-label">
            Saved work <span>{{ workFor(person.id).length }}</span>
          </h3>
          <AgentDisclosure v-for="record in workFor(person.id)" :key="record.id"
            ><template #summary
              ><span class="agents-record-summary"
                ><strong>{{ record.title }}</strong
                ><span>{{ record.state }}</span
                ><time>{{ historyTime(record.time) }}</time></span
              ></template
            >
            <p v-if="record.detail">{{ record.detail }}</p>
            <a
              v-for="link in record.links"
              :key="link.url"
              :href="link.url"
              target="_blank"
              rel="noopener noreferrer"
              >{{ link.label }} ↗</a
            ><slot name="work-detail" :record="record"
          /></AgentDisclosure>
          <p v-if="!workFor(person.id).length" class="agents-note">
            No work has been saved for this participant.
          </p>
          <button
            type="button"
            class="agents-quiet"
            @click="showRecords(person.id, $event)"
          >
            All room records →
          </button>
        </AgentDisclosure>
        <p v-if="!visiblePeople.length && !loading" class="agents-empty">
          {{
            mode === "past"
              ? "No past agents in this selection."
              : "No matching people."
          }}
        </p>
      </template>
      <template v-else>
        <section
          v-for="group in workGroups"
          :key="group.day"
          class="agents-record-day"
        >
          <h3>{{ group.day }}</h3>
          <AgentDisclosure v-for="record in group.records" :key="record.id"
            ><template #summary
              ><span class="agents-record-summary"
                ><span class="agents-copy"
                  ><strong>{{ record.title }}</strong
                  ><small>{{ record.byline }}</small></span
                ><span>{{ record.state }}</span
                ><time>{{ historyTime(record.time) }}</time></span
              ></template
            >
            <p v-if="record.detail">{{ record.detail }}</p>
            <a
              v-for="link in record.links"
              :key="link.url"
              :href="link.url"
              target="_blank"
              rel="noopener noreferrer"
              >{{ link.label }} ↗</a
            ><slot name="work-detail" :record="record"
          /></AgentDisclosure>
        </section>
        <p v-if="!workGroups.length && !loading" class="agents-empty">
          No matching work has been saved.
        </p>
      </template>
    </div>
    <footer class="agents-archive-footer"><slot name="footer" /></footer>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AgentDisclosure from "./AgentDisclosure.vue";
import {
  historyTime,
  agentProviderLabel,
  type AgentHistoryPerson,
  type AgentHistoryWork,
} from "./types";
const props = defineProps<{
  mode: "past" | "history";
  people: readonly AgentHistoryPerson[];
  work: readonly AgentHistoryWork[];
  query: string;
  loading?: boolean;
}>();
const emit = defineEmits<{
  "update:mode": [mode: "past" | "history"];
  "update:query": [query: string];
  back: [event: MouseEvent];
  "open-person": [
    target: { login: string; displayName: string; avatarUrl: string | null },
    event: MouseEvent,
  ];
}>();
const heading = ref<HTMLElement>();
const content = ref<HTMLElement>();
const recordTab = defineModel<"Work" | "Changes" | "People">("tab", {
  default: "Work",
});
const personFilter = ref<string | null>(null);
watch(recordTab, (tab) => {
  if (tab === "Changes") personFilter.value = null;
});
let animation: Animation | undefined;
function animate(event: MouseEvent) {
  animation?.cancel();
  if (
    event.detail &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    void nextTick(() => {
      animation = content.value?.animate([{ opacity: 0.3 }, { opacity: 1 }], {
        duration: 160,
        easing: "ease-out",
      });
    });
}
function selectTab(tab: "Work" | "Changes" | "People", event: MouseEvent) {
  recordTab.value = tab;
  if (tab === "Changes") personFilter.value = null;
  animate(event);
}
function switchMode(event: MouseEvent) {
  personFilter.value = null;
  emit("update:mode", props.mode === "past" ? "history" : "past");
  animate(event);
  void nextTick(() => heading.value?.focus({ preventScroll: true }));
}
function openPerson(person: AgentHistoryPerson, event: MouseEvent) {
  if (!person.login) return;
  emit("open-person", {
    login: person.login,
    displayName: person.name,
    avatarUrl: person.avatarUrl ?? null,
  }, event);
}

function showRecords(id: string, event: MouseEvent) {
  personFilter.value = id;
  recordTab.value = "Work";
  emit("update:mode", "history");
  animate(event);
  void nextTick(() => heading.value?.focus({ preventScroll: true }));
}
onBeforeUnmount(() => animation?.cancel());
watch(
  () => props.people,
  (people) => {
    if (
      !props.loading &&
      personFilter.value &&
      !people.some((person) => person.id === personFilter.value)
    )
      personFilter.value = null;
  },
);
const matches = (text: string) =>
  text.toLowerCase().includes(props.query.trim().toLowerCase());
const workFor = (id: string) =>
  props.work.filter((record) => record.people.includes(id));
const visiblePeople = computed(() =>
  props.people
    .filter(
      (person) =>
        (props.mode !== "past" || (person.kind === "agent" && person.past)) &&
        (!personFilter.value || person.id === personFilter.value) &&
        matches(
          [
            person.name,
            person.owner,
            person.provider,
            person.branch,
            ...workFor(person.id).map((work) => `${work.id} ${work.title}`),
          ].join(" "),
        ),
    )
    .slice()
    .sort(
      (a, b) =>
        (Date.parse(b.lastSeen || "") || 0) -
        (Date.parse(a.lastSeen || "") || 0),
    ),
);
const workGroups = computed(() => {
  const groups = new Map<string, AgentHistoryWork[]>();
  for (const record of props.work) {
    if (personFilter.value && !record.people.includes(personFilter.value))
      continue;
    const contributors = props.people.filter((person) =>
      record.people.includes(person.id),
    );
    const participantText = contributors
      .map((person) =>
        [person.name, person.owner, person.provider, person.branch].join(" "),
      )
      .join(" ");
    if (
      !matches(
        `${record.id} ${record.title} ${record.byline} ${record.state} ${participantText}`,
      )
    )
      continue;
    const day = record.time
      ? new Date(record.time).toLocaleDateString(undefined, {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : "Date not recorded";
    const records = groups.get(day) || [];
    records.push(record);
    groups.set(day, records);
  }
  return [...groups].map(([day, records]) => ({ day, records }));
});
</script>
<style src="./agents.css"></style>
