<template>
  <section class="room-activity" aria-label="Activity">
    <header class="activity-heading"><h2>Activity</h2><button type="button" class="activity-quiet" :disabled="loading" @click="emit('refresh')">Refresh</button></header>
    <div class="activity-toolbar">
      <div class="activity-filters" role="group" aria-label="Filter activity">
        <button v-for="option in filters" :key="option.id" type="button" :aria-pressed="filter === option.id" @click="filter = option.id">{{ option.label }}</button>
      </div>
      <label class="activity-search"><span class="activity-sr">Find in activity</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input v-model="query" type="search" placeholder="Find in activity…" /></label>
    </div>
    <slot name="notice" />
    <div class="activity-feed-heading"><span>Latest changes</span><button v-if="pending.length" type="button" @click="showUpdates">Show {{ pending.length }} update{{ pending.length === 1 ? '' : 's' }} ↑</button></div>
    <div v-if="error" class="activity-notice" role="alert"><span>{{ error }}</span><button type="button" @click="emit('refresh')">Retry</button></div>
    <div v-if="loading && !groups.length" class="activity-empty" role="status">Loading activity…</div>
    <div v-else-if="!available && !groups.length" class="activity-empty"><h3>No activity connection yet</h3><p>Connect a GitHub repository to see pull requests, reviews and CI here.</p><slot name="setup" /></div>
    <div v-else-if="!visible.length && !error" class="activity-empty"><h3>{{ groups.length ? 'No matching activity' : 'Nothing here yet' }}</h3><p>{{ groups.length ? 'Try another view or search.' : 'Pull requests, reviews and CI will appear as updates arrive.' }}</p></div>
    <article v-for="group in visible" :key="group.id" class="activity-item" :data-activity-id="group.id" :data-open="opened.has(group.id)" :data-instant="instant">
      <button type="button" class="activity-row" :aria-expanded="opened.has(group.id)" :aria-controls="detailId(group.id)" @click="toggle(group.id, $event)">
        <svg class="activity-mark" :data-tone="group.tone" viewBox="0 0 24 24" fill="none" aria-hidden="true"><template v-if="group.attention"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4v.1"/></template><template v-else-if="group.kind === 'pr'"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10m12 0V9a4 4 0 0 0-4-4h-2m2-3-3 3 3 3"/></template><template v-else><path d="M3 7h11M3 12h18M3 17h14"/></template></svg>
        <span class="activity-copy"><strong>{{ group.title }}</strong><span class="activity-meta">{{ group.actor }}<span v-if="group.number"> · #{{ group.number }}</span></span><span class="activity-summary">{{ group.summary }}</span></span>
        <span class="activity-status" :data-tone="group.tone">{{ group.status }}</span>
        <time :datetime="group.time" :title="activityTime(group.time)">{{ compactTime(group.time) }}</time>
        <svg class="activity-caret" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
      </button>
      <div :id="detailId(group.id)" class="activity-disclosure" :inert="!opened.has(group.id)" :aria-hidden="!opened.has(group.id)">
        <div class="activity-clip"><div v-if="visited.has(group.id)" class="activity-detail">
          <div class="activity-detail-scroll" tabindex="0" :aria-label="`${group.title} updates`">
            <section v-if="group.reviews.length" class="activity-reviews" aria-label="Reviews">
              <h3>Reviews <small>Comments recorded in this room</small></h3>
              <ul><li v-for="review in orderedDetails(group.id, group.reviews)" :key="review.id" :data-review-id="review.id">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v12H9l-5 4Z"/></svg>
                <div class="activity-review-copy"><strong>{{ review.actor }}</strong><span>{{ review.comments }} comment{{ review.comments === 1 ? '' : 's' }}<template v-if="review.resolved"> · {{ review.resolved }} discussion{{ review.resolved === 1 ? '' : 's' }} resolved</template><template v-if="review.unresolved"> · {{ review.unresolved }} reopened</template></span><small>{{ review.update }}</small></div>
                <div class="activity-review-state"><span :data-tone="review.verdict === 'Approved' ? 'green' : review.verdict === 'Changes requested' ? 'red' : 'muted'">{{ review.verdict }}</span><small v-if="group.head && review.commit && review.commit !== group.head">Earlier commit</small><time :datetime="review.time" :title="activityTime(review.time)">{{ compactTime(review.time) }}</time></div>
              </li></ul>
            </section>
            <section v-if="group.runs.length" aria-label="CI runs" class="activity-ci">
              <h3>CI <select :value="selectedRun(group)?.id" aria-label="Workflow run and attempt" @change="chooseRun(group.id, $event)"><option v-for="run in group.runs" :key="run.id" :value="run.id">{{ run.name }} · #{{ run.runId }} · {{ run.attempt ? `Attempt ${run.attempt}` : 'Attempt unknown' }}</option></select></h3>
              <template v-if="selectedRun(group)">
                <div class="activity-run"><a v-if="selectedRun(group)!.url" :href="selectedRun(group)!.url!" target="_blank" rel="noopener noreferrer">{{ selectedRun(group)!.name }} ↗</a><span>{{ selectedRun(group)!.state }}</span><code v-if="selectedRun(group)!.sha">{{ selectedRun(group)!.sha!.slice(0, 7) }}<template v-if="group.head && selectedRun(group)!.sha !== group.head"> · Earlier commit</template></code></div>
                <ul class="activity-jobs"><li v-for="job in orderedDetails(selectedRun(group)!.id, selectedRun(group)!.jobs)" :key="job.id" :data-job-id="job.id" :data-state="job.state">
                  <svg class="activity-job-mark" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path v-if="job.state === 'Passed'" d="m4 10 4 4 8-8"/><path v-else-if="['Failed', 'Timed out'].includes(job.state)" d="m5 5 10 10M15 5 5 15"/><circle v-else cx="10" cy="10" r="7"/></svg>
                  <div><a v-if="job.url" :href="job.url" target="_blank" rel="noopener noreferrer">{{ job.name }}</a><strong v-else>{{ job.name }}</strong><small>{{ job.state === 'Running' ? 'In progress' : job.state === 'Queued' ? 'Waiting for a runner' : 'Latest reported status' }}</small></div><span>{{ job.state }}</span><time>{{ job.duration }}</time>
                </li></ul>
                <p v-if="!selectedRun(group)!.jobs.length" class="activity-detail-note">Job updates will appear here when reported.</p>
              </template>
            </section>
            <section v-if="otherUpdates(group).length" class="activity-history" aria-label="Other updates"><h3>Updates</h3><ul><li v-for="event in otherUpdates(group)" :key="event.id"><span><strong>{{ event.actor_login || 'GitHub' }}</strong> · {{ event.event_type === 'issue_comment' ? 'commented' : event.action.replace(/_/g, ' ') }}<small v-if="event.event_type === 'check_run'">{{ event.title }} · {{ event.state?.replace(/_/g, ' ') }}</small></span><time :datetime="eventTime(event)" :title="activityTime(eventTime(event))">{{ compactTime(eventTime(event)) }}</time></li></ul></section>
          </div>
          <footer class="activity-detail-links"><a v-if="group.url" :href="group.url" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a><slot name="actions" :group="group" /><button v-for="task in group.taskIds" :key="task" type="button" @click="emit('openTask', task)">View {{ task }}</button></footer>
        </div></div>
      </div>
    </article>
    <footer v-if="groups.length || hasMore" class="activity-footer"><span>Recorded updates · {{ hasMore ? 'More history available' : 'End of recorded history' }}</span><button v-if="hasMore" type="button" :disabled="loadingOlder" @click="emit('loadOlder')">{{ loadingOlder ? 'Loading…' : 'Load earlier activity' }}</button></footer>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { activityKey, activityTime, eventTime, groupActivity, matchesActivity, type ActivityEvent, type ActivityFilter, type ActivityGroup } from './model';
