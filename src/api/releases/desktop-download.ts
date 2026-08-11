import type { Express } from "express";

import {
  MAC_DESKTOP_BETA_CHECKSUM_RELEASES,
  MAC_DESKTOP_BETA_RELEASE,
  type MacDesktopArchitecture,
} from "../../shared/desktop-release.js";

function parseArchitecture(raw: string): MacDesktopArchitecture | undefined {
  return raw === "arm64" || raw === "x64" ? raw : undefined;
}

export function registerDesktopDownloadRoutes(
  app: Express,
): void {
  for (const { version, assets } of MAC_DESKTOP_BETA_CHECKSUM_RELEASES) {
    app.get(`/downloads/mac/v${version}/checksums`, (_req, res) => {
      res
        .type("text/plain")
        .set("Cache-Control", "public, max-age=86400, immutable")
        .send([
          `LetAgents for Mac beta v${version}`,
          "",
          `SHA-256 (${assets.arm64.fileName})`,
          assets.arm64.sha256,
          "",
          `SHA-256 (${assets.x64.fileName})`,
          assets.x64.sha256,
          "",
        ].join("\n"));
    });
  }

  app.get("/downloads/mac/:architecture", (req, res) => {
    const architecture = parseArchitecture(req.params.architecture);
    if (!architecture) {
      res.status(404).send("Mac beta build not found.");
      return;
    }

    res
      .set("Cache-Control", "public, max-age=60, must-revalidate")
      .redirect(302, MAC_DESKTOP_BETA_RELEASE.assets[architecture].publicUrl);
  });
}
