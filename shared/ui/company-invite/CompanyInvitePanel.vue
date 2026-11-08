<template>
  <div class="company-invite-panel" :class="{ 'is-result': view.kind === 'joined' && view.justJoined }" :aria-busy="Boolean(busy)">
    <template v-if="view.kind === 'joined' && view.justJoined">
      <div class="invite-done" role="status">
        <span class="invite-done-ring">
          <span class="invite-avatar" data-size="l"><img v-if="view.organization.avatar_url" :src="view.organization.avatar_url" alt="" referrerpolicy="no-referrer"><span v-else>{{ initial(view.organization.login) }}</span></span>
          <span class="invite-done-ok" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
        </span>
        <h2 :id="headingId" tabindex="-1">You’re in {{ view.organization.login }}</h2>
        <p>{{ roomCountText(view.roomCount, view.organization.login) }}</p>
      </div>
    </template>

    <template v-else>
      <header class="invite-head">
        <div class="invite-heading"><h2 :id="headingId" tabindex="-1">{{ title }}</h2><slot name="close" /></div>
        <div v-if="organization" class="invite-org">
          <span class="invite-avatar" data-size="l"><img v-if="organization.avatar_url" :src="organization.avatar_url" alt="" referrerpolicy="no-referrer"><span v-else>{{ initial(organization.login) }}</span></span>
          <span><strong>{{ organization.login }}</strong><small>github.com/{{ organization.login }} · company on LetAgents</small></span>
        </div>
      </header>

      <div class="invite-body" :role="view.kind === 'unavailable' ? 'alert' : undefined">
        <p v-if="view.kind === 'loading'" class="invite-state" role="status">Checking your GitHub access…</p>
        <div v-if="alert" class="invite-alert" :data-tone="alert.tone">
          <svg v-if="alert.tone === 'warn'" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3zM12 10v4M12 17v.1" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.1" /></svg>
          <span><b v-if="alert.lead">{{ alert.lead }}</b> {{ alert.text }}</span>
        </div>
        <ul v-if="showFacts && organization" class="invite-facts">
          <li>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-6 8 6v8H4z" /></svg>
            <span><b>{{ organization.login }}’s rooms</b> appear in your Rooms list, including repo rooms you haven’t opened yet.</span>
          </li>
          <li>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></svg>
            <span><b>GitHub still decides access.</b> You see only repos where you have a role. The link itself grants nothing.</span>
          </li>
        </ul>
        <p v-if="error" class="invite-error" role="alert">{{ error }}</p>
      </div>
    </template>

    <footer class="invite-foot">
      <slot name="footer" :actions="actions">
        <span class="invite-note">{{ showFacts ? "From a company link" : "" }}</span>
        <button
          v-for="action in actions"
          :key="action.id"
          type="button"
          :class="action.primary ? 'invite-primary' : 'invite-secondary'"
          :disabled="Boolean(busy) && action.id !== 'close'"
          :data-testid="`company-invite-${action.id}`"
          @click="emit('action', action.id)"
        >
          {{ busy && action.primary ? busyLabel : action.label }}
        </button>
      </slot>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { CompanyInviteAction, CompanyInviteOrganization, CompanyInviteView } from "./types";
import "./company-invite.css";

const props = withDefaults(defineProps<{
  view: CompanyInviteView;
  headingId?: string;
  busy?: boolean;
  error?: string | null;
  /** Leave out the "Close" style buttons where the page has no dialog to close (the web page). */
  standalone?: boolean;
  /** The web page names the signed-in GitHub account, so a person with two accounts sees which one GitHub checked. */
  viewerLogin?: string | null;
}>(), { headingId: "company-invite-title", busy: false, error: null, standalone: false, viewerLogin: null });

const emit = defineEmits<{ action: [id: CompanyInviteAction] }>();

const organization = computed<CompanyInviteOrganization | null>(() => {
  const view = props.view;
  return "organization" in view ? view.organization : null;
});

const showFacts = computed(() => props.view.kind === "join" || props.view.kind === "setup");

const title = computed(() => {
  const view = props.view;
  const name = organization.value?.login;
  switch (view.kind) {
    case "setup": return `Set up ${name}`;
    case "joined": return `You’re in ${name}`;
    case "invited": return `Accept ${name} on GitHub`;
    case "sso": return name ? `Authorize ${name}` : "Authorize your company";
    case "github_access_required": return view.reason === "signin" ? "Reconnect GitHub" : "Let LetAgents see your organizations";
    case "unavailable": return "GitHub didn’t answer";
    case "invalid": return "This link isn’t valid";
    case "signed_out": return "You’re invited to a company";
    case "loading": return "Company link";
    default: return name ? `Join ${name}` : "Join your company";
  }
});

