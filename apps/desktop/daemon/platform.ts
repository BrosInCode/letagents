export function assertMacOS(platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error("The supervised-agent daemon is currently supported on macOS only.");
  }
}

/**
 * The singleton and control socket run on macOS and Windows. Starting the
 * whole daemon on Windows stays gated by assertMacOS until agents run there.
 */
export function assertSupervisorDaemonPlatform(platform = process.platform): void {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("The supervised-agent daemon is currently supported on macOS and Windows only.");
  }
}
