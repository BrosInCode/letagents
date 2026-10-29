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
    // On Windows the pattern is built for the backslash temporary folder at the call.
    const pattern = new RegExp(setup.cursorMcpConnectorRootPattern(windowsTemp));
    assert.equal(pattern.test(`${windowsTemp}\\letagents-cursor-mcp-01234567-89ab-cdef-0123-456789abcdef`), true);
    assert.equal(pattern.test(`${windowsTemp}\\other-01234567-89ab-cdef-0123-456789abcdef`), false);
    // The macOS sandbox escape still refuses that parent.
    assert.throws(() => setup.cursorMcpConnectorRootPattern(windowsTemp, "darwin"), /unsupported characters/);
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
