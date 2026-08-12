import type { DesktopUpdateStatus } from "../../../electron/ipc-types";

export interface DesktopUpdatePresentation {
  title: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "error";
}

export interface DesktopUpdateSidebarPresentation {
  active: boolean;
  title: string;
  detail: string;
  percent: number | null;
  state: "settings" | "downloading" | "ready" | "installing" | "error";
}

export function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function desktopUpdateSidebarPresentation(
  status: DesktopUpdateStatus | null,
): DesktopUpdateSidebarPresentation {
  const version = status?.availableVersion || null;
  if (status?.phase === "downloading") {
    const progress = status.downloadProgress;
    const percent = progress ? Math.max(0, Math.min(100, progress.percent)) : null;
    const transferred = progress ? formatUpdateBytes(progress.transferred) : null;
    const total = progress?.total ? formatUpdateBytes(progress.total) : null;
    const rate = progress?.bytesPerSecond ? formatUpdateBytes(progress.bytesPerSecond) : null;
    const detail = transferred && total
      ? `${transferred} of ${total}${rate ? ` · ${rate}/s` : ""}`
      : "Preparing the signed download";
    return {
      active: true,
      title: version ? `Downloading v${version}` : "Downloading update",
      detail,
      percent,
      state: "downloading",
    };
  }
  if (status?.phase === "ready") {
    return {
      active: true,
      title: status.error ? "Update paused" : "Update ready",
      detail: status.error
        ? "Open Updates to retry"
        : `${version ? `v${version} · ` : ""}Restart to install`,
      percent: 100,
      state: status.error ? "error" : "ready",
    };
  }
  if (status?.phase === "installing") {
    return {
      active: true,
      title: "Restarting to update",
      detail: "Handing off running agents safely",
      percent: 100,
      state: "installing",
    };
  }
  if (status?.phase === "error" && version) {
    return {
      active: true,
      title: "Update paused",
      detail: "Open Updates to retry",
      percent: status.downloadProgress?.percent ?? null,
      state: "error",
    };
  }
  return {
    active: false,
    title: "Settings",
    detail: "Account, storage, setup",
    percent: null,
    state: "settings",
  };
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
      if (status.downloadProgress?.total) {
        const progress = status.downloadProgress;
        return {
          title: status.availableVersion
            ? `Downloading LetAgents ${status.availableVersion}`
            : "Downloading the update",
          detail: `${formatUpdateBytes(progress.transferred)} of ${formatUpdateBytes(progress.total)}${progress.bytesPerSecond ? ` · ${formatUpdateBytes(progress.bytesPerSecond)}/s` : ""}. You can keep working.`,
          tone: "neutral",
        };
      }
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
