import assert from "node:assert/strict";
import * as os from "node:os";
import { mock, test } from "node:test";

// Reproduces the Windows condition that broke module loading: the platform is
// win32 and the per-user temporary folder is a `C:\...` path. Loading the Cursor
// wrapper module (imported indirectly by the supervisor daemon client and many
// other main-process modules) must not throw; the connector pattern is only
// built when a wrapper program is assembled.
test("the Cursor wrapper module loads on Windows with a backslash temporary folder", async () => {
  const windowsTemp = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
  mock.module("node:os", { namedExports: { ...os, tmpdir: () => windowsTemp }, defaultExport: { ...os, tmpdir: () => windowsTemp } });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const constants = await import("../main/agents/cursor-provider-constants.js");
    assert.equal(constants.CURSOR_MCP_CONNECTOR_PARENT, windowsTemp);
    const setup = await import("../main/agents/cursor/turn-wrapper-setup.js");
    assert.equal(typeof setup.cursorWrapperSetupSource, "function");
    // Building the pattern for a Windows parent is still refused, at the call, with the explicit error.
    assert.throws(() => setup.cursorMcpConnectorRootPattern(windowsTemp), /unsupported characters/);
  } finally {
    Object.defineProperty(process, "platform", platform);
    mock.restoreAll();
  }
});

test("the macOS connector pattern is unchanged", async () => {
  const { cursorMcpConnectorRootPattern } = await import("../main/agents/cursor/turn-wrapper-setup.js");
  assert.equal(
    cursorMcpConnectorRootPattern("/tmp"),
    "^/tmp/letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  );
});