const alert = computed<{ tone: "info" | "warn"; lead?: string; text: string } | null>(() => {
  const view = props.view;
  const name = organization.value?.login;
  const viewer = props.viewerLogin ? `Signed in as @${props.viewerLogin}.` : null;
  switch (view.kind) {
    case "join":
      return viewer ? { tone: "info", lead: viewer, text: `GitHub confirms you’re a member of ${name}.` } : null;
    case "setup":
      return { tone: "info", lead: viewer ?? undefined, text: `You’re an owner of ${name} on GitHub, and nobody has set it up in LetAgents yet. Setting it up lets its members join.` };
    case "waiting":
      return { tone: "warn", lead: `An owner of ${name} needs to set it up first.`, text: "Ask whoever sent the link to open it in LetAgents." };
    case "invited":
      return { tone: "warn", lead: `${name} invited you on GitHub.`, text: "Accept the invitation there first, then open this link again." };
    case "sso":
      return { tone: "warn", lead: `${name ?? "This company"} uses single sign-on.`, text: "Authorize LetAgents for it on GitHub, then open this link again." };
    case "github_access_required":
      return view.reason === "signin"
        ? { tone: "warn", text: "GitHub no longer accepts this sign-in. Connect again on GitHub, then open this link again." }
        : { tone: "info", text: "GitHub asks you once. LetAgents reads which organizations you belong to, and it changes nothing on GitHub." };
    case "not_member":
      return {
        tone: "warn",
        lead: `${view.viewerLogin ? `@${view.viewerLogin}` : "This GitHub account"} isn’t a member of this company on GitHub.`,
        text: "Ask a company owner to add you, or sign in with the GitHub account they added. If you work on some of its repos as an outside collaborator, those rooms still open from All rooms.",
      };
    case "unavailable":
      return { tone: "warn", text: "LetAgents couldn’t check your GitHub organizations just now. Your rooms still work. Try again in a moment." };
    case "invalid":
      return { tone: "warn", text: "Ask whoever sent it for a new company link." };
    case "signed_out":
      return { tone: "info", text: "Open the link in the LetAgents app, or sign in here. GitHub decides whether you can join." };
    case "joined":
      return { tone: "info", text: roomCountText(view.roomCount, name ?? "the company") };
    default:
      return null;
  }
});

const actions = computed<Array<{ id: CompanyInviteAction; label: string; primary: boolean }>>(() => {
  const view = props.view;
  const name = organization.value?.login ?? "";
  const close = props.standalone ? [] : [{ id: "close" as const, label: "Not now", primary: false }];
  const ok = props.standalone ? [] : [{ id: "close" as const, label: "OK", primary: true }];
  switch (view.kind) {
    case "join": return [...close, { id: "join", label: `Join ${name}`, primary: true }];
    case "setup": return [...close, { id: "setup", label: `Set up ${name}`, primary: true }];
    case "joined": return [{ id: "show_rooms", label: `Show ${name} rooms`, primary: true }];
    case "invited": return [...close, { id: "open_invitation", label: "Accept on GitHub", primary: true }];
    case "sso": return [...close, { id: "authorize_sso", label: "Authorize on GitHub", primary: true }];
    case "github_access_required":
      return [...close, { id: "allow", label: view.reason === "signin" ? "Reconnect on GitHub" : "Allow on GitHub", primary: true }];
    case "not_member": return ok;
    case "unavailable": return [...close, { id: "retry", label: "Try again", primary: true }];
    case "signed_out": return [{ id: "sign_in", label: "Sign in with GitHub", primary: true }];
    case "waiting":
    case "invalid":
      return ok;
    default:
      return [];
  }
});

const busyLabel = computed(() => props.view.kind === "setup" ? "Setting up…" : "Joining…");

function initial(login: string): string {
  return (login.trim()[0] || "?").toUpperCase();
}

function roomCountText(count: number | null, name: string): string {
  if (count === null) return `${name}’s rooms are now in your Rooms list.`;
  if (count === 0) return `${name} has no rooms you can open yet. They appear in your Rooms list when an owner connects a repo.`;
  return `${count} ${count === 1 ? "room is" : "rooms are"} now in your Rooms list.`;
}
</script>
