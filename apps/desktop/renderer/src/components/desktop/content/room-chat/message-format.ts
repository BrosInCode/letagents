export function displaySender(sender: string): string {
  const [name] = sender.split("|").map((part) => part.trim()).filter(Boolean);
  return name || "Unknown";
}

export function replyPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
