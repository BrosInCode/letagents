import { findListeningPorts } from "./language-server.mjs";

export function connectJsonHeaders(csrf) {
  return {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    "x-codeium-csrf-token": csrf,
  };
}

export async function unary(baseUrl, csrf, method, body) {
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: connectJsonHeaders(csrf),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, text, parsed };
}

export async function findLsBaseUrl(pid, csrf, log) {
  const ports = findListeningPorts(pid);
  for (const port of ports) {
    for (const baseUrl of [
      `http://127.0.0.1:${port}`,
      `https://127.0.0.1:${port}`,
    ]) {
      try {
        const probe = await fetch(
          `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
          {
            method: "POST",
            headers: connectJsonHeaders(csrf),
            body: "{}",
            signal: AbortSignal.timeout(3000),
          },
        );
        if (probe.ok) {
          log?.(`Resolved LS api=${baseUrl}`);
          return baseUrl;
        }
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(`Could not find working LanguageServerService port for pid=${pid}`);
}

export function connectEncodeJsonMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function decodeConnectFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const len = buf.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + len;
    if (end > buf.length) break;
    frames.push({ flags, payload: buf.slice(start, end) });
    offset = end;
  }
  return { frames, consumed: offset, rest: buf.subarray(offset) };
}

/**
 * Keep a Connect server-stream open while `work()` runs (UI-style subscriber).
 * `work` should include polling for results while the stream stays connected.
 */
export async function withOpenConnectStream(
  baseUrl,
  csrf,
  method,
  requestObj,
  work,
  timeoutMs,
  tailMs,
  log,
) {
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
  const body = connectEncodeJsonMessage(requestObj);
  const ac = new AbortController();
  const hardStop = setTimeout(() => ac.abort(), timeoutMs);
  const collected = [];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      return { status: res.status, error: "no body", collected, workResult: null };
    }
    let buf = Buffer.alloc(0);
    const reader = res.body.getReader();
    let readErr = null;
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            buf = Buffer.concat([buf, Buffer.from(value)]);
            const { frames, rest } = decodeConnectFrames(buf);
            buf = Buffer.from(rest);
            for (const f of frames) {
              const s = f.payload.toString("utf8");
              try {
                collected.push({ flags: f.flags, json: JSON.parse(s) });
              } catch {
                collected.push({ flags: f.flags, raw: s.slice(0, 500) });
              }
            }
          }
        }
      } catch (e) {
        readErr = String(e);
      }
    })();

    const workResult = await work();
    await new Promise((r) => setTimeout(r, tailMs));
    ac.abort();
    await pump.catch(() => {});
    log?.(
      `Connect stream ${method}: frames=${collected.length} readErr=${readErr ?? "none"}`,
    );
    return { status: res.status, collected, workResult, readErr };
  } catch (err) {
    return { error: String(err), collected, workResult: null };
  } finally {
    clearTimeout(hardStop);
  }
}
