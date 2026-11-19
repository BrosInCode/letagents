export type RoomThemeId = "mint" | "fern" | "emerald" | "teal" | "ice" | "blue" | "indigo" | "violet" | "lilac" | "berry" | "rose" | "coral" | "amber" | "gold" | "stone" | "graphite";

export interface RoomCompanyAppearance {
  id: string;
  name: string;
  theme: RoomThemeId | null;
}

export interface RoomThemePreset {
  id: RoomThemeId;
  label: string;
  accent: string;
  lightAccent: string;
}

export declare const roomThemePresets: readonly RoomThemePreset[];
export declare function roomThemePreset(value: unknown): RoomThemePreset | undefined;
export declare function roomThemeId(value: unknown): RoomThemeId | null;
