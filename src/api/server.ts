import { createApiApp } from "./server/app.js";
import { startRoomEventBridge } from "./server/event-bridge.js";
import { startLivenessSweep } from "./server/liveness.js";
import { startDesktopPushWorker } from "./notifications/worker.js";
import { assertMessageThreadProjectionReady } from "./db/messages/projection-readiness.js";

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
startDesktopPushWorker();

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST;
const listenLabel = HOST || "localhost";
const onListen = () => {
  console.log(`🚀 Let Agents Chat API running on http://${listenLabel}:${PORT}`);
};

if (HOST) {
  app.listen(PORT, HOST, onListen);
} else {
  app.listen(PORT, onListen);
}
