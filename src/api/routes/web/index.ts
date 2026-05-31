import express, { type Express, type Response } from "express";
import fs from "fs";
import path from "path";

export type WebMode = "vue";

export const WEB_DIR = path.resolve(process.cwd(), "src", "web");
const VUE_DIST_DIR = path.join(WEB_DIR, "dist");
const VUE_INDEX = path.join(VUE_DIST_DIR, "index.html");
const HAS_VUE_BUILD = fs.existsSync(VUE_INDEX);

export function normalizeWebMode(rawMode: string | undefined): WebMode {
  const normalized = (rawMode || "vue").trim().toLowerCase();
  if (normalized === "vue") {
    return "vue";
  }
  if (normalized !== "") {
    const safeRawMode = JSON.stringify(rawMode ?? "");
    console.warn(
      `[web] Unknown LETAGENTS_WEB_MODE=${safeRawMode}. Serving the Vue web UI.`
    );
  }
  return "vue";
}

const WEB_MODE = normalizeWebMode(process.env.LETAGENTS_WEB_MODE);

function logWebMode(): void {
  if (!HAS_VUE_BUILD) {
    console.warn(
      `[web] Vue build is missing at ${VUE_INDEX}. Run npm run build:web before serving the web UI from the API.`
    );
  }

  console.log(`[web] Serving Vue web UI (requested mode: ${WEB_MODE}).`);
}

function sendVueApp(res: Response): void {
  if (!HAS_VUE_BUILD) {
    res
      .status(503)
      .send("Vue web build is missing. Run npm run build:web before serving the API web UI.");
    return;
  }

  res.sendFile(VUE_INDEX);
}

export function sendAppPage(res: Response): void {
  sendVueApp(res);
}

export function registerWebRoutes(app: Express): void {
  logWebMode();

  app.use(express.static(VUE_DIST_DIR, {
    index: false,
    maxAge: "1d",
  }));

  app.get("/", (_req, res) => {
    sendVueApp(res);
  });

  app.get("/docs", (_req, res) => {
    sendVueApp(res);
  });

  app.get("/app", (_req, res) => {
    res.redirect(301, "/");
  });
}
