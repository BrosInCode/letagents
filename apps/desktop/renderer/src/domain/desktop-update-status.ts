import type { DesktopUpdateStatus } from "../../../electron/ipc-types";

export interface DesktopUpdatePresentation {
  title: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "error";
}

export function desktopUpdatePresentation(status: DesktopUpdateStatus | null): DesktopUpdatePresentation {
  if (!status) {
    return {
      title: "Reading update status",
      detail: "LetAgents is checking the local updater state.",
      tone: "neutral",
    };
  }
  switch (status.phase) {
    case "unsupported":
      return {
        title: "Updates are off in this build",
        detail: status.unsupportedReason || "Automatic updates are unavailable.",
        tone: "neutral",
      };
    case "checking":
      return {
        title: "Checking for updates",
        detail: "Looking for a newer signed LetAgents release.",
        tone: "neutral",
      };
    case "downloading":
      return {
        title: "Downloading the update",
        detail: "You can keep working. LetAgents will ask before restarting.",
        tone: "neutral",
      };
    case "up-to-date":
      return {
        title: "LetAgents is up to date",
        detail: `Version ${status.currentVersion} is the newest available release.`,
        tone: "success",
      };
    case "ready":
      return {
        title: `${status.releaseName || status.availableVersion || "An update"} is ready`,
        detail: status.error
          ? `The update is still downloaded. ${status.error}`
          : "Restart when convenient to install it.",
        tone: status.error ? "warning" : "success",
      };
    case "installing":
      return {
        title: "Preparing a safe restart",
        detail: "Pausing supervisor dispatch and handing off running agent sessions.",
        tone: "warning",
      };
    case "error":
      return {
        title: "Update check failed",
        detail: status.error || "LetAgents could not reach the update feed.",
        tone: "error",
      };
    default:
      return {
        title: "Automatic updates are ready",
        detail: "LetAgents checks periodically and downloads signed releases in the background.",
        tone: "neutral",
      };
  }
}
