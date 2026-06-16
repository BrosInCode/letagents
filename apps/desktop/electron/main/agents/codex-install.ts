export interface CodexInstallCommand {
  command: string;
  args: string[];
  detail: string;
}

export function codexInstallCommand(
  platform: NodeJS.Platform = process.platform,
): CodexInstallCommand {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex",
      ],
      detail: "Runs the official Codex Windows installer from chatgpt.com. The installer chooses the destination and makes the codex CLI available on PATH.",
    };
  }

  return {
    command: "sh",
    args: ["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"],
    detail: "Runs the official Codex installer from chatgpt.com. The installer chooses the destination and makes the codex CLI available on PATH.",
  };
}
