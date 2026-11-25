import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const argv = process.argv.slice(2);
const realBin = process.env.LETAGENTS_REAL_CODEX_BIN;
const captureFile = process.env.LETAGENTS_CODEX_CAPTURE_FILE;
if (!realBin || !captureFile) {
  process.stderr.write("LETAGENTS_REAL_CODEX_BIN and LETAGENTS_CODEX_CAPTURE_FILE are required.\n");
  process.exit(2);
}

function parseListenUrl(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--listen" && args[i + 1]) return args[i + 1];
  }
  return null;
}

const listenArg = argv[0] === "app-server" ? parseListenUrl(argv) : null;

// Pass non-WebSocket invocations (`mcp list`, `app-server --listen stdio://`) straight through to real codex.
if (!listenArg || !listenArg.startsWith("ws://")) {
  const passthrough = spawn(realBin, argv, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  passthrough.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  // Keep alive until passthrough exits.
  await new Promise(() => {});
}

mkdirSync(dirname(captureFile), { recursive: true });
function recordEntry(entry) {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const proxyUrl = new URL(listenArg);
const hostname = proxyUrl.hostname || "127.0.0.1";
const proxyPort = Number(proxyUrl.port);
const realPort = await allocatePort();
const realWsUrl = `ws://127.0.0.1:${realPort}`;

const realArgs = argv.map((arg, idx) => (idx > 0 && argv[idx - 1] === "--listen" ? realWsUrl : arg));
const child = spawn(realBin, realArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  if (process.env.LETAGENTS_RECORD_DEBUG === "1") process.stderr.write(`[codex stdout] ${chunk}`);
});
child.stderr.on("data", (chunk) => {
  if (process.env.LETAGENTS_RECORD_DEBUG === "1") process.stderr.write(`[codex stderr] ${chunk}`);
});

let exitRecorded = false;
function finalizeExit(requested, code, signal) {
  if (exitRecorded) return;
  exitRecorded = true;
  recordEntry({
    type: "runtime_exit",
    requested,
    transportClosedBeforeExit: false,
    code,
    signal,
  });
}

child.on("exit", (code, signal) => {
  finalizeExit(false, code, signal);
  process.exit(code ?? 0);
});

const httpServer = createServer((req, res) => {
  const upstream = httpRequest(
    { hostname: "127.0.0.1", port: realPort, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 200, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (clientWs) => {
  const upstreamWs = new WebSocket(realWsUrl);
  const pendingFromClient = [];
  const outboundMethodsById = new Map();
  const serverRequestMethodsById = new Map();

  upstreamWs.on("open", () => {
    for (const raw of pendingFromClient.splice(0)) upstreamWs.send(raw);
  });

  clientWs.on("message", (data) => {
    const text = String(data);
    try {
      const frame = JSON.parse(text);
      let label = frame.method ? String(frame.method) : "response";
      if (frame.method && frame.id !== undefined) {
        outboundMethodsById.set(frame.id, String(frame.method));
      } else if (frame.method === undefined && frame.id !== undefined && serverRequestMethodsById.has(frame.id)) {
        label = `reply:${serverRequestMethodsById.get(frame.id)}`;
      }
      recordEntry({ type: "expect_outbound", label, frame });
    } catch { /* forward raw */ }
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(text);
    else pendingFromClient.push(text);
  });

  upstreamWs.on("message", (data) => {
    const text = String(data);
    try {
      const frame = JSON.parse(text);
      let label = frame.method ? String(frame.method) : "response";
      if (frame.method && frame.id !== undefined) {
        serverRequestMethodsById.set(frame.id, String(frame.method));
      } else if (frame.method === undefined && frame.id !== undefined && outboundMethodsById.has(frame.id)) {
        label = outboundMethodsById.get(frame.id);
      }
      recordEntry({ type: "emit_inbound", label, frame });
    } catch { /* forward raw */ }
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(text);
  });

  clientWs.on("close", () => {
    if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
      upstreamWs.close();
    }
  });
  upstreamWs.on("close", () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });
});

httpServer.listen(proxyPort, hostname);

function shutdown(signal) {
  finalizeExit(true, 0, signal);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  wss.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    process.exit(0);
  }, 1_500).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("exit", () => {
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
});
