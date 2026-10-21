import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CODEX_OWNER_FEATURE_OVERRIDES, codexOwnerIsolationOverrides } from "../../../../../shared/codex-owner-isolation.mjs";

/**
 * A guest Codex (an agent given to someone else's room) runs with no tool
 * that reaches this Mac: no shell, no image reading, no web, no apps, and none
 * of the owner's MCP servers. Its code work goes through LetAgents' room tools.
 * Read-only's sandbox and sign-in deny stay underneath as a second layer.
 *
 * Found on codex-cli 0.160.1 by pointing Codex at a local fake model server
 * and reading the tools it offers, then confirmed with a real turn on a
 * code-mode model: it could not read a file in the owner's home ("filesystem
 * imports are unsupported; fetch is unavailable").
 */
export const CODEX_GUEST_TOOL_OVERRIDES: readonly string[] = Object.freeze([
  ...CODEX_OWNER_FEATURE_OVERRIDES,
  "features.shell_tool=false",
  "features.view_image=false",
  "features.goals=false",
  "features.multi_agent=false",
  "features.image_generation=false",
  "features.in_app_browser=false",
  "features.js_repl=false",
  'web_search="disabled"',
]);

/**
 * Tools a guest Codex may be offered besides the room's `mcp__letagents__*`
 * tools. Code-mode models get them in namespaces: `functions.exec` runs
 * JavaScript in an isolate with no file or network access, over the nested
 * tools named in its description (checked separately below).
 */
const HARMLESS_TOOLS = new Set([
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "request_user_input",
  "functions.exec", "functions.wait", "functions.request_user_input", "functions.request_user_input_async", "clock.sleep",
]);
const HARMLESS_PREFIXES = ["mcp__letagents__", "collaboration.", "functions.mcp__letagents__"];
/**
 * Tools code mode may nest under `exec`: the room's tools and ones that read
 * nothing on this Mac. An allowlist, so a tool Codex adds later is refused.
 * apply_patch only writes, and Read-only's sandbox refuses every write.
 */
const HARMLESS_NESTED = new Set(["apply_patch", "clock__curr_time", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "request_user_input", "request_user_input_async"]);

export type CodexGuestProbe = { tools: string[]; nestedText: string };

