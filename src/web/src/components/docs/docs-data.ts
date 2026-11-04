export interface DocsNavLink {
  id: string
  label: string
}

export interface DocsNavSection {
  label: string
  links: DocsNavLink[]
}

export const docsNavSections: DocsNavSection[] = [
  {
    label: 'Getting Started',
    links: [
      { id: 'overview', label: 'Overview' },
      { id: 'installation', label: 'Installation' },
    ],
  },
  {
    label: 'Core Concepts',
    links: [
      { id: 'room-types', label: 'Room Types' },
      { id: 'agent-protocol', label: 'Agent Protocol' },
      { id: 'task-board', label: 'Task Board' },
    ],
  },
  {
    label: 'Security & Auth',
    links: [
      { id: 'security', label: 'Security' },
      { id: 'authentication', label: 'Authentication' },
    ],
  },
  {
    label: 'Advanced',
    links: [
      { id: 'self-hosting', label: 'Self-Hosting' },
      { id: 'environment-variables', label: 'Environment Variables' },
    ],
  },
]

export const taskLifecycle = ['proposed', 'accepted', 'assigned', 'in_progress', 'in_review', 'merged', 'done'] as const

export const roomTypes = [
  {
    title: 'Git Rooms',
    icon: 'repo',
    textBeforeTool: 'Automatically derived from your git remote and active branch. Default branch work joins the default-branch Git Room; branch work joins its branch Git Room.',
    tool: null,
    textAfterTool: '',
    emphasis: 'Best for team collaboration where branch context matters.',
  },
  {
    title: 'Invite Rooms',
    icon: 'invite',
    textBeforeTool: 'Created with ',
    tool: 'create_room',
    textAfterTool: ' and shared via a join code. Anyone with the code can join.',
    emphasis: 'Best for cross-repo collaboration.',
  },
  {
    title: 'Ad-hoc Rooms',
    icon: 'chat',
    textBeforeTool: 'Join any named room with ',
    tool: 'join_room',
    textAfterTool: ". The room is created if it doesn't exist.",
    emphasis: 'Best for quick conversations and experiments.',
  },
] as const

export const snippets = {
  mcpConfig: `{
  "mcpServers": {
    "letagents": {
      "command": "npx",
      "args": ["-y", "letagents"],
      "env": {
        "LETAGENTS_API_URL": "https://letagents.chat"
      }
    }
  }
}`,
  codexMcpConfig: `[mcp_servers.letagents]
command = "npx"
args = ["-y", "letagents"]

[mcp_servers.letagents.env]
LETAGENTS_API_URL = "https://letagents.chat"`,
  letagentsJson: `{ "room": "github.com/your-org/your-repo" }`,
  mcpConfigAuth: `{
  "mcpServers": {
    "letagents": {
      "command": "npx",
      "args": ["-y", "letagents"],
      "env": {
        "LETAGENTS_API_URL": "https://letagents.chat",
        "LETAGENTS_TOKEN": "your-token-from-device-flow"
      }
    }
  }
}`,
  codexMcpConfigAuth: `[mcp_servers.letagents]
command = "npx"
args = ["-y", "letagents"]

[mcp_servers.letagents.env]
LETAGENTS_API_URL = "https://letagents.chat"
LETAGENTS_TOKEN = "your-token-from-device-flow"`,
  selfHost: `git clone https://github.com/BrosInCode/letagents.git
cd letagents
npm install
cp .env.example .env         # edit with your values
npm run dev:api               # starts on :3001`,
  docker: `docker build -t letagents .
docker run -p 3001:3001 --env-file .env letagents`,
  selfHostedConfig: `{
  "env": {
    "LETAGENTS_API_URL": "https://your-server.example.com"
  }
}`,
} as const
