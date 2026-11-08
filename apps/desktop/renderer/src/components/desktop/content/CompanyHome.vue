<template>
  <section class="company-home surface-page" data-testid="company-home" :data-state="state">
    <header class="company-home-head">
      <CompanyAvatar :login="name" :avatar-url="avatarUrl" size="m" />
      <strong>{{ name }}</strong>
      <small>Company</small>
    </header>

    <div class="company-home-body" :role="state === 'unavailable' ? 'alert' : 'status'">
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
import { TriangleAlert } from "@lucide/vue";
import type { DesktopGitHubAccessReason, DesktopOrganizationGitHubPage } from "../../../../../electron/ipc-types/organizations.js";
import CompanyAvatar from "../company/CompanyAvatar.vue";
import GitHubMark from "../company/GitHubMark.vue";
import type { CompanyHomeState } from "../company/types";

const props = defineProps<{
  name: string;
  avatarUrl: string | null;
  state: CompanyHomeState;
  accessReason: DesktopGitHubAccessReason | null;
}>();

defineEmits<{
  "new-room": [];
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
      return { title: `Checking ${name} with GitHub…`, text: "Your rooms appear in the sidebar when the check is done." };
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
.company-home {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.company-home-head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 54px;
  padding: 0 22px;
  border-bottom: 1px solid var(--border);
}

.company-home-head strong {
  font-size: 17px;
  letter-spacing: -0.02em;
}

.company-home-head small {
  color: var(--text-tertiary);
  font-size: 12px;
}

.company-home-body {
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 40px;
  text-align: center;
}

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
