-- =============================================================================
-- Migration 014: Tri-Model Pipeline — enum extensions
--
-- Adds the new model tiers (GPT-4o, Gemini Pro, Gemini Flash) and the new
-- build statuses introduced by the frontend-first, multi-HITL pipeline.
--
-- Safe to run multiple times (all changes are guarded with IF NOT EXISTS).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. model_tier: add gpt4o, gemini_pro, gemini_flash
--    Used in: build_events.agent, usage_events.model
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'gpt4o'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'model_tier')
    ) THEN
        ALTER TYPE model_tier ADD VALUE 'gpt4o';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'gemini_pro'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'model_tier')
    ) THEN
        ALTER TYPE model_tier ADD VALUE 'gemini_pro';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'gemini_flash'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'model_tier')
    ) THEN
        ALTER TYPE model_tier ADD VALUE 'gemini_flash';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. build_status: add new pipeline stage statuses
--
--   awaiting_requirements_approval  — HITL Gate A (PRD review)
--   building_frontend               — Gemini Pro generating UI with mock hooks
--   awaiting_frontend_approval      — HITL Gate C (visual frontend approval)
--   integrating                     — Claude Sonnet wiring frontend → Supabase
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'awaiting_requirements_approval'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_status')
    ) THEN
        ALTER TYPE build_status ADD VALUE 'awaiting_requirements_approval' AFTER 'awaiting_approval';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'building_frontend'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_status')
    ) THEN
        ALTER TYPE build_status ADD VALUE 'building_frontend' AFTER 'awaiting_requirements_approval';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'awaiting_frontend_approval'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_status')
    ) THEN
        ALTER TYPE build_status ADD VALUE 'awaiting_frontend_approval' AFTER 'building_frontend';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'integrating'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_status')
    ) THEN
        ALTER TYPE build_status ADD VALUE 'integrating' AFTER 'awaiting_frontend_approval';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. builds table: store the new pipeline artefacts
--    These columns hold the Design Contract + Requirements PRD so the frontend
--    can display them at each HITL gate and the pipeline can resume cleanly.
-- ---------------------------------------------------------------------------
ALTER TABLE builds
    ADD COLUMN IF NOT EXISTS figma_key          TEXT,
    ADD COLUMN IF NOT EXISTS requirements_json  JSONB,
    ADD COLUMN IF NOT EXISTS design_contract    JSONB,
    ADD COLUMN IF NOT EXISTS frontend_files     JSONB,   -- {filepath: content}
    ADD COLUMN IF NOT EXISTS build_phase        TEXT;    -- requirements|design|frontend|backend|integration

-- ---------------------------------------------------------------------------
-- 4. Verify — show current enum values (comment out after confirming)
-- ---------------------------------------------------------------------------
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'model_tier')
-- ORDER BY enumsortorder;

-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_status')
-- ORDER BY enumsortorder;
