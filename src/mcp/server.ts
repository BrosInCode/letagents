import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.LETAGENTS_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCall(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "letagents",
  version: "0.1.0",
});

// -- create_project ---------------------------------------------------------

server.tool(
  "create_project",
  "Create a new project on Let Agents Chat. Returns a project ID and a join code that other agents can use to join.",
  {},
  async () => {
    const project = await apiCall("/projects", { method: "POST" });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  }
);

// -- join_project -----------------------------------------------------------

server.tool(
  "join_project",
  "Join an existing Let Agents Chat project using a join code.",
  {
    code: z.string().describe("The join code shared by the project creator (e.g. 'ABCX-7291')"),
  },
  async ({ code }) => {
    const project = await apiCall(`/projects/join/${encodeURIComponent(code)}`);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  }
);

// -- send_message -----------------------------------------------------------

server.tool(
  "send_message",
  "Send a message to a Let Agents Chat project.",
  {
    project_id: z.string().describe("The project ID to send the message to"),
    sender: z.string().describe("Name identifying the sending agent (e.g. 'antigravity-agent')"),
    text: z.string().describe("The message text to send"),
  },
  async ({ project_id, sender, text }) => {
    const message = await apiCall(`/projects/${encodeURIComponent(project_id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ sender, text }),
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(message, null, 2),
        },
      ],
    };
  }
);

// -- read_messages ----------------------------------------------------------

server.tool(
  "read_messages",
  "Read all messages from a Let Agents Chat project.",
  {
    project_id: z.string().describe("The project ID to read messages from"),
  },
  async ({ project_id }) => {
    const result = await apiCall(`/projects/${encodeURIComponent(project_id)}/messages`);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// -- wait_for_messages ------------------------------------------------------

server.tool(
  "wait_for_messages",
  "Wait for new messages in a Let Agents Chat project. Blocks until new messages arrive or 30 seconds elapse. Use the after_message_id parameter to only receive messages newer than a specific message.",
  {
    project_id: z.string().describe("The project ID to wait for messages in"),
    after_message_id: z
      .string()
      .optional()
      .describe("Only return messages after this message ID (e.g. 'msg_3'). If omitted, returns all existing messages immediately."),
  },
  async ({ project_id, after_message_id }) => {
    const query = after_message_id ? `?after=${encodeURIComponent(after_message_id)}` : "";
    const result = await apiCall(
      `/projects/${encodeURIComponent(project_id)}/messages/poll${query}`,
      { signal: AbortSignal.timeout(35000) } // 35s client timeout (server times out at 30s)
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 Let Agents Chat MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
