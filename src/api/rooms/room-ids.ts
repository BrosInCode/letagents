/**
 * Repository-backed room ids are `host/namespace/repo` locators. The check
 * lives in room-nature.ts, the one module that classifies rooms; this name
 * stays for existing importers.
 */
export { isRepoShapedRoomId as isRepoBackedRoomId } from "./room-nature.js";
