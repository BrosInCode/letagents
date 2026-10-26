/** The text npm's cmd-shim writes for a `#!/usr/bin/env node` bin, byte for byte. */
export function npmShim(relativeScript: string, shebangArgs = ""): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${shebangArgs} "%dp0%\\${relativeScript}" %*`,
    "",
  ].join("\r\n");
}
