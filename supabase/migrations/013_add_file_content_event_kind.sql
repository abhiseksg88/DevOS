-- Add 'file_content' to the build_event_kind enum.
-- Emitted by the scaffolder and coder nodes to stream file contents to the
-- frontend for preview.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block (which
-- supabase db push uses). Insert directly into pg_enum instead — idempotent
-- and transaction-safe.
INSERT INTO pg_enum (enumtypid, enumlabel, enumsortorder)
SELECT
    (SELECT oid FROM pg_type WHERE typname = 'build_event_kind'),
    'file_content',
    (SELECT MAX(enumsortorder) + 1
       FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_event_kind'))
WHERE NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_event_kind')
       AND enumlabel = 'file_content'
);
