import { homedir, platform } from "node:os";
import { join } from "node:path";

export function defaultAntigravityQuotaPaths(homeOverride?: string): string[] {
  const home = homeOverride ?? homedir();
  const plat = platform();
  if (plat === "darwin") {
    return [
      join(home, "Library", "Application Support", "Antigravity", "quota.json"),
      join(home, ".antigravity", "quota.json"),
    ];
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(appData, "Antigravity", "quota.json"),
      join(home, ".antigravity", "quota.json"),
    ];
  }

  return [
    join(home, ".config", "antigravity", "quota.json"),
    join(home, ".antigravity", "quota.json"),
  ];
}
