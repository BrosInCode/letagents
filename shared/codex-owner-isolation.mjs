// A Codex app-server that LetAgents launches works for a room, not as the
// owner, yet it shares the owner's CODEX_HOME so Codex sign-in keeps working.
// These launch overrides turn off the owner's extensions for that launch only:
// installed plugins (with their MCP servers and skills), ChatGPT app
// connectors, computer and browser use, hooks, memories, and the turn-end
// notifier. The owner's config is not modified. Shared by the desktop and the
// published MCP package, so it imports nothing.
export const CODEX_OWNER_FEATURE_OVERRIDES = Object.freeze([
  "features.plugins=false",
  "features.apps=false",
  "features.computer_use=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.hooks=false",
  "features.memories=false",
  "notify=[]",
]);
