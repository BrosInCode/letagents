import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const realBin = process.env.LETAGENTS_REAL_OPENCODE_BIN;
const captureFile = process.env.LETAGENTS_OPENCODE_CAPTURE_FILE;
if (!realBin || !captureFile) {
  process.stderr.write("LETAGENTS_REAL_OPENCODE_BIN and LETAGENTS_OPENCODE_CAPTURE_FILE are required.\n");
  process.exit(2);
}

mkdirSync(dirname(captureFile), { recursive: true });
function recordEntry(entry) {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`, "utf8");
}

let hostname = "127.0.0.1";
let proxyPort = 0;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--hostname" && argv[i + 1]) {
    hostname = argv[i + 1];
    i += 1;
  } else if (argv[i] === "--port" && argv[i + 1]) {
    proxyPort = Number(argv[i + 1]);
    i += 1;
  }
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

function readBodyBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const realPort = await allocatePort();
const realArgs = argv.map((arg, idx) => (idx > 0 && argv[idx - 1] === "--port" ? String(realPort) : arg));

const child = spawn(realBin, realArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  if (process.env.LETAGENTS_RECORD_DEBUG === "1") process.stderr.write(`[opencode stdout] ${chunk}`);
});
child.stderr.on("data", (chunk) => {
  if (process.env.LETAGENTS_RECORD_DEBUG === "1") process.stderr.write(`[opencode stderr] ${chunk}`);
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

const seenSseIds = new Set();

const proxy = createServer(async (req, res) => {
  const reqBodyBuf = await readBodyBuffer(req);
  const reqBodyText = reqBodyBuf.toString("utf8");
  const urlPath = req.url || "/";
  const method = req.method || "GET";
  let reqBodyJson = null;
  if (reqBodyText.trim()) {
    try { reqBodyJson = JSON.parse(reqBodyText); } catch { reqBodyJson = reqBodyText; }
  }

  const isEventStream = method === "GET" && urlPath.split("?")[0] === "/event";
  if (!isEventStream) {
    recordEntry({
      type: "expect_outbound",
      label: `${method} ${urlPath.split("?")[0]}`,
      frame: {
        method,
        path: urlPath,
        ...(reqBodyJson !== null ? { body: reqBodyJson } : {}),
      },
    });
  }

  const upstreamHeaders = { ...req.headers, host: `${hostname}:${realPort}` };
  delete upstreamHeaders["content-length"];
  delete upstreamHeaders["accept-encoding"];
  if (reqBodyBuf.length > 0) {
    upstreamHeaders["content-length"] = String(reqBodyBuf.length);
  }

  const upstream = httpRequest(
    {
      hostname,
      port: realPort,
      path: urlPath,
      method,
      headers: upstreamHeaders,
    },
    async (upRes) => {
      if (isEventStream) {
        const sseHeaders = { ...upRes.headers };
        delete sseHeaders["transfer-encoding"];
        delete sseHeaders["connection"];
        res.writeHead(upRes.statusCode || 200, sseHeaders);
        res.flushHeaders?.();
        let sseBuffer = "";
        upRes.on("data", (chunk) => {
          res.write(chunk);
          sseBuffer += chunk.toString("utf8");
          let sep = sseBuffer.search(/\r?\n\r?\n/);
          while (sep >= 0) {
            const block = sseBuffer.slice(0, sep);
            const match = sseBuffer.slice(sep).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
            sseBuffer = sseBuffer.slice(sep + match.length);
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data && data !== "[DONE]") {
              try {
                const parsed = JSON.parse(data);
                // Deduplicate identical SSE frames emitted simultaneously to multiple daemon event streams.
                const dedupKey = JSON.stringify(parsed);
                if (parsed.type !== "server.connected" && parsed.type !== "server.heartbeat" && !seenSseIds.has(dedupKey)) {
                  seenSseIds.add(dedupKey);
                  recordEntry({
                    type: "emit_inbound",
                    label: String(parsed.type || "sse_event"),
                    frame: { kind: "sse", event: parsed },
                  });
                }
              } catch {
                // Ignore non-JSON SSE comments.
              }
            }
            sep = sseBuffer.search(/\r?\n\r?\n/);
          }
        });
        upRes.on("end", () => res.end());
        req.on("close", () => upstream.destroy());
        return;
      }

      const resBodyBuf = await readBodyBuffer(upRes);
      const resBodyText = resBodyBuf.toString("utf8");
      let resBodyJson = null;
      if (resBodyText.trim()) {
        try { resBodyJson = JSON.parse(resBodyText); } catch { resBodyJson = resBodyText; }
      }
      recordEntry({
        type: "emit_inbound",
        label: `response:${method} ${urlPath.split("?")[0]}`,
        frame: {
          kind: "http",
          method,
          path: urlPath,
          status: upRes.statusCode || 200,
          body: resBodyJson,
        },
      });
      const outHeaders = { ...upRes.headers };
      delete outHeaders["transfer-encoding"];
      delete outHeaders["connection"];
      delete outHeaders["content-encoding"];
      outHeaders["content-length"] = String(resBodyBuf.length);
      res.writeHead(upRes.statusCode || 200, outHeaders);
      res.end(resBodyBuf);
    },
  );

  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_unavailable" }));
    }
  });
  if (reqBodyBuf.length > 0) upstream.write(reqBodyBuf);
  upstream.end();
});

proxy.listen(proxyPort, hostname);

function shutdown(signal) {
  finalizeExit(true, 0, signal);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  proxy.close(() => process.exit(0));
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
