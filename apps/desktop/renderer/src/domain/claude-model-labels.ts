// The Claude Code aliases the desktop listed before it listed full model ids.
// An alias runs a different model on each CLI version, so it is named as an
// alias. Agents saved with one keep it and still start.
const claudeAliasLabels: Record<string, string> = {
  opus: "Latest Opus",
  sonnet: "Latest Sonnet",
  haiku: "Latest Haiku",
  best: "Best available",
  opusplan: "Opus Plan",
  "opus[1m]": "Latest Opus 1M",
  "sonnet[1m]": "Latest Sonnet 1M",
};

/** A readable name for a saved model id the model list no longer shows; any other id as it is. */
export function savedModelLabel(providerId: string | null | undefined, model: string): string {
  return (providerId === "claude-code" || providerId === "claude") && Object.hasOwn(claudeAliasLabels, model)
    ? claudeAliasLabels[model]!
    : model;
}
