export interface GiveAgentRequest {
  id: string;
  asker: string;
  asker_avatar_url?: string | null;
  provider_id: string;
  model_label: string;
  amount_percent: number | null;
  note?: string;
  room_display_name?: string | null;
}
export interface GiveAgentOption {
  key: string;
  model: { providerId: string; model: string | null; label: string };
  requested: boolean;
  canGive: boolean;
}
export const AMOUNT_CHOICES = [5, 10, 20, 50] as const;
export function parseCustomAmount(text: string, max = 100): number | null {
  const value = Number(text.trim().replace(/%$/, ''));
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}
