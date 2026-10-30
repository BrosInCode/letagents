/** The singleton, control socket and supervised agents run on macOS and Windows. */
export function assertSupervisorDaemonPlatform(platform = process.platform): void {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("The supervised-agent daemon is currently supported on macOS and Windows only.");
  }
}
