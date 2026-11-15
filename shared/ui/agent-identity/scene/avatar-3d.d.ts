import type { AvatarFinish } from '../avatar-catalog';
export interface AvatarPreview {
  captureFrame(): string | null;
  setCharacter(id: string, finish: AvatarFinish, options?: { animate?: boolean; direction?: number }): void;
  setPalette(finish: AvatarFinish): void;
  primePortraits(entries: Array<[string, AvatarFinish]>): Promise<void>;
  setState(state: { active: boolean; animate: boolean }): void;
  dispose(): void;
}
export function createAvatarPreview(host: HTMLElement, options: {
  character: string; characterNames: Record<string, string>; palette: AvatarFinish;
  onPortrait?: (url: string, character: string, color: string) => void;
  onUnavailable?: () => void;
}): AvatarPreview;
