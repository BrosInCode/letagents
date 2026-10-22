import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Platform facts the MCP test suites share. The suites run on Windows in CI;
// what cannot run there is skipped through these constants, in one place,
// with the reason beside it.

/**
 * Skip reason for a test that listens on a Unix domain socket. The desktop
 * daemon's control socket is a Unix socket; Windows named pipes are a later
 * tier of the port, and the standalone MCP server never listens itself. On
 * Windows, `listen(<file path>)` fails with EACCES.
 */
export const unixSocketOnly = process.platform === "win32"
  ? "the desktop supervisor bridge uses a Unix socket; Windows named pipes are tier 3"
  : false;

/** Skip reason for a test that freezes a process with SIGSTOP, which Windows does not have. */
export const posixSignalsOnly = process.platform === "win32"
  ? "freezes the server with SIGSTOP and SIGCONT, which Windows does not have"
  : false;

// Node on Windows needs these to start (DLL search, Winsock), find its temp
// directory and its home, and run `.cmd` launchers.
const windowsSystemVariables = [
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "PUBLIC",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "USERNAME", "USERDOMAIN",
];

/**
 * The environment for a spawned Node process that must see only what a test
 * gives it: PATH, the variables Windows itself needs, and `variables`. A child
 * started with PATH alone exits at once on Windows.
 */
export function childProcessEnv(variables: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", ...(process.platform === "win32" ? windowsSystemVariables : [])]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...variables };
}

/**
 * Connects a client to a spawned MCP server. When the server exits before it
 * answers, the SDK reports only "Connection closed"; this keeps what the
 * server wrote to stderr and puts it in the error, so a start-up failure on
 * another platform names its cause.
 */
export async function connectOrExplain(client: Client, transport: StdioClientTransport): Promise<void> {
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await client.connect(transport);
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nserver stderr:\n${detail}` : " (the server wrote nothing to stderr)"}`, { cause: error });
  }
}
