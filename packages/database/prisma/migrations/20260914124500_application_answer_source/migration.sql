ALTER TABLE "application_answers" ADD COLUMN "source" TEXT;

UPDATE "application_answers"
SET "source" = CASE
  WHEN "provenance"->>'source' IN ('USER_PROFILE', 'USER_INPUT', 'COVER_LETTER', 'AI_SUGGESTION')
    THEN "provenance"->>'source'
  ELSE 'USER_INPUT'
END;

ALTER TABLE "application_answers" ALTER COLUMN "source" SET NOT NULL;
