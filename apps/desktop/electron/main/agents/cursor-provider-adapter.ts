// Compatibility entry point. The Cursor provider adapter lives in ./cursor/;
// this file keeps every existing import path and exported name working.
export {
  assertCursorPersonalIdentity,
  boundedCursorRoomTurnPrompt,
  cursorCliEnv,
  CursorIdentityAuthRequiredError,
  cursorLaunchPolicyArgs,
  cursorLiveDisplayProjections,
  CURSOR_NO_ROOM_REPLY_SENTINEL,
  CursorProviderAdapter,
  CursorTeamManagedIdentityError,
  defaultLaunchTurn,
  type CursorCliChild,
  type CursorProviderAdapterDependencies,
  type CursorProviderAdapterOptions,
} from "./cursor/index.js";
