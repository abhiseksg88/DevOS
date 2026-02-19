-- Add 'architectural_proposal' to the build_event_kind enum.
-- The orchestrator emits this kind when presenting a plan for HITL review,
-- but it was missing from the original enum definition.
ALTER TYPE build_event_kind ADD VALUE IF NOT EXISTS 'architectural_proposal';