const props = withDefaults(defineProps<{ events: readonly ActivityEvent[]; roomIdentifier?: string; loading?: boolean; loadingOlder?: boolean; available?: boolean; error?: string | null; hasMore?: boolean; selectedEventId?: string | null }>(), { available: true });
const emit = defineEmits<{ refresh: []; loadOlder: []; openTask: [id: string]; closeSelectedEvent: [] }>();
const filters: { id: ActivityFilter; label: string }[] = [{id:'all',label:'All activity'},{id:'review',label:'In Review'},{id:'attention',label:'Needs attention'},{id:'merged',label:'Merged'}];
const filter = ref<ActivityFilter>('all'); const query = ref(''); const instant = ref(false);
const opened = ref(new Set<string>()); const visited = ref(new Set<string>()); const order = ref<string[]>([]);
const detailOrder = new Map<string, string[]>();
const held = ref(new Set<string>()); const selections = ref<Record<string,string>>({});
const groups = computed(() => groupActivity(props.events));
const byId = computed(() => new Map(groups.value.map(group => [group.id, group])));
const pending = computed(() => groups.value.filter(group => !order.value.includes(group.id)));
const visible = computed(() => order.value.map(id => byId.value.get(id)).filter((group): group is ActivityGroup => Boolean(group && (held.value.has(group.id) || matchesActivity(group, filter.value, query.value)))));
const prefix = useId(); const detailId = (id: string) => `activity-${prefix}-${encodeURIComponent(id)}`;
watch(() => props.roomIdentifier, () => { detailOrder.clear(); order.value = []; opened.value = new Set(); visited.value = new Set(); held.value = new Set(); selections.value = {}; filter.value = 'all'; query.value = ''; }, {flush:'sync'});
watch(groups, next => {
  if (!order.value.length) order.value = next.map(group => group.id);
  else {
    const oldest = Math.min(...order.value.map(id => Date.parse(byId.value.get(id)?.time || '')).filter(Number.isFinite));
    const older = next.filter(group => !order.value.includes(group.id) && Date.parse(group.time) <= oldest);
    order.value = [...order.value.filter(id => byId.value.has(id)), ...older.map(group => group.id)];
  }
}, {immediate:true});
// Keep currently visible rows in place when an event changes their filter status.
// A deliberate filter/search change starts a fresh result set.
watch(visible, next => { for (const group of next) held.value.add(group.id); }, {immediate:true});
watch([filter, query], () => { held.value = new Set(); });
watch([() => props.selectedEventId, () => props.events], ([id]) => {
  if (!id) return; const event = props.events.find(item => item.id === id); if (!event) return;
  const key = activityKey(event); if (!order.value.includes(key)) order.value.unshift(key);
  opened.value.add(key); visited.value.add(key); held.value.add(key);
}, {immediate:true});
function showUpdates() { order.value = [...pending.value.map(group => group.id), ...order.value]; }
function toggle(id: string, event: MouseEvent) { instant.value = event.detail === 0; visited.value.add(id); if (opened.value.has(id)) { opened.value.delete(id); if (props.selectedEventId) emit('closeSelectedEvent'); } else opened.value.add(id); }
function orderedDetails<T extends { id: string }>(key: string, items: T[]): T[] {
  const previous = detailOrder.get(key) || [];
  const order = [...previous, ...items.filter(item => !previous.includes(item.id)).map(item => item.id)];
  detailOrder.set(key, order);
  const values = new Map(items.map(item => [item.id, item]));
  return order.map(id => values.get(id)).filter((item): item is T => Boolean(item));
}
function selectedRun(group: ActivityGroup) { return group.runs.find(run => run.id === selections.value[group.id]) || group.runs.slice(-1)[0]; }
function chooseRun(id: string, event: Event) { selections.value[id] = (event.target as HTMLSelectElement).value; }
function otherUpdates(group: ActivityGroup) { return group.events.filter(event => !event.event_type.startsWith('workflow_') && !event.event_type.startsWith('pull_request_review')).slice().reverse(); }
function compactTime(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, date.toDateString() === new Date().toDateString() ? {hour:'2-digit',minute:'2-digit',hour12:false} : {month:'short', day:'numeric'}).format(date) : ''; }
</script>
<style src="./activity.css"></style>
