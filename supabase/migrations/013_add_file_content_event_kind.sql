-- Add 'file_content' to the build_event_kind enum.
-- Emitted by the scaffolder and coder nodes to stream file contents to the
-- frontend for preview.
--
-- Must be run outside a transaction (autocommit mode).
-- In Supabase SQL Editor this works as-is.
-- Via supabase db push: add `set transaction_mode = autocommit;` if your
-- CLI version wraps migrations in a transaction.
ALTER TYPE build_event_kind ADD VALUE IF NOT EXISTS 'file_content';
