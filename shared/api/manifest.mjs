// The page manifest: the JSON a room page carries in
// <script type="application/letagents-page+json">. It says which API version
// the page was written for, where it shows, what it may call and which shared
// data it keeps. A room admin grants the capabilities when pinning the page.
import { z } from "zod";

import { CAPABILITY_NAMES } from "./capabilities.mjs";
import { API_VERSION, describeIssues } from "./core.mjs";

export const PAGE_MANIFEST_SCRIPT_TYPE = "application/letagents-page+json";

/** Every surface the contract knows. v1 apps show `room.tab` only. */
export const PAGE_SURFACES = /** @type {const} */ (["room.tab", "task.panel", "message", "room.widget"]);
/** v1 ships `room` only; `org` is for a later company page library. */
export const PAGE_OWNER_KINDS = /** @type {const} */ (["room", "org"]);
export const DATA_SCOPES = /** @type {const} */ (["viewer", "page", "room"]);

export const PAGE_TITLE_MAX = 80;
export const PAGE_COLLECTIONS_PER_SCOPE_MAX = 32;
export const PAGE_WORK_ITEM_FIELDS_MAX = 50;

const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// Tracker field ids: `customfield_10027`, `story_points`, `System.Tags`.
const WORK_ITEM_FIELD = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;

/**
 * @template T
 * @param {T[]} values
 * @returns {boolean}
 */
const unique = (values) => new Set(values).size === values.length;

const capabilityName = z.string().refine((value) => /** @type {readonly string[]} */ (CAPABILITY_NAMES).includes(value), {
  error: (issue) => `Unknown capability ${JSON.stringify(issue.input)}. Known capabilities: ${CAPABILITY_NAMES.join(", ")}.`,
});

const collectionNames = z
  .array(z.string().regex(COLLECTION_NAME, { error: "A collection name is lower case letters, digits and _, starting with a letter, at most 64 characters." }))
  .max(PAGE_COLLECTIONS_PER_SCOPE_MAX)
  .refine(unique, { error: "Collection names must not repeat." });

export const PageManifest = z
  .strictObject({
    api: z.literal(API_VERSION, { error: `"api" must be ${API_VERSION}, the API version this page was written for.` }),
    title: z.string().trim().min(1, { error: "A title is required." }).max(PAGE_TITLE_MAX),
    surfaces: z
      .array(z.enum(PAGE_SURFACES, { error: `A surface is one of: ${PAGE_SURFACES.join(", ")}.` }))
      .min(1, { error: "Name at least one surface, for example \"room.tab\"." })
      .refine(unique, { error: "Surfaces must not repeat." }),
    capabilities: z.array(capabilityName).refine(unique, { error: "Capabilities must not repeat." }).default([]),
    workItemFields: z
      .array(z.string().regex(WORK_ITEM_FIELD, { error: "A work item field is a tracker field id, such as customfield_10027." }))
      .max(PAGE_WORK_ITEM_FIELDS_MAX)
      .refine(unique, { error: "Work item fields must not repeat." })
      .default([]),
    collections: z
      .strictObject({ viewer: collectionNames.optional(), page: collectionNames.optional(), room: collectionNames.optional() })
      .default({}),
    owner: z.enum(PAGE_OWNER_KINDS, { error: `"owner" is one of: ${PAGE_OWNER_KINDS.join(", ")}.` }).default("room"),
  })
  .superRefine((manifest, ctx) => {
    // A collection is reachable only through its data capability, so naming
    // one without the capability is a mistake the author should see now.
    for (const scope of DATA_SCOPES) {
      if (manifest.collections[scope]?.length && !manifest.capabilities.includes(`data.${scope}`)) {
        ctx.addIssue({
          code: "custom",
          path: ["collections", scope],
          message: `Collections in the "${scope}" scope need the "data.${scope}" capability.`,
        });
      }
    }
    if (manifest.workItemFields.length && !manifest.capabilities.includes("work_items.read")) {
      ctx.addIssue({
        code: "custom",
        path: ["workItemFields"],
        message: "workItemFields needs the \"work_items.read\" capability.",
      });
    }
  });

const MANIFEST_KEYS = Object.keys(PageManifest.shape);

/** @typedef {z.infer<typeof PageManifest>} PageManifest */
/** @typedef {typeof PAGE_SURFACES[number]} PageSurface */
/** @typedef {typeof PAGE_OWNER_KINDS[number]} PageOwnerKind */
/** @typedef {typeof DATA_SCOPES[number]} DataScope */

/**
 * @typedef {{ ok: true, manifest: PageManifest }
 *   | { ok: false, errors: { path: string, message: string }[] }} PageManifestParseResult
 */

/**
 * Parses a manifest from its JSON text or an already-parsed value. Errors
 * carry the field path and a sentence an agent can act on.
 * @param {unknown} input
 * @returns {PageManifestParseResult}
 */
export function parsePageManifest(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [{ path: "", message: `The manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "The manifest must be a JSON object." }] };
  }
  const parsed = PageManifest.safeParse(value);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: describeIssues(parsed.error).map((issue) => {
      if (!issue.message.startsWith("Unrecognized key")) return issue;
      const known = issue.path === "collections" ? DATA_SCOPES : MANIFEST_KEYS;
      return { ...issue, message: `${issue.message}. Known keys: ${known.join(", ")}.` };
    }),
  };
}
