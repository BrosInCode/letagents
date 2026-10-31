// A stand-in for the LetAgents MCP server, used only while recording Codex
// traffic (see record-codex-replay.ts). The Codex adapter refuses to start a
// room turn unless a server named `letagents` reports its room tools, so the
// recorder gives Codex this one. It has no room, no network and no credentials:
// it answers the MCP handshake, lists the room tools, serves the readiness
// resource, and refuses every tool call. Codex itself is the real one.

import { createInterface } from "node:readline";

const READINESS_URI = "letagents://runtime/readiness";
const ROOM_TOOLS = ["claim_task", "get_board", "read_messages", "send_message"];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function refuse(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  // A notification has no id and gets no answer.
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "letagents-replay-recording-stub", version: "0.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: ROOM_TOOLS.map((name) => ({
          name,
          description: "Not available while recording.",
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        })),
      });
    case "tools/call":
      return reply(id, {
        isError: true,
        content: [{ type: "text", text: "This recording has no room. Answer in your final response instead." }],
      });
    case "resources/list":
      return reply(id, {
        resources: [{ uri: READINESS_URI, name: "LetAgents runtime readiness", mimeType: "application/json" }],
      });
    case "resources/templates/list":
      return reply(id, { resourceTemplates: [] });
    case "resources/read":
      if (params?.uri !== READINESS_URI) return refuse(id, -32002, "Resource not found.");
      return reply(id, {
        contents: [{
          uri: READINESS_URI,
          mimeType: "application/json",
          text: JSON.stringify({ format: 1, profile: "supervised_room_turn", provider: "codex", tools: ROOM_TOOLS }),
        }],
      });
    default:
      return refuse(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message && typeof message === "object" && typeof message.method === "string") handle(message);
});
