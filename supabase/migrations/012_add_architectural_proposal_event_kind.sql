-- Add 'architectural_proposal' to the build_event_kind enum.
-- The orchestrator emits this kind when presenting a plan for HITL review,
-- but it was missing from the original enum definition.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block (which
-- supabase db push uses). Insert directly into pg_enum instead — idempotent
-- and transaction-safe.
INSERT INTO pg_enum (enumtypid, enumlabel, enumsortorder)
SELECT
    (SELECT oid FROM pg_type WHERE typname = 'build_event_kind'),
    'architectural_proposal',
    (SELECT MAX(enumsortorder) + 1
       FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_event_kind'))
WHERE NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_event_kind')
       AND enumlabel = 'architectural_proposal'
);
