/**
 * The resources folder of the packaged app, or "" in a process that has none.
 * Electron sets process.resourcesPath, also in Node mode of the packaged
 * program. The provider runtime compiles without the Electron types, so the
 * property is read here in one place.
 */
export function electronResourcesPath(): string {
  const value = (process as { resourcesPath?: unknown }).resourcesPath;
  return typeof value === "string" ? value : "";
}
