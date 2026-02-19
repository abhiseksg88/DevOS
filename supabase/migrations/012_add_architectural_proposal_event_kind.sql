-- Add 'architectural_proposal' to the build_event_kind enum.
-- The orchestrator emits this kind when presenting a plan for HITL review,
-- but it was missing from the original enum definition.
--
-- Must be run outside a transaction (autocommit mode).
-- In Supabase SQL Editor this works as-is.
-- Via supabase db push: add `set transaction_mode = autocommit;` if your
-- CLI version wraps migrations in a transaction.
ALTER TYPE build_event_kind ADD VALUE IF NOT EXISTS 'architectural_proposal';
