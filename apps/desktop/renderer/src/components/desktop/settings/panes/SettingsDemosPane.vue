<template>
  <section class="settings-panel settings-demos-panel" data-testid="settings-demos-panel" :data-cdn="!settings ? 'unknown' : shownOn ? 'on' : 'off'">
    <div class="settings-control-list">
      <SettingsRow
        class="settings-demos-cdn-row"
        title="Load libraries from public CDNs"
        description="Demos may load scripts, styles, fonts and images from these sites, as charts, React apps and web fonts need. Each site sees your IP address and which file a demo asks for."
        description-id="settings-demos-cdn-description"
      >
        <ul class="settings-demos-hosts" aria-label="Allowed sites">
          <li v-for="host in hostChips" :key="host.label" :title="host.title"><span>{{ host.label }}</span></li>
        </ul>
        <!-- Every line stays in one cell, so a change never moves the layout; screen readers hear the line below instead. -->
        <div class="settings-demos-state" aria-hidden="true">
          <p :data-shown="state === 'on'">{{ LINES.on }}</p>
          <p :data-shown="state === 'off'">{{ LINES.off }}</p>
          <p :data-shown="state === 'error'" data-tone="error">{{ errorText }}</p>
        </div>
        <p class="sr-only" role="status">{{ announcement }}</p>
        <template #action>
          <DesktopSwitch
            :checked="shownOn"
            label="Load libraries from public CDNs"
            describedby="settings-demos-cdn-description"
            :busy="busy || !settings"
            :disabled="unavailable"
            test-id="settings-demos-cdn-switch"
            @toggle="toggle"
          />
        </template>
      </SettingsRow>

      <SettingsRow title="Always blocked" description="A demo can ask these sites for files, but it cannot connect to any server. The sites still see which files it asks for.">
        <ul class="settings-demos-blocked">
          <li><Globe aria-hidden="true" />Every other website</li>
          <li><ArrowLeftRight aria-hidden="true" />fetch, XMLHttpRequest and WebSockets</li>
          <li><KeyRound aria-hidden="true" />Your LetAgents sign-in and files</li>
          <li><MicOff aria-hidden="true" />Camera, microphone and location</li>
          <li><AppWindow aria-hidden="true" />Pop-ups, forms and downloads</li>
          <li><MessageSquareOff aria-hidden="true" />Dialogs and printing</li>
        </ul>
      </SettingsRow>
    </div>
  </section>
</template>

<script setup lang="ts">
import { AppWindow, ArrowLeftRight, Globe, KeyRound, MessageSquareOff, MicOff } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import type { DesktopDemoSettings } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import SettingsRow from "../SettingsRow.vue";

const LINES = {
  on: "On. Demos you open load their libraries. A demo already open keeps what it has.",
  off: "Off. Demos load nothing from the internet; a demo already open keeps what it has but loads nothing more. A demo that needs a library may show empty parts.",
};

/** What main last said; null until it answers. */
const settings = ref<DesktopDemoSettings | null>(null);
/** What the switch shows: the new value while a change saves, then what main saved. */
const shownOn = ref(false);
const busy = ref(false);
const unavailable = ref(false);
const state = ref<"loading" | "on" | "off" | "error">("loading");
const errorText = ref("");
/** What screen readers hear: empty while a change saves, so the same result twice is heard twice. */
const announcement = ref("");

/**
 * One chip per CDN; Google's two font hosts are one chip, named in its
 * tooltip. Main's list (HTML_DEMO_CDN_HOSTS) wins; this copy only fills the
 * row until main answers, so the layout does not jump.
 */
const hostChips = computed(() => {
  const hosts = settings.value?.cdnHosts ?? ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];
  const fonts = hosts.filter((host) => host.startsWith("fonts."));
  return [
    ...hosts.filter((host) => !host.startsWith("fonts.")).map((host) => ({ label: host, title: undefined as string | undefined })),
    ...(fonts.length ? [{ label: "Google Fonts", title: fonts.join(" and ") }] : []),
  ];
});

onMounted(async () => {
  const bridge = desktopIpc.demos;
  if (!bridge?.getSettings) {
    showError("Restart LetAgents to change demo settings.");
    unavailable.value = true;
    return;
  }
  try {
    apply(await bridge.getSettings());
  } catch {
    showError("Demo settings could not be read. Restart LetAgents and try again.");
    unavailable.value = true;
  }
});

function showError(text: string): void {
  errorText.value = text;
  state.value = "error";
  announcement.value = text;
}

function apply(next: DesktopDemoSettings): void {
  settings.value = next;
  shownOn.value = next.cdnLibraries;
  state.value = next.cdnLibraries ? "on" : "off";
}

async function toggle(): Promise<void> {
  const bridge = desktopIpc.demos;
  if (!settings.value || busy.value || !bridge) return;
  const saved = settings.value.cdnLibraries;
  // The switch and its line answer at once; the save follows.
  shownOn.value = !saved;
  state.value = saved ? "off" : "on";
  announcement.value = "";
  busy.value = true;
  try {
    apply(await bridge.setCdnLibraries(!saved));
    announcement.value = saved ? LINES.off : LINES.on;
  } catch {
    shownOn.value = saved;
    showError("The change was not saved. Demos still follow the switch as shown. Try again.");
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
/* A row taller than one line keeps its switch beside the title, not in the middle. */
.settings-demos-cdn-row :deep(.settings-control-action) {
  align-self: start;
  padding-top: 1px;
}

.settings-demos-hosts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.settings-demos-hosts li {
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--bg-card);
  box-shadow: inset 0 0 0 1px var(--border);
  color: var(--text);
  font: 500 11.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  transition: opacity 180ms ease;
}

/* Off: the sites are struck through, drawn left to right. */
.settings-demos-hosts li span {
  background: linear-gradient(currentColor, currentColor) no-repeat 0 55% / 0% 1px;
  transition: background-size 220ms cubic-bezier(0.23, 1, 0.32, 1);
}

[data-cdn="off"] .settings-demos-hosts li {
  opacity: 0.5;
}

[data-cdn="off"] .settings-demos-hosts li span {
  background-size: 100% 1px;
}

/* One cell holds every line, so a change never moves the layout; the old line leaves before the new one comes in. */
.settings-demos-state {
  display: grid;
  margin-top: 10px;
  color: var(--text-tertiary);
  font-size: 12.5px;
  line-height: 1.45;
}

.settings-demos-state > p {
  grid-area: 1 / 1;
  margin: 0;
  transition: opacity 90ms ease, transform 90ms ease;
}

.settings-demos-state > p[data-shown="true"] {
  transition:
    opacity 160ms cubic-bezier(0.23, 1, 0.32, 1) 90ms,
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1) 90ms;
}

.settings-demos-state > p[data-shown="false"] {
  opacity: 0;
  transform: translateY(3px);
  pointer-events: none;
  visibility: hidden;
  transition: opacity 90ms ease, transform 90ms ease, visibility 0s linear 90ms;
}

.settings-demos-state > p[data-tone="error"] {
  color: var(--red-text);
}

.settings-demos-blocked {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 18px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font-size: 12.5px;
}

.settings-demos-blocked li {
  display: flex;
  gap: 8px;
  align-items: center;
}

.settings-demos-blocked svg {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
}

@media (max-width: 720px) {
  .settings-demos-blocked {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-demos-state > p,
  .settings-demos-state > p[data-shown="true"] {
    transform: none;
    transition: opacity 120ms ease, visibility 0s;
  }

  .settings-demos-hosts li span {
    transition: none;
  }
}
</style>
