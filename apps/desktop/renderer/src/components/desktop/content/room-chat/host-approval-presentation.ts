import type { HostApprovalPresentation } from "../../../../../../shared/host-approvals";

type Field = { label: string; value: string };
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : null;

// Keep controls and bidi overrides visible; provider-authored text never becomes markup.
function text(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function label(key: string): string {
  const value = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return text(value.charAt(0).toUpperCase() + value.slice(1));
}

function valueText(value: unknown, depth = 0): string {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${valueText(item, depth + 1)}`).join("\n") : "None";
  const object = record(value);
  if (object) return Object.entries(object).map(([key, item]) => `${"  ".repeat(depth)}${label(key)}: ${valueText(item, depth + 1)}`).join("\n") || "None";
  return String(value);
}

/** Display the proposed action, leaving the signed native presentation untouched. */
export function hostApprovalFields(presentation: HostApprovalPresentation): Field[] {
  let parsed: unknown;
  try { parsed = JSON.parse(presentation.details); }
  catch { return [{ label: "Request", value: text(presentation.details) }]; }
  const payload = record(parsed);
  if (!payload) return [{ label: "Request", value: valueText(parsed) }];
  const fields = (input: Record<string, unknown>): Field[] => Object.entries(input)
    .map(([key, value]) => ({ label: label(key), value: valueText(value) }));
  if (presentation.provider === "claude-code") {
    const request = record(payload.request);
    const input = record(request?.input);
    if (request && input) return [{ label: "Tool", value: valueText(request.tool_name) }, ...fields(input),
      ...fields(Object.fromEntries(Object.entries(request).filter(([key, value]) =>
        !["subtype", "tool_use_id", "tool_name", "input"].includes(key)
        && !(key === "display_name" && value === request.tool_name)
        && !(key === "description" && value === input.description)))),
    ];
  }
  if (presentation.provider === "codex") {
    const request = record(payload.request) ?? payload;
    const params = record(request.params);
    if (params) return [
      ...fields(Object.fromEntries(Object.entries(params).filter(([key]) => !["threadId", "turnId", "itemId"].includes(key)))),
      ...(Array.isArray(payload.changes) ? [{ label: "Changes", value: valueText(payload.changes) }] : []),
    ];
  }
  if (presentation.provider === "open-model" && typeof payload.permission === "string") return [
    { label: "Permission", value: text(payload.permission) },
    ...(Array.isArray(payload.patterns) ? [{ label: "Applies to", value: valueText(payload.patterns) }] : []),
    ...fields(record(payload.metadata) ?? {}),
  ];
  return fields(payload);
}
