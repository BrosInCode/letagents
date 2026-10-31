/**
 * The supervisor daemon's process entry point. Electron spawns the built
 * dist-daemon/main.js. The daemon class lives in ./main/.
 */
import { redactCredentialText } from "./credential-redaction.js";
import { reportStateRecoveryReady } from "./state-recovery-key.js";
import { startDaemonLifecycleDiagnostics, daemonLifecycleErrorDetail } from "./lifecycle-log.js";
import { defaultDaemonPaths } from "./singleton.js";
import { isDaemonEntryPoint } from "./entry-point.js";
import { SupervisorDaemon } from "./main/index.js";

export { SupervisorDaemon };

export {
  productionSupervisedDeliveryHttp,
  SupervisorGrantRequestError,
  workplaceLivenessStaleAfterMs,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
export {
  isSupervisedQuietPollContinuation,
  isSupervisedWaitProviderEvent,
  providerStreamLifecycle,
  resolveReadyReachedAt,
  supervisedWaitCursorFromProviderEvent,
  supervisedWaitEvidenceFromProviderEvent,
} from "./provider-stream-policy.js";
export { sameProcessBirthIdentity } from "./process-identity.js";
export {
  CONTINUATION_REPAIR_EXHAUSTED_ERROR,
  continuationRepairExhaustionNeedsPersistence,
  continuationRepairMissingContinuation,
} from "./continuation-repair-policy.js";

export type { DaemonReconcileInput } from "./provider-reconciliation-coordinator.js";

if (isDaemonEntryPoint(import.meta.url, process.argv[1])) {
  const paths = defaultDaemonPaths();
  const lifecycle = startDaemonLifecycleDiagnostics(paths.lifecycleLogPath);
  void (async () => {
    const { ProviderActionPortRouter } = await import("./provider-action-port-router.js");
    const daemon = new SupervisorDaemon(paths, process.platform, new ProviderActionPortRouter(), true);
    await daemon.start({ onPrepared: reportStateRecoveryReady });
    lifecycle.append({ event: "daemon_ready" });
    await daemon.waitForHandoff();
    lifecycle.append({ event: "handoff_complete" });
    process.exit(0);
  })().catch((error) => {
    const detail = daemonLifecycleErrorDetail(error);
    lifecycle.append({ event: "entrypoint_failure", detail });
    console.error("Supervisor daemon failed:", redactCredentialText(detail).value);
    process.exit(1);
  });
}
