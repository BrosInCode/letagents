export const roomThemePresets = [
  { id: "mint", label: "Mint", accent: "#A8DEC7", lightAccent: "#376B56" },
  { id: "fern", label: "Fern", accent: "#A5CB7C", lightAccent: "#4E682F" },
  { id: "emerald", label: "Emerald", accent: "#64C593", lightAccent: "#266B4C" },
  { id: "teal", label: "Teal", accent: "#5BC6C5", lightAccent: "#216A69" },
  { id: "ice", label: "Ice", accent: "#8ED2EF", lightAccent: "#276482" },
  { id: "blue", label: "Blue", accent: "#A1BBEF", lightAccent: "#3C5B92" },
  { id: "indigo", label: "Indigo", accent: "#8589ED", lightAccent: "#494D9C" },
  { id: "violet", label: "Violet", accent: "#BCA0F6", lightAccent: "#61478F" },
  { id: "lilac", label: "Lilac", accent: "#E2B9ED", lightAccent: "#795286" },
  { id: "berry", label: "Berry", accent: "#DC77AD", lightAccent: "#854367" },
  { id: "rose", label: "Rose", accent: "#EFA4BF", lightAccent: "#8B4560" },
  { id: "coral", label: "Coral", accent: "#F2937B", lightAccent: "#934838" },
  { id: "amber", label: "Amber", accent: "#EDC997", lightAccent: "#79501E" },
  { id: "gold", label: "Gold", accent: "#DAC36B", lightAccent: "#725C1B" },
  { id: "stone", label: "Stone", accent: "#C9BCAA", lightAccent: "#665848" },
  { id: "graphite", label: "Graphite", accent: "#B8BDC9", lightAccent: "#53596A" },
];

export function roomThemePreset(value) {
  return roomThemePresets.find(preset => preset.id === value);
}

export function roomThemeId(value) {
  return roomThemePreset(value)?.id ?? null;
}
