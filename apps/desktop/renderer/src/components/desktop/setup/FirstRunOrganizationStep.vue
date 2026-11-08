<template>
  <section class="company-step" aria-label="Choose a company" :aria-busy="status === 'loading' || status === 'idle'">
    <template v-if="status === 'loading' || status === 'idle'">
      <div class="company-rows" aria-hidden="true">
        <div v-for="index in 3" :key="index" class="company-skeleton" />
      </div>
      <p class="company-help" role="status">Checking your GitHub organizations…</p>
    </template>

    <template v-else-if="status === 'github_access_required'">
      <div class="company-notice">
        <span class="company-notice-icon" aria-hidden="true"><GitHubMark /></span>
        <div>
          <h2>{{ accessReason === "signin" ? "Reconnect GitHub" : "Find your company on GitHub" }}</h2>
          <p v-if="accessReason === 'signin'">GitHub no longer accepts this sign-in. Connect again on GitHub, then return here.</p>
          <p v-else>Allow LetAgents to read your organization memberships and find the companies you can join.</p>
          <ul>
            <li><Eye aria-hidden="true" /><span>LetAgents reads which organizations you belong to and your role in each.</span></li>
            <li><ShieldCheck aria-hidden="true" /><span>It changes nothing on GitHub, and your repository access stays as it is.</span></li>
          </ul>
        </div>
      </div>
      <p class="company-help">You can skip this. All your rooms still work, and you can allow it later from the Rooms list.</p>
    </template>

    <template v-else-if="status === 'unavailable'">
      <div class="company-notice" data-tone="error" role="alert">
        <span class="company-notice-icon" aria-hidden="true"><TriangleAlert /></span>
        <div>
          <h2>GitHub is taking a moment</h2>
          <p>LetAgents couldn’t check your organizations just now. Your rooms still work. Try again, or continue and pick a company later from the Rooms list.</p>
          <button class="company-inline-button" type="button" @click="$emit('retry')">Try again</button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="company-rows" role="radiogroup" aria-label="Company" @keydown="moveSelection">
        <div
          v-for="row in rows"
          :key="row.key"
          :ref="(element) => setRowElement(row.key, element)"
          class="company-row"
          role="radio"
          :tabindex="row.key === focusKey ? 0 : -1"
          :aria-checked="pick === row.key"
          :aria-disabled="row.disabled || undefined"
          :data-testid="`company-choice-${row.key}`"
          @click="select(row)"
          @keydown.space.prevent="select(row)"
          @keydown.enter.prevent="select(row)"
        >
          <CompanyAvatar :all="row.key === 'all'" :login="row.name" :avatar-url="row.avatarUrl" />
          <span class="company-row-copy">
            <strong>{{ row.name }}</strong>
            <small>{{ row.detail }}</small>
          </span>
          <span v-if="row.tag" class="company-tag" :data-tone="row.tone">{{ row.tag }}</span>
          <span v-else />
          <span class="company-radio" aria-hidden="true" />
        </div>
      </div>

      <details v-if="githubSteps.length" class="company-github-steps">
        <summary>More from GitHub</summary>
        <div class="company-rows">
        <div v-for="step in githubSteps" :key="step.key" class="company-row" data-kind="github-step">
          <CompanyAvatar :login="step.name" :avatar-url="step.avatarUrl" />
          <span class="company-row-copy">
            <strong>{{ step.name }}</strong>
            <small>{{ step.detail }}</small>
          </span>
          <button class="company-inline-button" type="button" @click="$emit('open-github', step.page)">{{ step.action }}</button>
          <span />
        </div>
        </div>
      </details>

      <p v-if="invitedId && !invitedOrganization" class="company-help" role="alert">
        This GitHub account isn’t a member of the company in your link. Use the GitHub account your company added, or continue with all rooms.
      </p>
      <p v-if="error" class="company-help" data-tone="error" role="alert">{{ error }}</p>
      <p class="company-help">
        You can change this later.
        <button class="company-link-button" type="button" @click="$emit('open-github', { kind: 'allow' })">Company missing?</button>
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, type ComponentPublicInstance } from "vue";
import { Eye, ShieldCheck, TriangleAlert } from "@lucide/vue";
import type {
  DesktopGitHubAccessReason,
  DesktopOrganization,
  DesktopOrganizationGitHubPage,
  DesktopOrganizationInvitation,
  DesktopOrganizationSsoBlock,
} from "../../../../../electron/ipc-types/organizations.js";
import type { CompanyListStatus } from "../../../composables/useDesktopOrganizations";
import CompanyAvatar from "../company/CompanyAvatar.vue";
import GitHubMark from "../company/GitHubMark.vue";

