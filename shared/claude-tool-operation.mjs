/** Match approval requests to the operation emitted by the native adapter. */
export function claudeToolOperation(name) {
  return name === "Bash" ? "command"
    : ["Read", "Glob", "Grep"].includes(name) ? "file_read"
      : ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name) ? "file_change"
        : ["WebFetch", "WebSearch"].includes(name) ? "network"
          : name === "AskUserQuestion" ? "question" : "other";
}
