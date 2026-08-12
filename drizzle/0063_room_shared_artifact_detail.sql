-- Additive, nullable JSONB column holding structured per-artifact detail
-- (discriminated on type/version; currently only change_summary: file paths + counts,
-- never source code). Existing rows read NULL; old clients ignore it.
ALTER TABLE "room_shared_artifacts" ADD COLUMN IF NOT EXISTS "detail" jsonb;
