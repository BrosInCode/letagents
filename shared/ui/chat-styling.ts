import { computed, readonly, ref } from 'vue';
import { chatBubbleStyle, chatColorRoles, defaultChatColors, normalizeChatColor, type ChatColorRole } from '../chat-colors';
import { useRoomTheme } from './room-theme';

const key = 'letagents-chat-styling-v2';
const legacyKey = 'letagents-chat-styling-v1';
const overrides = ref<Partial<Record<ChatColorRole, string>>>({});
const saved = ref(true);
let initialized = false;
const defaultStyles = Object.fromEntries(chatColorRoles.map(role => [role, chatBubbleStyle(defaultChatColors[role])]));
const overrideStyles = computed(() => Object.fromEntries(Object.entries(overrides.value).map(([role, color]) => [role, chatBubbleStyle(color)])));

function readStored(raw: string | null, legacy = false) {
  try {
    const value = raw ? JSON.parse(raw) : null;
    const colors: Partial<Record<ChatColorRole, string>> = {};
    if (value && typeof value === 'object') {
      for (const role of chatColorRoles) {
        const color = normalizeChatColor(value[role]);
        if (color && (!legacy || color !== defaultChatColors[role])) colors[role] = color;
      }
    }
    overrides.value = colors;
  } catch { overrides.value = {}; }
}

function readStorage() {
  const stored = window.localStorage.getItem(key);
  if (stored !== null) readStored(stored);
  else readStored(window.localStorage.getItem(legacyKey), true);
}

function initialize() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try { readStorage(); } catch { saved.value = false; }
  window.addEventListener?.('storage', event => {
    if (event.key === key) readStored(event.newValue);
    else if (event.key === null) readStored(null);
  });
}

function persist() {
  try { window.localStorage.setItem(key, JSON.stringify(overrides.value)); saved.value = true; }
  catch { saved.value = false; }
}

export function useChatStyling() {
  initialize();
  const roomTheme = useRoomTheme();
  return {
    colors: computed(() => ({ ...defaultChatColors, ...overrides.value })),
    overrides: readonly(overrides),
    saved: readonly(saved),
    isDefault: computed(() => Object.keys(overrides.value).length === 0),
    styleFor: (role: ChatColorRole | null) => role
      ? overrideStyles.value[role] ?? roomTheme?.bubbles.value[role] ?? defaultStyles[role]
      : {},
    setColor(role: ChatColorRole, value: string) {
      const color = normalizeChatColor(value);
      if (!color || !chatColorRoles.includes(role)) return;
      overrides.value = { ...overrides.value, [role]: color };
      persist();
    },
    useTheme(role: ChatColorRole) {
      const next = { ...overrides.value };
      delete next[role];
      overrides.value = next;
      persist();
    },
    reset() { overrides.value = {}; persist(); },
  };
}
