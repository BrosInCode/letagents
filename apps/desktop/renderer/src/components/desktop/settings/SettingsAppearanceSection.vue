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
        <h3 id="texture-heading">Texture</h3>
        <span>The fine film grain from the welcome screens. It always sits under the text.</span>
      </div>
      <DesktopSegmentedControl
        label="Texture for every part"
        sliding
        :model-value="textureSummary"
        :options="textureSummaryOptions"
        @update:model-value="setAllTextured($event === 'all')"
      />
    </div>
    <ul class="appearance-surfaces" aria-labelledby="texture-heading">
      <li v-for="surface in TEXTURE_SURFACES" :key="surface.id" class="appearance-row">
        <div>
          <h4 :id="`texture-${surface.id}`">{{ surface.label }}</h4>
          <span>{{ surface.note }}</span>
        </div>
        <DesktopSwitch
          :checked="isTextured(surface.id)"
          :labelledby="`texture-${surface.id}`"
          @toggle="setTextured(surface.id, !isTextured(surface.id))"
        />
      </li>
    </ul>
    <p v-if="!saved" role="status">This applies now, but it couldn’t be saved on this device.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import DesktopSegmentedControl from "../controls/DesktopSegmentedControl.vue";
import DesktopSwitch from "../controls/DesktopSwitch.vue";
import { TEXTURE_SURFACES, useAppAppearance, type AppColorMode } from "../../../composables/useAppAppearance";

const {
  colorMode, resolvedMode, texturedSurfaces, saved,
  isTextured, setColorMode, setTextured, setAllTextured,
} = useAppAppearance();
const modeOptions = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;
// The quick choice for every part at once. With a mix, no option is lit.
const textureSummaryOptions = [
  { id: "all", label: "All" },
  { id: "none", label: "None" },
] as const;
const textureSummary = computed(() => {
  const count = texturedSurfaces.value.length;
  return count === TEXTURE_SURFACES.length ? "all" : count === 0 ? "none" : "mixed";
});
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
.appearance-surfaces { margin: 0 0 0 14px; padding: 0 0 0 14px; border-left: 1px solid var(--border); list-style: none; }
.appearance-surfaces .appearance-row { padding: 8px 0; }
.appearance-row h4 { margin: 0 0 2px; font-size: 13px; font-weight: 450; }
.appearance-row span { color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
</style>
