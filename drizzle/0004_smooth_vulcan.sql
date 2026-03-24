DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "rooms" LIMIT 1) THEN
    RAISE EXCEPTION '0004_smooth_vulcan is empty-DB-only. Wipe room data before applying.';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "display_name" text NOT NULL;
