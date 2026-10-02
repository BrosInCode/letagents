export const reminderPresets = [
  { id: "20m", label: "In 20 minutes" }, { id: "1h", label: "In 1 hour" },
  { id: "3h", label: "In 3 hours" }, { id: "tomorrow", label: "Tomorrow at 09:00" },
] as const;
export type ReminderPreset = typeof reminderPresets[number]["id"];
export function reminderDueAt(preset: ReminderPreset, now = new Date()): string {
  const due = new Date(now);
  if (preset === "tomorrow") { due.setDate(due.getDate() + 1); due.setHours(9, 0, 0, 0); }
  else due.setTime(due.getTime() + ({ "20m": 20, "1h": 60, "3h": 180 }[preset] * 60_000));
  return due.toISOString();
}
