import { app, protocol } from "electron";

import { handleAttachmentProtocolRequest } from "./main/attachments.js";
import { registerDesktopIpcHandlers } from "./main/ipc.js";
import { attachmentProtocolScheme } from "./main/paths.js";
import { stopDesktopRoomStream } from "./main/room-stream.js";
import { createWindow, hasOpenWindows } from "./main/window.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: attachmentProtocolScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

registerDesktopIpcHandlers();

app.whenReady().then(() => {
  protocol.handle(attachmentProtocolScheme, handleAttachmentProtocolRequest);
  createWindow();

  app.on("activate", () => {
    if (!hasOpenWindows()) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  void stopDesktopRoomStream();
});

app.on("window-all-closed", () => {
  void stopDesktopRoomStream();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
