import {
  defaultWorkspaceUri,
  findCoreProcess,
  findWorkspaceProcess,
} from "../language-server.mjs";
import { findLsBaseUrl } from "../connect-rpc.mjs";

export async function resolveAntigravityTarget({
  direct,
  requestedTargetMode,
  log,
}) {
  const workspaceUri = defaultWorkspaceUri();
  const effectiveTargetMode =
    direct && requestedTargetMode === "auto" ? "core" : requestedTargetMode;

  let targetKind = "core";
  let targetProcess = null;

  if (effectiveTargetMode !== "core" && workspaceUri) {
    const workspaceProcess = findWorkspaceProcess(workspaceUri);
    if (workspaceProcess?.csrf) {
      targetKind = "workspace";
      targetProcess = workspaceProcess;
    } else if (effectiveTargetMode === "workspace") {
      throw new Error(
        `Workspace LS not found for ${workspaceUri}. Open the repo in Antigravity first, or rerun with --core-ls.`,
      );
    }
  }

  if (!targetProcess) {
    const coreProcess = findCoreProcess();
    if (!coreProcess?.csrf) {
      throw new Error(
        "Core LS not found. Start Antigravity and ensure a language_server_macos_arm_bin process exists without --enable_lsp.",
      );
    }
    targetProcess = coreProcess;
  }

  const baseUrl = await findLsBaseUrl(targetProcess.pid, targetProcess.csrf, log);
  log(
    `Using ${targetKind} LS pid=${targetProcess.pid} ${baseUrl}` +
      (workspaceUri ? ` workspaceUri=${workspaceUri}` : ""),
  );

  return {
    baseUrl,
    targetKind,
    targetProcess,
    workspaceUri,
  };
}
