import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

/** The one channel an embedded page may use; inline demos have no preload and use none. */
export const WEBVIEW_IPC_CHANNELS: ReadonlySet<string> = new Set(["page:call"]);

type Sender = { getType?: () => string } | null | undefined;

/** A `<webview>` guest (a room page or an inline demo) on a channel that is not its own. */
export function isRefusedWebviewSender(channel: string, sender: Sender): boolean {
  return typeof sender?.getType === "function" && sender.getType() === "webview" && !WEBVIEW_IPC_CHANNELS.has(channel);
}

/**
 * The IPC main every registrar gets: the same handlers, except that a message
 * from a `<webview>` guest is refused on every channel but `page:call`. The
 * page preload exposes only that channel and demos have no preload, so this
 * holds even if a guest ever reached `ipcRenderer` some other way.
 */
export function refuseWebviewSenders(target: IpcMain): IpcMain {
  const refusal = (channel: string) => new Error(`Embedded pages cannot use ${channel}.`);
  type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
  type MessageListener = (event: IpcMainEvent, ...args: any[]) => void;
  const invoke = (channel: string, listener: InvokeListener): InvokeListener => (event, ...args) => {
    if (isRefusedWebviewSender(channel, event.sender)) throw refusal(channel);
    return listener(event, ...args);
  };
  const message = (channel: string, listener: MessageListener): MessageListener => (event, ...args) => {
    if (isRefusedWebviewSender(channel, event.sender)) return;
    listener(event, ...args);
  };
  const guarded: Partial<IpcMain> = {
    handle: (channel, listener) => target.handle(channel, invoke(channel, listener)),
    handleOnce: (channel, listener) => target.handleOnce(channel, invoke(channel, listener)),
    on(channel, listener) {
      target.on(channel, message(channel, listener));
      return this as IpcMain;
    },
    once(channel, listener) {
      target.once(channel, message(channel, listener));
      return this as IpcMain;
    },
  };
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "string" && Object.hasOwn(guarded, property)) return guarded[property as keyof IpcMain];
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
