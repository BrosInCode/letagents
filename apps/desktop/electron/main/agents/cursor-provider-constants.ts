export const TURN_START_TIMEOUT_MS = 30_000;

// Native readiness and MCP capability attestation intentionally share one
// deadline so a legitimate cold Cursor process keeps a single startup budget.
export const CURSOR_LIVE_MCP_CAPABILITY_TIMEOUT_MS = TURN_START_TIMEOUT_MS;
export const MAX_DURABLE_TURN_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_DURABLE_TURN_TERMINAL_BYTES = 1024 * 1024;
export const MAX_CURSOR_STREAM_LINE_BYTES = 512 * 1024;
export const MAX_CURSOR_STREAM_EVENTS = 4_096;
export const MAX_CURSOR_SESSION_ID_LENGTH = 256;
export const MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH = 1_024;
export const CURSOR_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// Both checks are local-runtime contracts. Keep enough room for Cursor's
// native handshake without turning a broken runtime into a long launch stall.
export const CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS = 15_000;
export const CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS = 15_000;
export const CURSOR_MCP_CONNECTOR_PARENT = "/tmp";
export const CURSOR_SUPERVISED_AGENT_ENDPOINT = "https://api2.cursor.sh";
export const CURSOR_SUPERVISED_CONTROL_PLANE_PATHS = [
  "/aiserver.v1.DashboardService/GetMe",
  "/aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam",
  "/aiserver.v1.DashboardService/GetUserPrivacyMode",
  "/aiserver.v1.ServerConfigService/GetServerConfig",
  "/aiserver.v1.AiService/AvailableModels",
  "/aiserver.v1.AiService/GetUsableModels",
  "/aiserver.v1.AiService/GetDefaultModelForCli",
] as const;
