<template>
  <article class="onb-step company-step" data-testid="onboarding-company-step" :style="{ '--accent': accent }" :aria-busy="busy">
    <div class="onb-grain" :style="{ backgroundImage: grain }" aria-hidden="true" />
    <div class="onb-drag" aria-hidden="true" />
    <span class="onb-brand" data-morph="brand"><LetAgentsLogoMark aria-hidden="true" />LetAgents</span>

    <!-- A small live room in the chosen colour: the one thing worth looking at on this screen. -->
    <section class="company-stage" aria-hidden="true">
      <div class="preview" data-morph="rise">
        <aside class="preview-side">
          <i class="preview-org">
            <img v-if="current?.avatar_url" :src="current.avatar_url" alt="">
            <b v-else>{{ initials(current?.login ?? "") }}</b>
          </i>
          <span /><span class="on" /><span /><span />
        </aside>
        <div class="preview-room">
          <header><b /><i /></header>
          <div class="bubble them"><span /><span class="short" /></div>
          <div class="bubble you"><span /><span class="short" /></div>
          <div class="bubble them"><span class="short" /></div>
          <footer><span /><i /></footer>
        </div>
      </div>
    </section>

    <footer class="onb-bottom">
      <div class="onb-left">
        <h1 ref="headingEl" class="onb-heading" tabindex="-1" data-morph="heading">Make {{ current?.login }} yours.</h1>
        <!-- Only when the person owns more than one organization that is not set up yet. -->
        <div v-if="organizations.length > 1" class="orgs" role="radiogroup" aria-label="Organization" data-morph="rise">
          <button v-for="org in organizations" :key="org.github_org_id" type="button" class="org" role="radio"
            :aria-checked="org.github_org_id === current?.github_org_id" :disabled="busy" @click="emit('update:organizationId', org.github_org_id)">
            <img v-if="org.avatar_url" :src="org.avatar_url" alt="">
            <b v-else>{{ initials(org.login) }}</b>
            {{ org.login }}
          </button>
        </div>
        <div class="swatches" role="radiogroup" aria-label="Company colour" data-morph="rise">
          <button v-for="theme in themes" :key="theme.id" type="button" class="swatch" role="radio"
            :aria-checked="theme.id === themeId" :aria-label="theme.label" :title="theme.label" :disabled="busy"
            :style="{ '--swatch': theme.accent }" @click="emit('update:themeId', theme.id)">
            <Check v-if="theme.id === themeId" aria-hidden="true" />
          </button>
        </div>
        <p class="onb-note" data-morph="rise">Everyone who joins {{ current?.login }} starts with this. They can change it later.</p>
        <p v-if="error" class="onb-feedback" role="alert">{{ error }}</p>
      </div>
      <div class="onb-actions">
        <button type="button" class="onb-quiet" data-morph="rise" :disabled="busy" data-testid="onboarding-company-later" @click="emit('skip')">Later</button>
        <button type="button" class="onb-primary" data-morph="primary" :disabled="busy || !current" data-testid="onboarding-company-continue" @click="emit('continue')">
          <template v-if="busy"><LoaderCircle class="onb-spin" aria-hidden="true" /> Setting up {{ current?.login }}</template>
          <template v-else>{{ error ? "Try again" : "Continue" }} <ArrowRight aria-hidden="true" /></template>
        </button>
      </div>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowRight, Check, LoaderCircle } from "@lucide/vue";
import { roomThemePresets, type RoomThemeId } from "../../../../../../../shared/room-themes.mjs";
import type { DesktopOrganization } from "../../../../../electron/ipc-types/organizations";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
import { useFilmGrain } from "./useFilmGrain";
import "./onboarding-step.css";

const props = defineProps<{
  /** Organizations the person owns that are not set up in LetAgents yet. */
  organizations: DesktopOrganization[];
  organizationId: string | null;
  themeId: RoomThemeId;
  busy: boolean;
  error: string | null;
}>();
const emit = defineEmits<{
  "update:organizationId": [id: string];
  "update:themeId": [id: RoomThemeId];
  continue: [];
  skip: [];
}>();

const grain = useFilmGrain();
const headingEl = ref<HTMLElement | null>(null);
const current = computed(() => props.organizations.find(org => org.github_org_id === props.organizationId) ?? props.organizations[0] ?? null);
const initials = (login: string) => login.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();

