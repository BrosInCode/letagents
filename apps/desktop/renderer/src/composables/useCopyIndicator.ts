import { ref, type Ref } from "vue";

import { copyTextToClipboard } from "../domain/clipboard";

export type CopyIndicator = {
  copied: Ref<boolean>;
  copy: (text: string) => Promise<boolean>;
};

export function useCopyIndicator(resetMs = 1400): CopyIndicator {
  const copied = ref(false);
  let resetTimer: number | null = null;

  async function copy(text: string): Promise<boolean> {
    const ok = await copyTextToClipboard(text);
    copied.value = ok;
    if (resetTimer !== null) {
      window.clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (ok) {
      resetTimer = window.setTimeout(() => {
        copied.value = false;
        resetTimer = null;
      }, resetMs);
    }
    return ok;
  }

  return { copied, copy };
}

export type CopyValueIndicator = {
  copiedValue: Ref<string | null>;
  copy: (text: string) => Promise<boolean>;
};

export function useCopyValueIndicator(resetMs = 1400): CopyValueIndicator {
  const copiedValue = ref<string | null>(null);
  let resetTimer: number | null = null;

  async function copy(text: string): Promise<boolean> {
    const ok = await copyTextToClipboard(text);
    copiedValue.value = ok ? text : null;
    if (resetTimer !== null) {
      window.clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (ok) {
      resetTimer = window.setTimeout(() => {
        if (copiedValue.value === text) {
          copiedValue.value = null;
        }
        resetTimer = null;
      }, resetMs);
    }
    return ok;
  }

  return { copiedValue, copy };
}
