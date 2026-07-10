/**
 * Returns a structured-clone-safe copy of a value for crossing the
 * contextBridge. Vue reactive objects are Proxies, which Electron's bridge
 * serializer rejects with "An object could not be cloned." — so any object
 * that may originate from reactive state (props, computeds, store values)
 * must pass through here before being handed to a window.letagentsDesktop
 * call. JSON round-tripping also drops undefined members, which the IPC
 * layer treats the same as absent.
 */
export function toIpcPayload<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
