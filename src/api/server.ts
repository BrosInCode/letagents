import { createApiApp } from "./server/app.js";
import { startRoomEventBridge, stopRoomEventBridge } from "./server/event-bridge.js";
import { startLivenessSweep, stopLivenessSweep } from "./server/liveness.js";
import { startDesktopPushWorker } from "./notifications/worker.js";
import { assertMessageThreadProjectionReady } from "./db/messages/projection-readiness.js";
import { closeApiRouteEventBroker } from "./server/routes.js";
import { pool } from "./db/client.js";
import { waitForSseCleanupDrain } from "./http/sse.js";
import {
  closeHttpServerIntake,
  createGracefulShutdownController,
} from "./server/graceful-shutdown.js";

const app = createApiApp();

// `db:migrate` commits and drains the online projection backfill before the
// new binary becomes eligible to serve summary-backed history queries.
await assertMessageThreadProjectionReady();

// Relays room events across API instances (Postgres LISTEN/NOTIFY). Started
// from the server entry point only, so tests and embedders opt in explicitly.
startRoomEventBridge();

// Announces worker-agent deaths and recoveries into rooms. Started from the
// server entry point only, so tests and embedders opt in explicitly.
startLivenessSweep();
const stopDesktopPushWorker = startDesktopPushWorker();
process.once("exit", closeApiRouteEventBroker);

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST;
const listenLabel = HOST || "localhost";
const onListen = () => {
  console.log(`🚀 Let Agents Chat API running on http://${listenLabel}:${PORT}`);
};

const server = HOST
  ? app.listen(PORT, HOST, onListen)
  : app.listen(PORT, onListen);

const stopIntake = () => closeHttpServerIntake(server);

const shutdown = createGracefulShutdownController({
  stopIntake,
  stopWorkers: async () => {
    await Promise.all([stopLivenessSweep(), stopDesktopPushWorker()]);
  },
  stopBridge: stopRoomEventBridge,
  closeBroker: closeApiRouteEventBroker,
  drainConnections: waitForSseCleanupDrain,
  closeDatabase: () => pool.end(),
  forceClose: () => server.closeAllConnections?.(),
  exit: (code) => process.exit(code),
  onError: (error) => console.error("API graceful shutdown failed:", error),
});
shutdown.install();
