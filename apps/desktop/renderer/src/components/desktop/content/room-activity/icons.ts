import type { ActivityIcon } from "./types";

const iconPaths: Record<ActivityIcon, string> = {
  radio: "M4.93 19.07a10 10 0 0 1 0-14.14M8.46 15.54a5 5 0 0 1 0-7.08M12 12h.01M15.54 8.46a5 5 0 0 1 0 7.08M19.07 4.93a10 10 0 0 1 0 14.14",
  pulse: "M3 12h4l2-7 4 14 2-7h6",
  power: "M12 2v10M18.36 5.64a9 9 0 1 1-12.72 0",
  user: "M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  brain: "M9.5 3a3 3 0 0 0-3 3v.5A3.5 3.5 0 0 0 3 10v1a3 3 0 0 0 3 3h.5V9M14.5 3a3 3 0 0 1 3 3v.5A3.5 3.5 0 0 1 21 10v1a3 3 0 0 1-3 3h-.5V9M8 17a4 4 0 0 0 8 0",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  task: "M9 11l2 2 4-4M4 5h16M4 19h16M4 12h2M18 12h2",
};

export function activityIconPath(icon: ActivityIcon): string {
  return iconPaths[icon];
}
