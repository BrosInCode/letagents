<template>
  <section class="company-home surface-page" data-testid="company-home" :data-state="state">
    <header class="company-home-head">
      <CompanyAvatar :login="name" :avatar-url="avatarUrl" size="xl" />
      <div><h1>{{ name }}</h1><p>github.com/{{ name }}</p></div>
    </header>
    <div v-if="state === 'choose'" class="company-home-rooms">
      <div class="company-home-list-heading"><span>Choose a room</span><span>{{ rooms.length }} rooms</span></div>
      <button v-for="room in rooms" :key="room.room_id" class="company-home-room" type="button" @click="$emit('open-room', room.room_id)">
        <BookMarked v-if="room.kind === 'repo'" aria-hidden="true" /><Hash v-else aria-hidden="true" />
        <span><strong>{{ room.full_name?.split('/')[1] || room.display_name }}</strong><small>{{ room.kind === 'repo' ? `${name} repository` : 'Shared room · By invitation' }}</small></span>
        <small v-if="room.visibility" class="company-home-visibility">{{ room.visibility === 'private' ? 'Private' : 'Public' }}</small><ChevronRight aria-hidden="true" />
      </button>
      <button class="ghost-button company-home-new" type="button" @click="$emit('new-room')"><Plus aria-hidden="true" />New room</button>
    </div>
    <div v-else class="company-home-body" :role="state === 'unavailable' ? 'alert' : 'status'">
      <span class="company-home-badge">
        <span v-if="state === 'github_access_required'" class="company-home-github" aria-hidden="true"><GitHubMark /></span>
        <CompanyAvatar v-else :login="name" :avatar-url="avatarUrl" size="xl" />
        <span v-if="state === 'unavailable' || state === 'sso_required'" class="company-home-warn" aria-hidden="true"><TriangleAlert /></span>
      </span>
      <h2>{{ copy.title }}</h2>
      <p>{{ copy.text }}</p>
      <div class="company-home-actions">
        <template v-if="state === 'github_access_required'">
          <button class="primary-button" type="button" data-testid="company-home-allow" @click="$emit('open-github', { kind: 'allow' })">
            {{ accessReason === "signin" ? "Reconnect on GitHub" : "Allow on GitHub" }}
          </button>
          <button class="ghost-button" type="button" @click="$emit('show-all')">Not now</button>
        </template>
        <template v-else-if="state === 'sso_required'">
          <button class="primary-button" type="button" data-testid="company-home-sso" @click="$emit('open-github', { kind: 'sso', login: name })">Authorize on GitHub</button>
          <button class="ghost-button" type="button" @click="$emit('retry')">Check again</button>
          <button class="ghost-button" type="button" @click="$emit('show-all')">Show all rooms</button>
        </template>
        <template v-else-if="state === 'unavailable'">
          <button class="primary-button" type="button" data-testid="company-home-retry" @click="$emit('retry')">Try again</button>
          <button class="ghost-button" type="button" @click="$emit('show-all')">Show all rooms</button>
        </template>
        <template v-else-if="state === 'empty'">
          <button class="primary-button" type="button" data-testid="company-home-new-room" @click="$emit('new-room')">New room</button>
          <button class="ghost-button" type="button" @click="$emit('show-all')">Show all rooms</button>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { BookMarked, ChevronRight, Hash, Plus, TriangleAlert } from "@lucide/vue";
import type { DesktopGitHubAccessReason, DesktopOrganizationGitHubPage, DesktopOrganizationRoom } from "../../../../../electron/ipc-types/organizations.js";
import CompanyAvatar from "../company/CompanyAvatar.vue";
import GitHubMark from "../company/GitHubMark.vue";
import type { CompanyHomeState } from "../company/types";

const props = defineProps<{
  name: string;
  avatarUrl: string | null;
  state: CompanyHomeState;
  rooms: DesktopOrganizationRoom[];
  accessReason: DesktopGitHubAccessReason | null;
}>();

defineEmits<{
  "new-room": [];
  "open-room": [roomId: string];
  "show-all": [];
  retry: [];
  "open-github": [page: DesktopOrganizationGitHubPage];
}>();

