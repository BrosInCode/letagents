import {
  DAEMON_PROTOCOL_VERSION,
  isAsyncDaemonRpcMethod,
  isDaemonAsyncRpcAccepted,
  type DaemonRpcEffectView,
  type DaemonStateWatchWireResult,
} from "#daemon-contract/index.js";
import { connectDaemon } from "../../../../shared/daemon-endpoint.mjs";

export type DaemonSocketReply = {
  ok: boolean;
  result?: any;
  error?: string;
  version: number;
};

/**
 * Sends a single control-socket frame and returns the raw wire response without
 * awaiting asynchronous `effect_id` settlement on `manifest.watch_state`.
 */
export async function daemonRawSocketRequest(
  socketPath: string,
  method: string,
  params?: unknown,
  version = DAEMON_PROTOCOL_VERSION,
): Promise<DaemonSocketReply> {
  return new Promise((resolve, reject) => {
    const client = connectDaemon(socketPath);
    let received = "";
    let settled = false;
    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("close", () => {
      if (!settled) reject(new Error(`Daemon connection closed before '${method}' returned a response.`));
    });
    client.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      settled = true;
      client.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))) as DaemonSocketReply);
    });
    client.on("connect", () => client.write(`${JSON.stringify({ version, id: "test", method, params })}\n`));
  });
}

/**
 * Sends a control-socket RPC and, when the daemon acknowledges an asynchronous
 * RPC effect (`{ effect_id, daemon_generation }`), awaits its terminal outcome
 * delivered through `manifest.watch_state` (`rpc_effects`).
 */
export async function daemonSocketRequest(
  socketPath: string,
  method: string,
  params?: unknown,
  version = DAEMON_PROTOCOL_VERSION,
): Promise<DaemonSocketReply> {
  const reply = await daemonRawSocketRequest(socketPath, method, params, version);
  if (!reply.ok || !isAsyncDaemonRpcMethod(method) || !isDaemonAsyncRpcAccepted(reply.result)) {
    return reply;
  }
  const accepted = reply.result;
  let afterGen = 0;
  let afterSeq = 0;
  for (;;) {
    const initial = afterGen === 0;
    const watch = await daemonRawSocketRequest(
      socketPath,
      "manifest.watch_state",
      {
        after_daemon_generation: afterGen,
        after_sequence: afterSeq,
        wait_ms: initial ? 0 : 5_000,
        ...(initial ? {} : { changed_only: true }),
      },
      version,
    );
    if (!watch.ok) {
      return {
        ok: false,
        error: watch.error ?? `Failed to watch async RPC effect for ${method}.`,
        version: watch.version,
      };
    }
    const snapshot = watch.result as DaemonStateWatchWireResult;
    if (snapshot.daemon_generation !== accepted.daemon_generation) {
      return {
        ok: false,
        error: `Supervisor daemon generation changed while waiting for ${method}.`,
        version: reply.version,
      };
    }
    const match = snapshot.rpc_effects?.find(
      (effect: DaemonRpcEffectView) => effect.effect_id === accepted.effect_id,
    );
    const resolvedEffect: DaemonRpcEffectView | null = match
      ?? (!("complete" in snapshot) || snapshot.complete !== false
        ? await daemonRawSocketRequest(
          socketPath,
          "supervisor.get_rpc_effect",
          { effect_id: accepted.effect_id, daemon_generation: accepted.daemon_generation },
          version,
        ).then((lookup) => (lookup.ok ? (lookup.result as DaemonRpcEffectView | null) : null))
        : null);
    if (resolvedEffect) {
      if (resolvedEffect.state === "completed") {
        return { ok: true, result: resolvedEffect.result, version: reply.version };
      }
      if (resolvedEffect.state === "failed" || resolvedEffect.state === "uncertain") {
        return {
          ok: false,
          error: resolvedEffect.error ?? `Daemon RPC effect ${method} ended in state ${resolvedEffect.state}.`,
          version: reply.version,
        };
      }
    } else if (!("complete" in snapshot) || snapshot.complete !== false) {
      return {
        ok: false,
        error: `Supervisor daemon has no record of async RPC effect ${accepted.effect_id} for generation ${accepted.daemon_generation}.`,
        version: reply.version,
      };
    }
    const noProgress = !initial && snapshot.daemon_generation === afterGen && snapshot.sequence === afterSeq;
    afterGen = snapshot.daemon_generation;
    afterSeq = snapshot.sequence;
    if (noProgress) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
}
