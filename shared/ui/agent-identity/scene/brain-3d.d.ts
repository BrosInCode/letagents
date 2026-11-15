export interface BrainPreview {
  setSelection(value: number): void;
  setCapability(tier: number | null, options?: { immediate?: boolean }): void;
  setEffort(value: string, options?: { immediate?: boolean }): void;
  setState(state: { active: boolean; animate: boolean }): void;
  dispose(): void;
}
export function createBrainPreview(host: HTMLElement, options: { onUnavailable: () => void }): Promise<BrainPreview>;