const props = defineProps<{
  status: CompanyListStatus;
  accessReason: DesktopGitHubAccessReason | null;
  organizations: DesktopOrganization[];
  invitations: DesktopOrganizationInvitation[];
  ssoRequired: DesktopOrganizationSsoBlock[];
  error: string | null;
  /** The chosen row: "all" or an organization ID. */
  pick: string;
  invitedId?: string | null;
}>();

const emit = defineEmits<{
  "update:pick": [key: string];
  retry: [];
  "open-github": [page: DesktopOrganizationGitHubPage];
}>();

interface CompanyRow {
  key: string;
  name: string;
  detail: string;
  avatarUrl: string | null;
  tag: string;
  tone?: "accent";
  disabled: boolean;
}

const invitedOrganization = computed(() => props.invitedId
  ? props.organizations.find((org) => org.github_org_id === props.invitedId) ?? null
  : null);

const rows = computed<CompanyRow[]>(() => {
  const listed = props.invitedId ? (invitedOrganization.value ? [invitedOrganization.value] : []) : props.organizations;
  return [
    { key: "all", name: "All rooms", detail: "Everything you can access. No company filter.", avatarUrl: null, tag: "", disabled: false },
    ...listed.map((org): CompanyRow => {
      const role = org.role === "owner" ? "You’re an owner on GitHub" : "You’re a member on GitHub";
      if (org.joined) return { key: org.github_org_id, name: org.login, detail: `${role} · Joined`, avatarUrl: org.avatar_url, tag: "", disabled: false };
      if (org.setup) return { key: org.github_org_id, name: org.login, detail: role, avatarUrl: org.avatar_url, tag: "Join", disabled: false };
      if (org.role === "owner") return { key: org.github_org_id, name: org.login, detail: role, avatarUrl: org.avatar_url, tag: "Set up", tone: "accent", disabled: false };
      return { key: org.github_org_id, name: org.login, detail: "An owner needs to set this company up first", avatarUrl: org.avatar_url, tag: "Waiting", disabled: true };
    }),
  ];
});

const githubSteps = computed(() => [
  ...props.invitations.map((invite) => ({
    key: `invite-${invite.github_org_id}`,
    name: invite.login,
    avatarUrl: invite.avatar_url,
    detail: "Invited on GitHub · Accept the invitation there first",
    action: "Accept on GitHub",
    page: { kind: "invitation", login: invite.login } as DesktopOrganizationGitHubPage,
  })),
  ...props.ssoRequired.map((block) => ({
    key: `sso-${block.github_org_id}`,
    name: block.login ?? "An organization with single sign-on",
    avatarUrl: null,
    detail: "Uses single sign-on · Authorize LetAgents for it on GitHub",
    action: "Authorize",
    page: (block.login ? { kind: "sso", login: block.login } : { kind: "allow" }) as DesktopOrganizationGitHubPage,
  })),
]);

const enabledRows = computed(() => rows.value.filter((row) => !row.disabled));
const focusKey = computed(() => enabledRows.value.some((row) => row.key === props.pick) ? props.pick : "all");
const rowElements = new Map<string, HTMLElement>();

function setRowElement(key: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) rowElements.set(key, element);
  else rowElements.delete(key);
}

function select(row: CompanyRow): void {
  if (!row.disabled) emit("update:pick", row.key);
}

/** Arrow keys move the choice within the radio group, like native radio buttons. */
function moveSelection(event: KeyboardEvent): void {
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
    : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const options = enabledRows.value;
  const index = Math.max(0, options.findIndex((row) => row.key === focusKey.value));
  const next = options[(index + step + options.length) % options.length];
  emit("update:pick", next.key);
  void nextTick(() => rowElements.get(next.key)?.focus());
}
</script>

<style scoped>
.company-step {
  display: grid;
  gap: 14px;
  width: 100%;
  margin: 0 auto;
  text-align: left;
}

.company-rows {
  display: grid;
  gap: 10px;
}

.company-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto 18px;
  gap: 14px;
  align-items: center;
  min-height: 78px;
  padding: 16px;
  border: 1px solid var(--setup-border);
  border-radius: 12px;
  background: var(--setup-surface);
  color: var(--setup-text);
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    transform 140ms var(--first-run-motion-ease, cubic-bezier(0.23, 1, 0.32, 1));
}

