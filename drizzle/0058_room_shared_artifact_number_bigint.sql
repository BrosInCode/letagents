DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'room_shared_artifacts'
      AND column_name = 'artifact_number'
      AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE "room_shared_artifacts"
      ALTER COLUMN "artifact_number" TYPE bigint
      USING "artifact_number"::bigint;
  END IF;
END $$;
