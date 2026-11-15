import { shallowReactive } from 'vue';
import { avatarFinish, characterNames } from './avatar-catalog';

// Chat and rosters use still portraits. A single temporary renderer fills this
// bounded cache, then releases its WebGL context; each message never owns one.
export const avatarPortraits = shallowReactive(new Map<string, string>());
const pending = new Set<string>();
let running = false;
let unavailable = false;
export function rememberAvatarPortrait(url: string, character: string, color: string): void {
  avatarPortraits.set(`${character}/${color}`, url);
}
export function requestAvatarPortrait(character: string, color: string): void {
  const key = `${character}/${color}`;
  if (typeof document === 'undefined' || unavailable || !characterNames[character] || avatarPortraits.has(key)) return;
  pending.add(key);
  if (!running) void renderPending();
}
async function renderPending(): Promise<void> {
  running = true;
  let preview: import('./scene/avatar-3d').AvatarPreview | undefined;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:320px;pointer-events:none';
  host.inert = true;
  document.body.append(host);
  try {
    const { createAvatarPreview } = await import('./scene/avatar-3d.js');
    preview = createAvatarPreview(host, { character: 'orbit', characterNames, palette: avatarFinish('sage'), onPortrait: rememberAvatarPortrait, onUnavailable: () => { unavailable = true; } });
    while (pending.size && !unavailable) {
      const batch = [...pending]; pending.clear();
      await preview.primePortraits(batch.filter(key => !avatarPortraits.has(key)).map(key => {
        const [character, color] = key.split('/'); return [character, avatarFinish(color)];
      }));
    }
  } catch { unavailable = true; pending.clear(); }
  finally { preview?.dispose(); host.remove(); running = false; }
}
