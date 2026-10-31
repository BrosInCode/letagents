export { DAEMON_STATE_SCHEMA_VERSION } from "./shared.js";
export { assertDaemonStateVersionSupported } from "./version-gate.js";
export { DaemonStateSchema } from "./schema.js";
export { openDaemonStateObservationDatabase, openDaemonStateDatabase, openPreparedDaemonStateDatabase, ensureDaemonStateDatabase } from "./connection.js";
