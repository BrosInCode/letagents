// Only the separately packaged preview uses this entrypoint. Production keeps
// dist-electron/main.js. Await the import so Electron cannot emit ready before
// the normal main module has registered its startup handlers.
import electron from "electron";
import { createRequire } from "node:module";
import isolation from "./preview-isolation.cjs";

const { app } = electron;
const { letagentsPreview } = createRequire(import.meta.url)("./package.json");
isolation.configureIsolatedPreview({ app, profile: letagentsPreview });
try {
  await import("./dist-electron/main.js");
} catch (error) {
  console.error("LetAgents Preview could not start:", error);
  app.exit(1);
}