// A short, considered set of the room themes; the full palette stays in Settings.
const picks: RoomThemeId[] = ["mint", "teal", "ice", "indigo", "violet", "rose", "coral", "amber", "stone"];
const themes = picks.map(id => roomThemePresets.find(theme => theme.id === id)).filter((theme): theme is NonNullable<typeof theme> => Boolean(theme));
const accent = computed(() => themes.find(theme => theme.id === props.themeId)?.accent ?? "#A8DEC7");

defineExpose({ focusHeading: () => headingEl.value?.focus({ preventScroll: true }) });
</script>

<style scoped>
.company-stage { display: grid; place-items: center; padding-top: 64px; }
.preview {
  display: grid; grid-template-columns: 64px 1fr; width: 380px; max-width: 100%; height: 228px; overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .07); border-radius: 16px; background: #0e100f;
  box-shadow: 0 30px 80px -40px color-mix(in srgb, var(--accent) 45%, transparent);
  transition: box-shadow 500ms ease;
}
.preview-side { display: grid; align-content: start; gap: 8px; padding: 12px 10px; border-right: 1px solid rgba(255, 255, 255, .05); background: rgba(255, 255, 255, .015); }
.preview-org { display: block; width: 26px; height: 26px; margin-bottom: 6px; overflow: hidden; border-radius: 8px; background: rgba(255, 255, 255, .08); }
.preview-org img { width: 100%; height: 100%; }
.preview-org b { display: grid; place-items: center; width: 100%; height: 100%; color: var(--accent); font: 700 10px/1 ui-sans-serif, system-ui, sans-serif; }
.preview-side span { height: 8px; border-radius: 4px; background: rgba(255, 255, 255, .07); }
.preview-side span.on { background: color-mix(in srgb, var(--accent) 55%, transparent); transition: background-color 400ms ease; }
.preview-room { display: grid; grid-template-rows: auto 1fr auto auto auto; gap: 10px; padding: 12px 14px; }
.preview-room header { display: flex; justify-content: space-between; align-items: center; }
.preview-room header b { width: 74px; height: 9px; border-radius: 5px; background: rgba(255, 255, 255, .16); }
.preview-room header i { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); transition: background-color 400ms ease; }
.bubble { display: grid; gap: 6px; width: 62%; padding: 9px 11px; border-radius: 4px 12px 12px 12px; background: rgba(255, 255, 255, .05); }
.bubble.you { justify-self: end; border-radius: 12px 4px 12px 12px; background: color-mix(in srgb, var(--accent) 22%, transparent); transition: background-color 400ms ease; }
.bubble span { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .16); }
.bubble span.short { width: 55%; }
.preview-room footer { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 6px 0 10px; border: 1px solid rgba(255, 255, 255, .07); border-radius: 9px; }
.preview-room footer span { flex: 1; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .08); }
.preview-room footer i { width: 16px; height: 16px; border-radius: 5px; background: var(--accent); transition: background-color 400ms ease; }

.orgs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.org {
  display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px 0 5px;
  border: 1px solid rgba(255, 255, 255, .08); border-radius: 999px; background: transparent;
  color: var(--ink-2); font: 500 13.5px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
  transition: background-color 160ms ease, border-color 200ms ease, color 160ms ease;
}
.org img, .org b { width: 24px; height: 24px; border-radius: 50%; }
.org b { display: grid; place-items: center; background: rgba(255, 255, 255, .08); color: var(--ink); font: 700 9.5px/1 ui-sans-serif, system-ui, sans-serif; }
.org:hover:not(:disabled) { background: rgba(255, 255, 255, .04); color: var(--ink); }
.org[aria-checked="true"] { border-color: color-mix(in srgb, var(--accent) 50%, transparent); color: var(--ink); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.org:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.swatches { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.swatch {
  display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%;
  background: var(--swatch); color: #0b0c0b; cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .25);
  transition: transform 180ms var(--ease), box-shadow 200ms ease;
}
.swatch svg { width: 14px; height: 14px; }
.swatch[aria-checked="true"] { box-shadow: 0 0 0 2px #0a0b0a, 0 0 0 3.5px var(--swatch); }
@media (hover: hover) and (pointer: fine) { .swatch:hover:not(:disabled) { transform: translateY(-2px); } }
.swatch:active { transform: scale(.92); }
.swatch:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; }
.onb-primary:focus-visible { outline-color: var(--accent); }
@media (prefers-reduced-motion: reduce) { .swatch, .preview, .preview * { transition: none !important; } }
@media (max-width: 740px) { .preview { width: 100%; } }
</style>
