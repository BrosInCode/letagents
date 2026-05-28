export type RentSessionDetailTab = "usage" | "activity" | "patches";

export const rentSessionDetailTabs: Array<{ id: RentSessionDetailTab; label: string }> = [
  { id: "usage", label: "Usage" },
  { id: "activity", label: "Activity" },
  { id: "patches", label: "Patches" },
];
