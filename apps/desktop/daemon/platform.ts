export function assertMacOS(platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error("The supervised-agent daemon is currently supported on macOS only.");
  }
}
