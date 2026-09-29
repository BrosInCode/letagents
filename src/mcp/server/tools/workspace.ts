import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { beginWorkspaceCapture, publishWorkspaceCapture } from '../runtime/workspace-capture.js';
import { jsonToolResponse } from './messages/response.js';

export const WORKSPACE_CAPTURE_INSTRUCTIONS = 'For independent coding work you are sharing in a LetAgents room: register this chat as a worker, call begin_workspace_capture before editing, retain capture_id, and call publish_workspace_capture when finished with a short summary. Pass this chat\'s worker_id to both tools. The publish tool posts the summary itself; do not send a duplicate message. If it returns uploading, repeat publish with the same capture_id until published. A missing baseline means exact changes cannot be attributed. Captures include tracked and non-ignored untracked files in the selected repository, and are shared with room participants. These are explicit agent tool calls, not automatic IDE hooks.';

export function registerWorkspaceTools(server: McpServer): void {
  const identity = { room_id: z.string().min(1).max(512).describe('Canonical hosted room ID.'),
    agent_session_id: z.string().optional().describe('Registered worker session. Prefer the worker_id returned for this chat.') };
  server.tool('begin_workspace_capture',
    'Before editing a repository for work shared in this room, record the starting files. Keep capture_id for publish_workspace_capture. Repeating begin preserves this worker\'s outstanding baseline. Files are inspected locally; nothing is posted until publish.',
    { ...identity, cwd: z.string().optional().describe('Actual project/worktree folder. Defaults to the MCP working directory.') },
    async input => jsonToolResponse(await beginWorkspaceCapture(input)));
  server.tool('publish_workspace_capture',
    'After editing, publish this capture\'s short summary, changed files and saved review to the room as this worker. Posts its own summary message. Retry with the same capture_id after errors or uploading; retries reuse saved bytes. Requires begin_workspace_capture before the work.',
    { ...identity, capture_id: z.string().uuid().describe('ID returned by begin_workspace_capture for this piece of work.'),
      summary: z.string().trim().min(1).max(400).describe('Plain-English description of what changed. Keep it concise; use Markdown if helpful.') },
    async input => jsonToolResponse(await publishWorkspaceCapture(input)));
}