/** The tools code mode nests under `exec`, from the headings that declare them (the description's examples don't count). */
export function nestedCodeModeTools(nestedText: string): string[] {
  return [...nestedText.matchAll(/^###\s+`([^`]+)`/gm)].map(match => match[1]!);
}

export function isGuestCodexToolSet(probe: CodexGuestProbe | string[]): boolean {
  const { tools, nestedText } = Array.isArray(probe) ? { tools: probe, nestedText: "" } : probe;
  if (!tools.length) return false;
  const allowed = tools.every(tool => HARMLESS_TOOLS.has(tool) || HARMLESS_PREFIXES.some(prefix => tool.startsWith(prefix)));
  if (!allowed) return false;
  if (!tools.includes("functions.exec")) return true;
  // Code mode: its nested tools must parse, and every one must be allowed.
  const nested = nestedCodeModeTools(nestedText);
  return nested.length > 0 && nested.every(tool => HARMLESS_NESTED.has(tool) || tool.startsWith("mcp__letagents__"));
}

const PROBE_TIMEOUT_MS = 45_000;

function collect(list: unknown, prefix = ""): { names: string[]; text: string } {
  const names: string[] = []; let text = "";
  for (const tool of Array.isArray(list) ? list as Array<Record<string, unknown>> : []) {
    const name = String(tool.name ?? tool.type ?? "");
    if (Array.isArray(tool.tools)) {
      const inner = collect(tool.tools, `${prefix}${name}.`);
      names.push(...inner.names); text += inner.text;
    } else {
      names.push(`${prefix}${name}`);
      if (`${prefix}${name}` === "functions.exec") text += String(tool.description ?? "");
    }
  }
  return { names, text };
}

/**
 * Ask this Codex, set up exactly like a guest launch (the guest switches and
 * the owner's MCP servers off) and with the agent's own model, which tools it
 * would offer. Codex sends them to a fake model server on loopback, which
 * answers with an error, so no model is called and no quota is used.
 */
export async function probeCodexGuestTools(codexBin: string, env: NodeJS.ProcessEnv, model: string | null = null): Promise<CodexGuestProbe | null> {
  let seen: CodexGuestProbe | null = null;
  const server = http.createServer((req, res) => {
    // Only a real model request counts: POST /v1/responses carrying a tool list.
    const isModelRequest = req.method === "POST" && (req.url ?? "").split("?")[0] === "/v1/responses";
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { tools?: unknown; input?: Array<{ type?: string; tools?: unknown }> };
        const top = collect(parsed.tools);
        const extra = (parsed.input ?? []).filter(item => item?.type === "additional_tools").map(item => collect(item.tools));
        const tools = [...top.names, ...extra.flatMap(part => part.names)];
        if (isModelRequest && tools.length) seen ??= { tools, nestedText: [top.text, ...extra.map(part => part.text)].join("\n") };
      } catch { /* not a model request */ }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "letagents guest tool probe", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const folder = mkdtempSync(join(tmpdir(), "letagents-codex-guest-probe-"));
  try {
    const isolation = await codexOwnerIsolationOverrides(codexBin, { env, cwd: folder, configOverrides: [...CODEX_GUEST_TOOL_OVERRIDES] });
    await new Promise<void>(resolve => {
      // stdin closed: `codex exec` otherwise waits to read more of the prompt from it.
      const child = spawn(codexBin, [
        "exec", "--skip-git-repo-check", "--cd", folder, "-s", "read-only",
        "-c", 'model_provider="letagents_probe"',
        "-c", `model_providers.letagents_probe={name="letagents_probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="LETAGENTS_PROBE_KEY"}`,
        ...(model ? ["-c", `model=${JSON.stringify(model)}`] : []),
        ...[...isolation, ...CODEX_GUEST_TOOL_OVERRIDES].flatMap(override => ["-c", override]),
        "probe",
      ], { env: { ...env, LETAGENTS_PROBE_KEY: "probe" }, stdio: ["ignore", "ignore", "ignore"], detached: process.platform !== "win32" });
      // An npm-installed `codex` is a Node wrapper around the native binary: stop the whole group, not just the wrapper.
      const stopGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ } };
      const timer = setTimeout(() => { stopGroup(); child.kill("SIGKILL"); }, PROBE_TIMEOUT_MS);
      // The wrapper can exit while the native binary keeps running: end what is left of its group.
      child.on("exit", () => { clearTimeout(timer); stopGroup(); resolve(); });
      child.on("error", () => { clearTimeout(timer); resolve(); });
    });
    return seen;
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

const passed = new Map<string, Promise<boolean>>();

function ownerConfigFingerprint(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex");
  try { return createHash("sha256").update(readFileSync(join(home, "config.toml"))).digest("hex"); } catch { return "no-config"; }
}

/** Whether this exact Codex binary, for this model, offers a guest only safe tools. Only a pass is remembered. */
export function codexGuestToolsLocked(codexBin: string, env: NodeJS.ProcessEnv, model: string | null = null,
  probe: typeof probeCodexGuestTools = probeCodexGuestTools): Promise<boolean> {
  let identity = codexBin;
  try { const path = realpathSync(codexBin); const file = statSync(path); identity = `${path}\n${file.size}\n${file.mtimeMs}`; } catch { /* checked by name */ }
  // A pass holds only for the same model and the same owner config (its default model and features).
  identity += `\n${model ?? ""}\n${ownerConfigFingerprint(env)}`;
  let result = passed.get(identity);
  if (!result) {
    result = probe(codexBin, env, model).then(seen => seen !== null && isGuestCodexToolSet(seen)).catch(() => false);
    passed.set(identity, result);
    void result.then(ok => { if (!ok) passed.delete(identity); });
  }
  return result;
}
