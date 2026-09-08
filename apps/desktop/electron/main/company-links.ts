import electron from "electron";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseCompanyLink } from "./company-link.js";
import { createWindow, emitToMainWindow, focusMainWindow, hasOpenWindows } from "./window.js";

const { app } = electron as typeof import("electron");
const pendingPath = () => join(app.getPath("userData"), "pending-company-link.json");
let pending: string | null = null;
let loaded = false;

export function getPendingCompanyLink(): string | null {
  if (!loaded) {
    loaded = true;
    try {
      const value = JSON.parse(readFileSync(pendingPath(), "utf8"));
      pending = typeof value.organizationId === "string" && /^[1-9][0-9]*$/.test(value.organizationId) ? value.organizationId : null;
    } catch { /* No pending link. */ }
  }
  return pending;
}

export function acknowledgeCompanyLink(id: unknown): void {
  if (id !== getPendingCompanyLink()) return;
  pending = null;
  try { unlinkSync(pendingPath()); } catch { /* Already absent. */ }
}

export function acceptCompanyLink(value: string): void {
  const id = parseCompanyLink(value);
  if (!id) return;
  loaded = true;
  pending = id;
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(`${pendingPath()}.tmp`, JSON.stringify({ organizationId: id }), { mode: 0o600 });
    renameSync(`${pendingPath()}.tmp`, pendingPath());
  } catch { /* In-memory continuation still works if preference storage fails. */ }
  if (app.isReady()) {
    if (!hasOpenWindows()) createWindow();
    focusMainWindow();
    emitToMainWindow("desktop:organizations:invited", id);
  }
}

export function prepareCompanyLinks(): void {
  app.on("open-url", (event, url) => { event.preventDefault(); acceptCompanyLink(url); });
  app.on("second-instance", (_event, argv) => {
    for (const argument of argv) acceptCompanyLink(argument);
    focusMainWindow();
  });
  for (const argument of process.argv) acceptCompanyLink(argument);
  // Development runs must not replace an installed app's protocol association.
  if (app.isPackaged) app.setAsDefaultProtocolClient("letagents");
}