const copy = computed(() => {
  const name = props.name;
  switch (props.state) {
    case "empty":
      return {
        title: `No ${name} rooms yet`,
        text: `A repo appears here after a ${name} owner installs the LetAgents GitHub app on it, and you have a role on that repo. You can also start a ${name} room now.`,
      };
    case "loading":
      return { title: `Checking ${name} with GitHub…`, text: "Checking which company rooms you can open." };
    case "unavailable":
      return {
        title: `Couldn’t check ${name} with GitHub`,
        text: "GitHub didn’t answer, so LetAgents can’t show this company’s rooms right now. Your other rooms still work.",
      };
    case "github_access_required":
      return props.accessReason === "signin"
        ? { title: "Reconnect GitHub", text: "GitHub no longer accepts this sign-in. Connect again on GitHub, then return here." }
        : { title: "Allow LetAgents to see your organizations", text: "Your GitHub sign-in doesn’t include organization access yet. GitHub asks you once, and nothing changes on GitHub." };
    case "sso_required":
      return {
        title: `${name} uses single sign-on`,
        text: `GitHub shows ${name}’s repositories only after you authorize LetAgents for ${name}. Authorize it on GitHub, then check again.`,
      };
    default:
      return { title: `Choose a ${name} room`, text: "Pick a room in the sidebar to start working with your agents." };
  }
});
</script>

<style scoped>
.company-home { display: block; min-width: 0; min-height: 0; overflow-y: auto; padding: clamp(24px, 5vw, 64px); background: var(--bg); }
.company-home-head { display: flex; align-items: center; gap: 18px; max-width: 760px; margin: 0 auto 36px; }
.company-home-head h1 { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -.035em; }
.company-home-head p { margin: 6px 0 0; font-size: 14px; color: var(--text-secondary); }
.company-home-rooms { max-width: 760px; margin: auto; }
.company-home-list-heading { display: flex; justify-content: space-between; color: var(--text-tertiary); font-size: 13px; padding: 0 12px; margin-bottom: 14px; }
.company-home-room { display: flex; align-items: center; gap: 14px; width: 100%; padding: 16px 12px; min-height: 76px; border: 0; border-radius: 10px; color: var(--text); background: transparent; text-align: left; font: inherit; cursor: pointer; transition: background-color 150ms ease; }
.company-home-room > span { min-width: 0; flex: 1; }
.company-home-room strong { display: block; font-size: 15px; font-weight: 550; overflow-wrap: anywhere; }
.company-home-room small { display: block; margin-top: 4px; font-size: 13px; color: var(--text-secondary); }
.company-home-room svg, .company-home-new svg { width: 18px; height: 18px; flex: none; color: var(--text-secondary); }
.company-home-room:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: -2px; }
.company-home-new { margin-top: 20px; display: flex; align-items: center; gap: 8px; }
.company-home-body { display: grid; justify-items: start; max-width: 760px; margin: auto; padding: 24px 12px; }
.company-home-body .company-home-badge { display: none; }
@media (hover: hover) { .company-home-room:hover { background: var(--accent-hover); } }
@media (max-width: 480px) { .company-home-room .company-home-visibility { display: none; } }
@media (prefers-reduced-motion: reduce) { .company-home-room { transition: none; } }

.company-home-badge {
  position: relative;
}

.company-home-github {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--bg-card);
  color: var(--text);
}

.company-home-github svg {
  width: 24px;
  height: 24px;
}

.company-home-warn {
  position: absolute;
  right: -5px;
  bottom: -5px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bg);
  color: var(--amber, #f59e0b);
}

.company-home-warn svg {
  width: 15px;
  height: 15px;
}

.company-home-body h2 {
  margin: 18px 0 0;
  font-size: 22px;
  letter-spacing: -0.025em;
}

.company-home-body p {
  max-width: 430px;
  margin: 8px 0 0;
  color: var(--text-secondary);
  line-height: 1.55;
}

.company-home-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 20px;
}

.company-home-actions:empty {
  display: none;
}
</style>
