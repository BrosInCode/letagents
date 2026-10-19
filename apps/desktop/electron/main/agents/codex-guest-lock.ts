import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
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
/** Nested tools that would reach this Mac from inside code mode. */
const FORBIDDEN_NESTED = ["exec_command", "write_stdin", "view_image", "web_search", "shell", "node_repl", "computer_use", "browser"];

export type CodexGuestProbe = { tools: string[]; nestedText: string };

/** The tools code mode nests under `exec`, from the headings that declare them (the description's examples don't count). */
export function nestedCodeModeTools(nestedText: string): string[] {
  return [...nestedText.matchAll(/^###\s+`([^`]+)`/gm)].map(match => match[1]!);
}

export function isGuestCodexToolSet(probe: CodexGuestProbe | string[]): boolean {
  const { tools, nestedText } = Array.isArray(probe) ? { tools: probe, nestedText: "" } : probe;
  const allowed = tools.every(tool => HARMLESS_TOOLS.has(tool) || HARMLESS_PREFIXES.some(prefix => tool.startsWith(prefix)));
  return allowed && !nestedCodeModeTools(nestedText).some(tool => FORBIDDEN_NESTED.some(name => tool.includes(name)));
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
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { tools?: unknown; input?: Array<{ type?: string; tools?: unknown }> };
        const top = collect(parsed.tools);
        const extra = (parsed.input ?? []).filter(item => item?.type === "additional_tools").map(item => collect(item.tools));
        seen ??= { tools: [...top.names, ...extra.flatMap(part => part.names)], nestedText: [top.text, ...extra.map(part => part.text)].join("\n") };
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
      ], { env: { ...env, LETAGENTS_PROBE_KEY: "probe" }, stdio: ["ignore", "ignore", "ignore"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
      child.on("error", () => { clearTimeout(timer); resolve(); });
    });
    return seen;
  } finally {
    server.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

const passed = new Map<string, Promise<boolean>>();

/** Whether this exact Codex binary, for this model, offers a guest only safe tools. Only a pass is remembered. */
export function codexGuestToolsLocked(codexBin: string, env: NodeJS.ProcessEnv, model: string | null = null,
  probe: typeof probeCodexGuestTools = probeCodexGuestTools): Promise<boolean> {
  let identity = codexBin;
  try { const path = realpathSync(codexBin); const file = statSync(path); identity = `${path}\n${file.size}\n${file.mtimeMs}`; } catch { /* checked by name */ }
  identity += `\n${model ?? ""}`;
  let result = passed.get(identity);
  if (!result) {
    result = probe(codexBin, env, model).then(seen => seen !== null && isGuestCodexToolSet(seen)).catch(() => false);
    passed.set(identity, result);
    void result.then(ok => { if (!ok) passed.delete(identity); });
  }
  return result;
}
