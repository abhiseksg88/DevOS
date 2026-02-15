-- =============================================================================
-- NimbusForge RPC Functions
-- Called by the backend via service-role for atomic operations
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Increment tenant spend atomically (avoids race conditions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION increment_tenant_spend(t_id UUID, amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    UPDATE tenants
    SET monthly_spent_usd = monthly_spent_usd + amount,
        updated_at = NOW()
    WHERE id = t_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Get next build event sequence number (atomic)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_build_event_seq(b_id UUID)
RETURNS INTEGER AS $$
DECLARE
    next_seq INTEGER;
BEGIN
    SELECT COALESCE(MAX(seq), 0) + 1 INTO next_seq
    FROM build_events
    WHERE build_id = b_id;
    RETURN next_seq;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Get tenant usage summary for a date range
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_usage_summary(
    t_id UUID,
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
    total_builds BIGINT,
    total_tokens_in BIGINT,
    total_tokens_out BIGINT,
    total_cost_usd NUMERIC,
    builds_succeeded BIGINT,
    builds_failed BIGINT,
    avg_build_cost NUMERIC,
    top_model TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH build_stats AS (
        SELECT
            COUNT(*) AS total_builds,
            COUNT(*) FILTER (WHERE status = 'succeeded') AS builds_succeeded,
            COUNT(*) FILTER (WHERE status = 'failed') AS builds_failed,
            COALESCE(SUM(b.total_tokens_in), 0) AS total_tokens_in,
            COALESCE(SUM(b.total_tokens_out), 0) AS total_tokens_out,
            COALESCE(SUM(b.total_cost_usd), 0) AS total_cost_usd,
            COALESCE(AVG(b.total_cost_usd), 0) AS avg_build_cost
        FROM builds b
        WHERE b.tenant_id = t_id
          AND b.created_at >= start_date
          AND b.created_at < end_date
    ),
    model_stats AS (
        SELECT
            ue.model::TEXT AS model_name,
            SUM(ue.cost_usd) AS model_cost
        FROM usage_events ue
        WHERE ue.tenant_id = t_id
          AND ue.created_at >= start_date
          AND ue.created_at < end_date
          AND ue.event_type = 'llm_call'
        GROUP BY ue.model
        ORDER BY model_cost DESC
        LIMIT 1
    )
    SELECT
        bs.total_builds,
        bs.total_tokens_in,
        bs.total_tokens_out,
        bs.total_cost_usd,
        bs.builds_succeeded,
        bs.builds_failed,
        bs.avg_build_cost,
        COALESCE(ms.model_name, 'none')
    FROM build_stats bs
    LEFT JOIN model_stats ms ON TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Cleanup expired plan cache entries
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_expired_plans()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM plan_cache WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
