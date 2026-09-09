import { spawn } from "node:child_process";

/** Read the installed CLI's effective configuration without starting a thread. */
export function validateCodexDefaultModel(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const unable = `Could not verify the default model for Codex at '${input.command}'. Update that Codex installation or choose an explicit model in agent settings, then try again.`;
  return new Promise((resolve) => {
    const child = spawn(input.command, ["app-server", "--listen", "stdio://"], {
      cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let finished = false;
    let outcome: string | null = unable;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let buffer = "";
    let bytes = 0;
    let requestId = 0;
    let phase: "initialize" | "config" | "models" = "initialize";
    let configuredModel: string | null = null;
    let defaultModel: string | null = null;
    const models = new Set<string>();
    const cursors = new Set<string>();
    const deadline = setTimeout(() => finish(unable), input.timeoutMs ?? 10_000);

    function finish(error: string | null) {
      if (finished) return;
      finished = true;
      outcome = error;
      clearTimeout(deadline);
      child.stdin.end();
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }

    function send(method: string, params: unknown) {
      child.stdin.write(`${JSON.stringify({ id: ++requestId, method, params })}\n`);
    }

    child.once("error", () => finish(unable));
    child.stdin.on("error", () => finish(unable));
    child.stderr.resume();
    child.once("close", () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      resolve(finished ? outcome : unable);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { finish(unable); return; }
      buffer += chunk;
      let newline: number;
      while (!finished && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let response: Record<string, any>;
        try { response = JSON.parse(line); } catch { finish(unable); return; }
        if (!response || response.id !== requestId) continue;
        if (response.error || !response.result || typeof response.result !== "object") {
          finish(unable); return;
        }
        const result = response.result;
        if (phase === "initialize") {
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          phase = "config";
          send("config/read", { includeLayers: false, ...(input.cwd ? { cwd: input.cwd } : {}) });
        } else if (phase === "config") {
          const config = result.config;
          if (!config || typeof config !== "object") { finish(unable); return; }
          // A custom provider owns its model namespace. Preserve pass-through
          // defaults there instead of comparing them with OpenAI's catalog.
          if (config.model_provider && config.model_provider !== "openai") { finish(null); return; }
          configuredModel = typeof config.model === "string" ? config.model.trim() || null : null;
          phase = "models";
          send("model/list", { includeHidden: true, limit: 100 });
        } else {
          if (!Array.isArray(result.data)) { finish(unable); return; }
          for (const model of result.data) {
            if (typeof model?.model !== "string" || !model.model.trim()) continue;
            models.add(model.model);
            if (model.isDefault === true) defaultModel = model.model;
          }
          if (result.nextCursor) {
            if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor) || cursors.size >= 10) {
              finish(unable); return;
            }
            cursors.add(result.nextCursor);
            send("model/list", { includeHidden: true, limit: 100, cursor: result.nextCursor });
            continue;
          }
          const effectiveModel = configuredModel ?? defaultModel;
          if (!models.size || !effectiveModel) { finish(unable); return; }
          finish(models.has(effectiveModel) ? null
            : `Default Codex model '${effectiveModel}' is not available in the Codex installation at '${input.command}'. Update that installation or select a supported model in agent settings.`);
        }
      }
    });
    send("initialize", {
      clientInfo: { name: "letagents-model-preflight", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
  });
}
