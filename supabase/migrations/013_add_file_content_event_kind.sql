-- Add 'file_content' to the build_event_kind enum.
-- Emitted by the scaffolder and coder nodes to stream file contents to the frontend.
ALTER TYPE build_event_kind ADD VALUE IF NOT EXISTS 'file_content';
