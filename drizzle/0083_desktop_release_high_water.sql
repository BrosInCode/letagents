CREATE TABLE "desktop_release_high_water" (
  "channel" text PRIMARY KEY,
  "major" integer NOT NULL CHECK ("major" >= 0),
  "minor" integer NOT NULL CHECK ("minor" >= 0),
  "patch" integer NOT NULL CHECK ("patch" >= 0),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Seed the last release bundled with this deployment. A manifest must never
-- move any server instance below this floor, including after a restart.
INSERT INTO "desktop_release_high_water" ("channel", "major", "minor", "patch")
VALUES ('mac-beta', 0, 1, 5);
