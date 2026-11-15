import { computed, readonly, ref } from 'vue';
import { chatBubbleStyle, chatColorRoles, defaultChatColors, normalizeChatColor, parseChatColors, type ChatColorRole } from '../chat-colors';

const key = 'letagents-chat-styling-v1';
const colors = ref({ ...defaultChatColors });
const saved = ref(true);
let initialized = false;
const styles = computed(() => Object.fromEntries(chatColorRoles.map(role => [role, chatBubbleStyle(colors.value[role])])));

function readStored(raw: string | null) {
  try { colors.value = parseChatColors(raw ? JSON.parse(raw) : null); }
  catch { colors.value = { ...defaultChatColors }; }
}
function initialize() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try { readStored(window.localStorage.getItem(key)); } catch { saved.value = false; }
  window.addEventListener?.('storage', event => {
    if (event.key === key || event.key === null) readStored(event.newValue);
  });
}
function persist() {
  try { window.localStorage.setItem(key, JSON.stringify(colors.value)); saved.value = true; }
  catch { saved.value = false; }
}
export function useChatStyling() {
  initialize();
  return {
    colors: readonly(colors), saved: readonly(saved),
    isDefault: computed(() => chatColorRoles.every(role => colors.value[role] === defaultChatColors[role])),
    styleFor: (role: ChatColorRole | null) => role ? styles.value[role] : {},
    setColor(role: ChatColorRole, value: string) {
      const color = normalizeChatColor(value);
      if (!color || !chatColorRoles.includes(role)) return;
      colors.value = { ...colors.value, [role]: color };
      persist();
    },
    reset() { colors.value = { ...defaultChatColors }; persist(); },
  };
}
