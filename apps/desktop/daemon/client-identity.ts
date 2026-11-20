import { letagentsUserAgent } from "../../../shared/client-user-agent.mjs";
import { DAEMON_IMPLEMENTATION_VERSION } from "./types.js";

/** Sent with every request of the daemon to the room server, for example `LetAgents-Daemon/2.0.283 (darwin; arm64)`. */
export const DAEMON_USER_AGENT = letagentsUserAgent("Daemon", DAEMON_IMPLEMENTATION_VERSION);
