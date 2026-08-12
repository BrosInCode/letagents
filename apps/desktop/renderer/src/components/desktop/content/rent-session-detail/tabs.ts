export type RentSessionDetailTab = "usage" | "activity" | "patches" | "access" | "exposures";

export const rentSessionDetailTabs: Array<{ id: RentSessionDetailTab; label: string }> = [
  { id: "usage", label: "Usage" },
  { id: "activity", label: "Activity" },
  { id: "patches", label: "Patches" },
  { id: "access", label: "Access requests" },
  { id: "exposures", label: "Exposures" },
];
