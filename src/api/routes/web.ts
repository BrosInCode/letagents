import express, { type Express, type Response } from "express";
import fs from "fs";
import path from "path";

export type WebMode = "legacy" | "vue";

export const WEB_DIR = path.resolve(process.cwd(), "src", "web");
const VUE_DIST_DIR = path.join(WEB_DIR, "dist");
const VUE_INDEX = path.join(VUE_DIST_DIR, "index.html");
const HAS_VUE_BUILD = fs.existsSync(VUE_INDEX);
const LEGACY_LANDING_PAGE = path.join(WEB_DIR, "landing.html");
const LEGACY_DOCS_PAGE = path.join(WEB_DIR, "docs.html");
const LEGACY_APP_PAGE = path.join(WEB_DIR, "index.html");

export function normalizeWebMode(rawMode: string | undefined): WebMode {
  const normalized = (rawMode || "legacy").trim().toLowerCase();
  if (normalized === "vue") {
    return "vue";
  }
  if (normalized !== "" && normalized !== "legacy") {
    const safeRawMode = JSON.stringify(rawMode ?? "");
    console.warn(
      `[web] Unknown LETAGENTS_WEB_MODE=${safeRawMode}. Falling back to legacy mode.`
    );
  }
  return "legacy";
}

const WEB_MODE = normalizeWebMode(process.env.LETAGENTS_WEB_MODE);
const SHOULD_SERVE_VUE = WEB_MODE === "vue" && HAS_VUE_BUILD;

function logWebMode(): void {
  if (WEB_MODE === "vue" && !HAS_VUE_BUILD) {
    console.warn(
      `[web] LETAGENTS_WEB_MODE=vue was set, but ${VUE_INDEX} is missing. Falling back to legacy pages.`
    );
  }

  console.log(
    `[web] Serving ${SHOULD_SERVE_VUE ? "vue" : "legacy"} web UI (requested mode: ${WEB_MODE}).`
  );
}

function sendWebPage(res: Response, legacyPath: string): void {
  if (SHOULD_SERVE_VUE) {
    res.sendFile(VUE_INDEX);
  } else {
    res.sendFile(legacyPath);
  }
}

export function sendAppPage(res: Response): void {
  sendWebPage(res, LEGACY_APP_PAGE);
}

export function registerWebRoutes(app: Express): void {
  logWebMode();

  if (SHOULD_SERVE_VUE) {
    app.use("/assets", express.static(path.join(VUE_DIST_DIR, "assets"), {
      maxAge: "1y",
      immutable: true,
    }));
    app.use("/images", express.static(path.join(VUE_DIST_DIR, "images"), {
      maxAge: "1d",
    }));
  }

  app.get("/", (_req, res) => {
    sendWebPage(res, LEGACY_LANDING_PAGE);
  });

  app.get("/docs", (_req, res) => {
    sendWebPage(res, LEGACY_DOCS_PAGE);
  });

  app.get("/app", (_req, res) => {
    res.redirect(301, "/");
  });

  app.use(express.static(WEB_DIR, { index: false }));
}