.company-row[aria-checked="true"] {
  border-color: var(--setup-border-strong);
  background: var(--setup-surface-muted);
}

.company-row:active:not([aria-disabled="true"]):not([data-kind="github-step"]) {
  transform: scale(0.99);
}

.company-row[aria-disabled="true"],
.company-row[data-kind="github-step"] {
  cursor: default;
}

.company-row[aria-disabled="true"] .company-row-copy,
.company-row[aria-disabled="true"] .company-avatar {
  opacity: 0.5;
}

.company-row:focus-visible {
  outline: 2px solid var(--setup-accent);
  outline-offset: -2px;
}

.company-row-copy {
  min-width: 0;
}

.company-row-copy strong {
  display: block;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.company-row-copy small {
  display: block;
  margin-top: 2px;
  color: var(--setup-muted);
  font-size: 12.5px;
}

.company-tag {
  padding: 0;
  border: 0;
  color: var(--setup-muted-strong);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.company-tag[data-tone="accent"] {
  color: var(--setup-muted-strong);
}

.company-radio {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--setup-border-strong);
  border-radius: 50%;
  transition: border-color 150ms ease;
}

.company-radio::after {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--setup-text);
  content: "";
  transform: scale(0);
  transition: transform 160ms var(--first-run-motion-ease, cubic-bezier(0.23, 1, 0.32, 1));
}

.company-row[aria-checked="true"] .company-radio {
  border-color: var(--setup-text);
}

.company-row[aria-checked="true"] .company-radio::after {
  transform: scale(1);
}

.company-row[aria-disabled="true"] .company-radio {
  visibility: hidden;
}

.company-github-steps .company-row {
  grid-template-columns: auto minmax(0, 1fr) auto 0;
}

.company-help {
  margin: 0 2px;
  color: var(--setup-muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.company-help[data-tone="error"] {
  color: var(--setup-text);
}

.company-link-button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--setup-muted-strong);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.company-inline-button {
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--setup-border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--setup-text);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 140ms ease-out, background-color 150ms ease;
}

.company-inline-button:active {
  transform: scale(0.97);
}

.company-notice .company-inline-button {
  margin-top: 12px;
}

.company-skeleton {
  height: 62px;
  border: 1px solid var(--setup-border);
  border-radius: 14px;
  background: linear-gradient(90deg, var(--setup-surface) 0%, var(--setup-surface-muted) 50%, var(--setup-surface) 100%) 0 0 / 200% 100%;
  animation: company-shimmer 1.4s linear infinite;
}

@keyframes company-shimmer {
  to {
    background-position: -200% 0;
  }
}

.company-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--setup-border);
  border-radius: 16px;
  background: var(--setup-surface);
  color: var(--setup-text);
}

.company-notice h2 {
  margin: 0;
  font-size: 15.5px;
  letter-spacing: -0.01em;
}

.company-notice p {
  margin: 5px 0 0;
  color: var(--setup-muted-strong);
  font-size: 13.5px;
  line-height: 1.5;
}

.company-notice ul {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  color: var(--setup-muted-strong);
  font-size: 13px;
  list-style: none;
}

.company-notice li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.company-notice li svg {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  color: var(--setup-accent);
}

.company-notice-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--setup-border);
  border-radius: 12px;
  background: var(--setup-surface-muted);
}

.company-notice-icon svg {
  width: 22px;
  height: 22px;
}

.company-notice[data-tone="error"] .company-notice-icon {
  color: var(--red-text, #f87171);
}

@media (hover: hover) and (pointer: fine) {
  .company-row:not([aria-disabled="true"]):not([data-kind="github-step"]):hover {
    border-color: var(--setup-border-strong);
  }

  .company-inline-button:hover {
    background: var(--setup-surface-muted);
  }
}

@media (prefers-reduced-motion: reduce) {
  .company-skeleton {
    animation: none;
  }

  .company-row,
  .company-radio::after {
    transition: none;
  }
}
.company-github-steps summary { padding: 8px 0 12px; color: var(--setup-muted); cursor: pointer; font-size: 13px; }
.company-help .company-link-button { margin-left: 12px; }
@media (max-width: 480px) {
  .company-row { padding: 12px; gap: 10px; grid-template-columns: auto minmax(0, 1fr) 18px; }
  .company-row .company-tag, .company-row > span:empty { display: none; }
  .company-github-steps .company-row { grid-template-columns: auto minmax(0, 1fr); }
  .company-inline-button { grid-column: 2; justify-self: start; }
  .company-row-copy small { overflow-wrap: anywhere; }
}
</style>
