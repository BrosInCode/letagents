<template>
  <button
    class="desktop-switch"
    type="button"
    role="switch"
    :aria-checked="checked"
    :aria-label="label"
    :aria-labelledby="labelledby"
    :aria-describedby="describedby"
    :aria-disabled="busy || undefined"
    :disabled="disabled"
    :data-testid="testId"
    @click="toggle"
  >
    <span class="desktop-switch-track"><span class="desktop-switch-knob" /></span>
  </button>
</template>

<script setup lang="ts">
/**
 * The one switch in the app. It shows what the parent says, and asks the
 * parent to change it: the parent owns the value because saving it may fail.
 */
const props = defineProps<{
  checked: boolean;
  /** Name it by its visible title with `labelledby`, or with `label` when it has none. */
  label?: string;
  labelledby?: string;
  describedby?: string;
  /**
   * A change is being saved. The switch keeps focus and looks the same, but
   * does not answer, so a quick second click cannot race the first.
   */
  busy?: boolean;
  /** The switch can never be changed here, for example without permission. */
  disabled?: boolean;
  testId?: string;
}>();

const emit = defineEmits<{ toggle: [] }>();

function toggle(): void {
  if (props.busy || props.disabled) return;
  emit("toggle");
}
</script>

<style scoped>
/*
 * Drawn in ink, like the app's checkboxes: an outline when off, filled with
 * the text colour when on. Drawn at 32 by 18; the padding makes the target
 * 44 tall. While pressed the knob stretches toward the side it is about to
 * travel to, so the switch answers the press before it changes.
 */
.desktop-switch {
  --switch-width: 32px;
  --switch-height: 18px;
  --switch-inset: 3px;
  --switch-ease: cubic-bezier(0.23, 1, 0.32, 1);
  --knob: calc(var(--switch-height) - var(--switch-inset) * 2);
  --knob-pressed: calc(var(--knob) + 5px);
  --travel: calc(var(--switch-width) - var(--knob) - var(--switch-inset) * 2);
  position: relative;
  flex: 0 0 auto;
  margin: -13px -6px;
  padding: 13px 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}

.desktop-switch-track {
  position: relative;
  display: block;
  width: var(--switch-width);
  height: var(--switch-height);
  border-radius: 999px;
  background: var(--accent-dim);
  box-shadow: inset 0 0 0 1px var(--border-accent);
  transition:
    background-color 180ms ease,
    box-shadow 180ms ease;
}

.desktop-switch-knob {
  position: absolute;
  top: var(--switch-inset);
  left: var(--switch-inset);
  width: var(--knob);
  height: var(--knob);
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 58%, var(--bg));
  transition:
    transform 220ms var(--switch-ease),
    width 160ms var(--switch-ease),
    background-color 180ms ease;
}

.desktop-switch[aria-checked="true"] .desktop-switch-track {
  background: var(--text);
  box-shadow: inset 0 0 0 1px var(--text);
}

.desktop-switch[aria-checked="true"] .desktop-switch-knob {
  background: var(--bg);
  transform: translateX(var(--travel));
}

/* Pressed: an off knob grows to the right, an on knob grows to the left. */
.desktop-switch:active:not(:disabled, [aria-disabled="true"]) .desktop-switch-knob {
  width: var(--knob-pressed);
}

.desktop-switch[aria-checked="true"]:active:not(:disabled, [aria-disabled="true"]) .desktop-switch-knob {
  transform: translateX(calc(var(--travel) - (var(--knob-pressed) - var(--knob))));
}

.desktop-switch[aria-disabled="true"] {
  cursor: default;
}

/* Only a switch that can never be changed here is dimmed; a busy one is not. */
.desktop-switch:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.desktop-switch:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .desktop-switch:hover:not(:disabled, [aria-disabled="true"]) .desktop-switch-track {
    background: var(--accent-hover);
  }

  .desktop-switch[aria-checked="true"]:hover:not(:disabled, [aria-disabled="true"]) .desktop-switch-track {
    background: color-mix(in srgb, var(--text) 88%, var(--bg));
  }
}

@media (prefers-reduced-motion: reduce) {
  /* The knob jumps instead of travelling or stretching; its colour still fades. */
  .desktop-switch-knob {
    transition: background-color 180ms ease;
  }

  .desktop-switch:active:not(:disabled, [aria-disabled="true"]) .desktop-switch-knob {
    width: var(--knob);
  }

  .desktop-switch[aria-checked="true"]:active:not(:disabled, [aria-disabled="true"]) .desktop-switch-knob {
    transform: translateX(var(--travel));
  }
}
</style>
