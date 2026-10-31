// Slice of the Cursor turn wrapper program (see turn-launcher.ts):
// the supervised agent and control-plane authority proxies, finalize, and
// Statsig temp purges.
// The slices concatenate in order into one script run with `node -e`; keep
// each slice's text exactly as the wrapper needs it.

export function cursorWrapperProxySource(): string {
  return String.raw`function startAgentProxy() {
  if (!restrictRemoteAuthority) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    // One invocation can retry, process background completions, and run native
    // subagents concurrently. Bound held and forwarded streams, not total RPCs.
    let activeRequests = 0;
    const maxActiveRequests = 24;
    function forward(source, headers, downstream, release) {
      const path = headers[":path"] || source.url;
      let upstreamSession;
      try { upstreamSession = http2.connect(supervisedAgentEndpoint); }
      catch { release(); downstream.fail(502); return; }
      agentProxyUpstreamSessions.add(upstreamSession);
      upstreamSession.once("close", () => agentProxyUpstreamSessions.delete(upstreamSession));
      const upstreamHeaders = {
        ":method": "POST",
        ":path": path,
        ":scheme": "https",
        ":authority": "api2.cursor.sh",
        authorization: providerAuthorization,
      };
      for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(":")
          || key === "authorization"
          || key === "connection"
          || key === "host"
          || key === "proxy-connection"
          || key === "transfer-encoding"
          || value === undefined) continue;
        upstreamHeaders[key] = value;
      }
      let upstream;
      try { upstream = upstreamSession.request(upstreamHeaders); }
      catch { release(); downstream.fail(502); upstreamSession.destroy(); return; }
      agentProxyUpstreamStreams.add(upstream);
      upstream.once("close", () => {
        agentProxyUpstreamStreams.delete(upstream);
        release();
      });
      let requestBytes = 0;
      let responseBytes = 0;
      let failed = false;
      function fail(status) {
        if (failed) return;
        failed = true;
        try { upstream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        try { upstreamSession.close(); } catch {}
        downstream.fail(status);
      }
      upstreamSession.once("error", () => fail(502));
      upstream.once("error", () => fail(502));
      source.once("error", () => fail(499));
      source.on("data", (chunk) => {
        if (failed) return;
        requestBytes += chunk.length;
        if (requestBytes > 64 * 1024 * 1024) { fail(413); return; }
        if (!upstream.write(chunk)) {
          source.pause();
          upstream.once("drain", () => source.resume());
        }
      });
      source.once("end", () => { if (!failed) upstream.end(); });
      upstream.once("response", (responseHeaders) => {
        if (failed) return;
        const downstreamHeaders = {};
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (key === "connection" || key === "proxy-connection" || key === "transfer-encoding") continue;
          downstreamHeaders[key] = value;
        }
        try { downstream.respond(downstreamHeaders); } catch { fail(502); }
      });
      upstream.on("data", (chunk) => {
        if (failed) return;
        responseBytes += chunk.length;
        if (responseBytes > 64 * 1024 * 1024) { fail(502); return; }
        if (!downstream.write(chunk)) {
          upstream.pause();
          downstream.onceDrain(() => upstream.resume());
        }
      });
      upstream.once("end", () => {
        if (!failed) downstream.end();
        upstreamSession.close();
      });
      downstream.onceClose(() => {
        try { upstream.close(); } catch {}
        try { upstreamSession.close(); } catch {}
      });
    }
    // New admissions end at this invocation's terminal result, even before
    // native exit retires its already-forwarded streams.
    function requestViolation(method, path, contentType, authorization) {
      return finalizing
        || authorityRetiring
        || resultSnapshot !== null
        || authorization !== expectedProxyAuthorization
        || method !== "POST"
        || path !== "/agent.v1.AgentService/Run"
        || typeof contentType !== "string"
        || !/^application\/connect[+]proto(?:\s*;|$)/i.test(contentType.trim());
    }
    // Requests can race ahead of live MCP attestation. Reserve a bounded slot
    // while awaiting its signal; release it on cancellation or upstream close.
    function admitRequest(method, path, contentType, authorization) {
      if (requestViolation(method, path, contentType, authorization) || activeRequests >= maxActiveRequests) {
        return { promise: Promise.resolve(false), cancel() {} };
      }
      activeRequests += 1;
      let released = false;
      let resolveAdmit;
      let waiter = null;
      function cancel() {
        if (released) return;
        released = true;
        activeRequests -= 1;
        if (waiter && mcpCapabilityWaiters.delete(waiter)) resolveAdmit(false);
      }
      if (mcpCapabilityAttested) return { promise: Promise.resolve(true), cancel };
      const promise = new Promise((resolve) => { resolveAdmit = resolve; });
      waiter = (attested) => {
        if (released || !attested || requestViolation(method, path, contentType, authorization)) {
          cancel();
          resolveAdmit(false);
          return;
        }
        resolveAdmit(true);
      };
      mcpCapabilityWaiters.add(waiter);
      return { promise, cancel };
    }
    const h2Server = http2.createServer({ settings: { maxHeaderListSize: 64 * 1024 } });
    agentProxyInternalServers.add(h2Server);
    h2Server.once("close", () => {
      agentProxyInternalServers.delete(h2Server);
      if (!settled && (finalizing || authorityRetiring)) failStart(new Error("Cursor agent proxy startup was cancelled."));
    });
    h2Server.on("connection", (socket) => {
      if (finalizing || authorityRetiring) { socket.destroy(); return; }
      agentProxySockets.add(socket);
      socket.once("close", () => agentProxySockets.delete(socket));
    });
    h2Server.on("session", (session) => {
      if (finalizing || authorityRetiring) { session.destroy(); return; }
      agentProxySessions.add(session);
      session.once("close", () => agentProxySessions.delete(session));
    });
    h2Server.on("stream", (stream, headers) => {
      const admission = admitRequest(headers[":method"], headers[":path"], headers["content-type"], headers.authorization);
      const onClosed = () => admission.cancel();
      stream.once("close", onClosed);
      void admission.promise.then((allowed) => {
        stream.removeListener("close", onClosed);
        if (!allowed || requestViolation(headers[":method"], headers[":path"], headers["content-type"], headers.authorization)) {
          admission.cancel();
          try { stream.respond({ ":status": 503, "cache-control": "no-store" }); } catch {}
          try { stream.end("Cursor agent proxy rejected the request."); } catch {}
          return;
        }
        if (stream.destroyed || stream.closed) { admission.cancel(); return; }
        forward(stream, headers, {
          respond: (value) => stream.respond(value),
          fail: (status) => {
            try { if (!stream.headersSent) stream.respond({ ":status": status }); } catch {}
            try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
          },
          write: (chunk) => stream.write(chunk),
          end: () => stream.end(),
          onceDrain: (listener) => stream.once("drain", listener),
          onceClose: (listener) => stream.once("close", listener),
        }, admission.cancel);
      });
    });
    h2Server.on("sessionError", () => {});
    const h1Server = http.createServer((request, response) => {
      const admission = admitRequest(request.method, request.url, request.headers["content-type"], request.headers.authorization);
      const onClosed = () => admission.cancel();
      response.once("close", onClosed);
      void admission.promise.then((allowed) => {
        response.removeListener("close", onClosed);
        if (!allowed || requestViolation(request.method, request.url, request.headers["content-type"], request.headers.authorization)) {
          admission.cancel();
          request.resume();
          try {
            response.writeHead(503, { "cache-control": "no-store", "connection": "close" });
            response.end("Cursor agent proxy rejected the request.");
          } catch {}
          return;
        }
        if (response.writableEnded || response.destroyed) { admission.cancel(); request.resume(); return; }
        forward(request, request.headers, {
          respond: (value) => {
            const status = Number(value[":status"] || 502);
            const headers = {};
            for (const [key, entry] of Object.entries(value)) {
              if (!key.startsWith(":") && key !== "connection" && key !== "transfer-encoding") headers[key] = entry;
            }
            response.writeHead(status, headers);
          },
          fail: (status) => {
            try { if (!response.headersSent) response.writeHead(status, { "connection": "close" }); } catch {}
            response.destroy();
          },
          write: (chunk) => response.write(chunk),
          end: () => response.end(),
          onceDrain: (listener) => response.once("drain", listener),
          onceClose: (listener) => response.once("close", listener),
        }, admission.cancel);
      });
    });
    agentProxyInternalServers.add(h1Server);
    h1Server.once("close", () => {
      agentProxyInternalServers.delete(h1Server);
      if (!settled && (finalizing || authorityRetiring)) failStart(new Error("Cursor agent proxy startup was cancelled."));
    });
    h1Server.on("connection", (socket) => {
      if (finalizing || authorityRetiring) { socket.destroy(); return; }
      agentProxySockets.add(socket);
      socket.once("close", () => agentProxySockets.delete(socket));
    });
    h1Server.on("clientError", (_error, socket) => { try { socket.destroy(); } catch {} });
    const h2Preface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
    let h2Port = null;
    let h1Port = null;
    let internalReady = 0;
    let settled = false;
    function failStart(error) {
      if (settled) return;
      settled = true;
      void closeAuthorityProxy();
      reject(error);
    }
    function internalListening(server, protocol) {
      if (finalizing || authorityRetiring) {
        failStart(new Error("Cursor agent proxy startup was cancelled."));
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") { failStart(new Error("Cursor internal agent proxy did not expose a loopback port.")); return; }
      if (protocol === "h2") h2Port = address.port;
      else h1Port = address.port;
      internalReady += 1;
      if (internalReady !== 2) return;
      const mux = net.createServer((socket) => {
        if (finalizing || authorityRetiring || agentProxySockets.size >= 24) { socket.destroy(); return; }
        agentProxySockets.add(socket);
        socket.once("close", () => agentProxySockets.delete(socket));
        socket.setTimeout(5000, () => socket.destroy());
        let probe = Buffer.alloc(0);
        function inspect(chunk) {
          probe = Buffer.concat([probe, chunk]);
          const prefixLength = Math.min(probe.length, h2Preface.length);
          const couldBeH2 = probe.subarray(0, prefixLength).equals(h2Preface.subarray(0, prefixLength));
          if (couldBeH2 && probe.length < h2Preface.length) return;
          socket.removeListener("data", inspect);
          socket.pause();
          socket.setTimeout(0);
          const routed = net.connect({ host: "127.0.0.1", port: couldBeH2 ? h2Port : h1Port });
          agentProxySockets.add(routed);
          routed.once("close", () => agentProxySockets.delete(routed));
          routed.once("error", () => socket.destroy());
          socket.once("error", () => routed.destroy());
          routed.once("connect", () => {
            if (finalizing || authorityRetiring) { routed.destroy(); socket.destroy(); return; }
            routed.write(probe);
            socket.pipe(routed);
            routed.pipe(socket);
            socket.resume();
          });
        }
        socket.on("data", inspect);
      });
      agentProxy = mux;
      mux.once("close", () => {
        if (!settled && (finalizing || authorityRetiring)) failStart(new Error("Cursor agent proxy startup was cancelled."));
      });
      mux.once("error", failStart);
      mux.listen({ host: "127.0.0.1", port: 0, exclusive: true }, async () => {
        await waitAtTestStartupBarrier("agent_listen");
        if (settled) { try { mux.close(); } catch {} return; }
        if (finalizing || authorityRetiring) {
          try { mux.close(); } catch {}
          failStart(new Error("Cursor agent proxy startup was cancelled."));
          return;
        }
        settled = true;
        mux.removeListener("error", failStart);
        mux.on("error", (error) => {
          const detail = "Cursor agent proxy failed: " + (error && error.message ? error.message : String(error));
          if (!native) { void finishNotStarted(detail); return; }
          if (!exitEvidence) exitEvidence = { type: "error", error: detail };
          exitCode = 1;
          void beginFatalReaping();
        });
        const address = mux.address();
        if (!address || typeof address === "string") {
          void closeAuthorityProxy();
          reject(new Error("Cursor agent proxy did not expose a loopback port."));
          return;
        }
        resolve(address.port);
      });
    }
    h2Server.once("error", failStart);
    h1Server.once("error", failStart);
    h2Server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      if (finalizing || authorityRetiring) { failStart(new Error("Cursor agent proxy startup was cancelled.")); return; }
      h2Server.removeListener("error", failStart);
      internalListening(h2Server, "h2");
    });
    h1Server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      if (finalizing || authorityRetiring) { failStart(new Error("Cursor agent proxy startup was cancelled.")); return; }
      h1Server.removeListener("error", failStart);
      internalListening(h1Server, "h1");
    });
  });
}
function startAuthorityProxy() {
  if (!restrictRemoteAuthority) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const server = http.createServer((request, response) => {
      if (finalizing || authorityRetiring) { request.destroy(); response.destroy(); return; }
      const requestPath = typeof request.url === "string" ? request.url : "";
      if (request.headers.authorization !== expectedProxyAuthorization
        || request.method !== "POST" || !supervisedControlPlanePaths.has(requestPath)) {
        denyControlPlaneRequest(request, response);
        return;
      }
      const contentLengthHeader = request.headers["content-length"];
      const transferEncoding = request.headers["transfer-encoding"];
      const contentLength = typeof contentLengthHeader === "string" && /^\d{1,7}$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : -1;
      if (transferEncoding !== undefined
        || !Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > 1024 * 1024) {
        denyControlPlaneRequest(request, response);
        return;
      }
      const headers = {
        ...request.headers,
        host: "api2.cursor.sh",
        authorization: providerAuthorization,
      };
      delete headers.connection;
      delete headers["proxy-connection"];
      delete headers.upgrade;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      const controlPlaneUrl = new URL(requestPath, supervisedControlPlaneEndpoint);
      const controlPlaneClient = controlPlaneUrl.protocol === "https:" ? https : http;
      const upstream = controlPlaneClient.request({
        protocol: controlPlaneUrl.protocol,
        hostname: controlPlaneUrl.hostname,
        port: controlPlaneUrl.port || (controlPlaneUrl.protocol === "https:" ? 443 : 80),
        method: "POST",
        path: requestPath,
        headers,
        ...(controlPlaneUrl.protocol === "https:" ? { servername: "api2.cursor.sh" } : {}),
        timeout: 15000,
        agent: false,
      }, (upstreamResponse) => {
        authorityProxyUpstreams.add(upstreamResponse);
        upstreamResponse.once("close", () => authorityProxyUpstreams.delete(upstreamResponse));
        const responseHeaders = {
          ...upstreamResponse.headers,
        };
        delete responseHeaders.connection;
        delete responseHeaders["proxy-connection"];
        delete responseHeaders.upgrade;
        delete responseHeaders["keep-alive"];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      authorityProxyUpstreams.add(upstream);
      upstream.once("close", () => authorityProxyUpstreams.delete(upstream));
      upstream.once("timeout", () => upstream.destroy(new Error("Cursor control-plane request timed out.")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { "connection": "close" });
        response.end();
      });
      request.once("aborted", () => upstream.destroy());
      let receivedBytes = 0;
      let requestOverflow = false;
      request.on("data", (chunk) => {
        if (requestOverflow) return;
        receivedBytes += chunk.length;
        if (receivedBytes > 1024 * 1024) {
          requestOverflow = true;
          upstream.destroy();
          if (!response.headersSent) response.writeHead(413, { "connection": "close" });
          response.end();
          request.resume();
          return;
        }
        if (!upstream.write(chunk)) {
          request.pause();
          upstream.once("drain", () => request.resume());
        }
      });
      request.once("end", () => { if (!requestOverflow) upstream.end(); });
      request.once("error", () => upstream.destroy());
    });
    server.on("connection", (socket) => {
      if (finalizing || authorityRetiring || authorityProxySockets.size >= 8) { socket.destroy(); return; }
      authorityProxySockets.add(socket);
      socket.once("close", () => authorityProxySockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
    });
    server.maxHeadersCount = 64;
    server.headersTimeout = 5000;
    server.requestTimeout = 20000;
    server.keepAliveTimeout = 1000;
    authorityProxy = server;
    server.once("error", failStart);
    server.once("close", () => {
      if (!settled && (finalizing || authorityRetiring)) {
        failStart(new Error("Cursor authority proxy startup was cancelled."));
      }
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, async () => {
      await waitAtTestStartupBarrier("authority_listen");
      if (finalizing || authorityRetiring) {
        try { server.close(); } catch {}
        failStart(new Error("Cursor authority proxy startup was cancelled."));
        return;
      }
      server.removeListener("error", failStart);
      const address = server.address();
      if (!address || typeof address === "string") {
        closeAuthorityProxy();
        failStart(new Error("Cursor authority proxy did not expose a loopback port."));
        return;
      }
      settled = true;
      server.on("error", (error) => {
        const detail = "Cursor authority proxy failed: " + (error && error.message ? error.message : String(error));
        if (!native) {
          finishNotStarted(detail);
          return;
        }
        if (!exitEvidence) {
          exitEvidence = { type: "error", error: detail };
        }
        exitCode = 1;
        void beginFatalReaping();
      });
      resolve(address.port);
    });
  });
}
async function finalize() {
  if (finalizing) return;
  finalizing = true;
  if (evidenceDrainTimer) { clearTimeout(evidenceDrainTimer); evidenceDrainTimer = null; }
  const { proxyAuthorityRevoked, mcpAuthorityRevoked } = await beginTurnAuthorityRetirement();
  const nativeGroupReaped = await beginReaping();
  const runtimeDataRetired = retireTurnRuntimeData();
  const remoteAuthorityRevoked = proxyAuthorityRevoked && mcpAuthorityRevoked && runtimeDataRetired;
  if (!remoteAuthorityRevoked) exitCode = 1;
  try { purgePublicPlaceholderCredentialFile(); }
  catch {
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: "Cursor's public credential placeholder could not be purged safely." };
    }
    exitCode = 1;
    streamContractComplete = false;
  }
  flushParser();
  try { purgeStatsigTemporaryFiles(); }
  catch (error) {
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: "Cursor Statsig temporary state could not be purged." };
    }
    exitCode = 1;
    streamContractComplete = false;
  }
  if (stateFd !== null) { try { closeSync(stateFd); } catch {} stateFd = null; }
  try {
    terminal({
      ...(exitEvidence || { type: "error", error: "Cursor wrapper closed without native exit evidence." }),
      native_process_group_reaped: nativeGroupReaped,
      reap_scope: "native_process_group",
      remote_authority_revoked: remoteAuthorityRevoked,
      remote_authority_failed_checks: [...revocationFailures],
      turn_contract_version: 1,
      session_contract_valid: sessionContractValid,
      stream_contract_complete: streamContractComplete,
      workspace_generation_manifest_path: workspaceGenerationManifestPath || null,
      init: initSnapshot,
      result: resultSnapshot,
    });
  } catch {}
  process.exit(exitCode);
}
function purgeStatsigTemporaryFiles() {
  const configDir = process.env.CURSOR_CONFIG_DIR;
  if (!configDir) return;
  const stat = lstatSync(configDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("redirected config");
  const directory = opendirSync(configDir);
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > 4096) throw new Error("too many config entries");
      if (!/^statsig-cache[.]json[.][1-9][0-9]{0,9}[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]tmp$/i.test(entry.name)) continue;
      const path = configDir + "/" + entry.name;
      const entryStat = lstatSync(path);
      if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) throw new Error("Statsig temp is a directory");
      unlinkSync(path);
    }
  } finally { directory.closeSync(); }
}
`;
}
