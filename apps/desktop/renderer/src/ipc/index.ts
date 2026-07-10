import type { DesktopApi } from "../../../electron/ipc-types/api.js";
import { toIpcPayload } from "../domain/ipc-payload.js";

export function desktopBridgeUpgradeMessage(): string {
  return "Restart LetAgents Desktop to load the latest room tools.";
}

function getDesktopApi(): DesktopApi | undefined {
  return window.letagentsDesktop as DesktopApi | undefined;
}

function wrapArgs(args: unknown[]): unknown[] {
  return args.map((arg) => toIpcPayload(arg));
}

type AnyFn = (...args: never[]) => unknown;

function wrapMethod<T extends AnyFn>(method: T, methodPath: string): T {
  const wrapped = ((...args: never[]) => {
    if (typeof method !== "function") {
      throw new Error(`${desktopBridgeUpgradeMessage()} (missing ${methodPath})`);
    }
    return method(...(wrapArgs(args) as never[]));
  }) as T;
  return wrapped;
}

function wrapNamespace<T extends object>(
  namespaceName: string,
  namespace: T,
): T {
  return new Proxy(namespace, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (!(prop in target)) {
        return undefined;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return wrapMethod(
          value.bind(target) as AnyFn,
          `letagentsDesktop.${namespaceName}.${prop}`,
        );
      }
      return value;
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
  });
}

function createDesktopIpcClient(): DesktopApi {
  return new Proxy({} as DesktopApi, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const api = getDesktopApi();
      if (!api || !(prop in api)) {
        return undefined;
      }
      const namespace = api[prop as keyof DesktopApi];
      if (!namespace || typeof namespace !== "object") {
        return namespace;
      }
      return wrapNamespace(prop, namespace as object);
    },
    has(_target, prop) {
      const api = getDesktopApi();
      return Boolean(api && typeof prop === "string" && prop in api);
    },
  });
}

/** Centralized desktop IPC client — auto-clones args via toIpcPayload. */
export const desktopIpc: DesktopApi = createDesktopIpcClient();

/** Room namespace with upgrade-guard semantics for optional methods. */
export function getRoomBridge(): Partial<DesktopApi["room"]> | undefined {
  return getDesktopApi()?.room as Partial<DesktopApi["room"]> | undefined;
}

export { toIpcPayload };
