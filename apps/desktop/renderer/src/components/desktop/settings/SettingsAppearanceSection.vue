<template>
  <section class="appearance-settings" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading">Appearance</h2>
    <p>On this device.</p>
    <div class="appearance-row">
      <div>
        <h3>Mode</h3>
        <span>{{ modeNote }}</span>
      </div>
      <DesktopSegmentedControl
        label="Light or dark mode"
        sliding
        :model-value="colorMode"
        :options="modeOptions"
        @update:model-value="setColorMode($event as AppColorMode)"
      />
    </div>
    <div class="appearance-row">
      <div>
        <h3>Background</h3>
        <span>Textured adds the fine film grain from the welcome screens behind everything.</span>
      </div>
      <DesktopSegmentedControl
        label="Background texture"
        sliding
        :model-value="texture"
        :options="textureOptions"
        @update:model-value="setTexture($event as AppBackgroundTexture)"
      />
    </div>
    <p v-if="!saved" role="status">This applies now, but it couldn’t be saved on this device.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import DesktopSegmentedControl from "../controls/DesktopSegmentedControl.vue";
import { useAppAppearance, type AppBackgroundTexture, type AppColorMode } from "../../../composables/useAppAppearance";

const { colorMode, texture, resolvedMode, saved, setColorMode, setTexture } = useAppAppearance();
const modeOptions = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;
const textureOptions = [
  { id: "textured", label: "Textured" },
  { id: "plain", label: "Plain" },
] as const;
const modeNote = computed(() => colorMode.value === "system"
  ? `Follows your computer. Now ${resolvedMode.value}.`
  : `Always ${colorMode.value}.`);
</script>

<style scoped>
.appearance-settings { max-width: 760px; margin-block-end: 26px; padding-block-end: 22px; border-bottom: 1px solid var(--border); }
.appearance-settings h2 { margin: 0; font-size: 17px; font-weight: 600; }
.appearance-settings > p { margin: 8px 0 10px; color: var(--text-secondary); font-size: 13px; line-height: 1.45; }
.appearance-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 0; }
.appearance-row h3 { margin: 0 0 3px; font-size: 13px; font-weight: 500; }
.appearance-row span { color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
</style>
