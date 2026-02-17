/**
 * Database setup endpoint: ensures app_data table exists.
 *
 * Called by the preview when db-check detects the table is missing.
 * Uses the service-role key to create the table via Supabase SQL API.
 *
 * This is a fallback for when the migration (004_app_data_table.sql)
 * hasn't been applied yet.
 */

import { NextRequest, NextResponse } from "next/server";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS app_data (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    project_id      UUID NOT NULL,
    app_instance_id TEXT NOT NULL DEFAULT '',
    collection      TEXT NOT NULL,
    record_id       TEXT NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}'::jsonb,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, app_instance_id, collection, record_id)
);

-- Add FK constraints if referenced tables exist (safe for fresh installs)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants') THEN
        BEGIN
            ALTER TABLE app_data ADD CONSTRAINT app_data_tenant_id_fkey
                FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'projects') THEN
        BEGIN
            ALTER TABLE app_data ADD CONSTRAINT app_data_project_id_fkey
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_app_data_project_collection ON app_data(project_id, collection);
CREATE INDEX IF NOT EXISTS idx_app_data_lookup ON app_data(project_id, app_instance_id, collection, record_id);
CREATE INDEX IF NOT EXISTS idx_app_data_created ON app_data(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_data_tenant ON app_data(tenant_id);

ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;

-- Policy names match migration 004_app_data_table.sql exactly
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_select') THEN
        CREATE POLICY app_data_select ON app_data FOR SELECT
            USING (tenant_id = ANY(public.get_tenant_ids()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_insert') THEN
        CREATE POLICY app_data_insert ON app_data FOR INSERT
            WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_update') THEN
        CREATE POLICY app_data_update ON app_data FOR UPDATE
            USING (tenant_id = ANY(public.get_tenant_ids()))
            WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_delete') THEN
        CREATE POLICY app_data_delete ON app_data FOR DELETE
            USING (tenant_id = ANY(public.get_tenant_ids()));
    END IF;
END $$;
`;

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      {
        success: false,
        error: "Missing SUPABASE_SERVICE_ROLE_KEY — cannot auto-create table",
      },
      { status: 500 },
    );
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  // First check if table already exists
  try {
    const checkResp = await fetch(
      `${supabaseUrl}/rest/v1/app_data?select=id&limit=1`,
      { headers },
    );
    if (checkResp.ok) {
      return NextResponse.json({
        success: true,
        message: "app_data table already exists",
        created: false,
      });
    }
  } catch {
    // table might not exist, continue to creation
  }

  // Try multiple approaches to create the table

  // Approach 1: Supabase Management API SQL endpoint
  const endpoints = [
    `${supabaseUrl}/rest/v1/rpc/exec_sql`,
    `${supabaseUrl}/pg/query`,
  ];

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: CREATE_TABLE_SQL }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        return NextResponse.json({
          success: true,
          message: `app_data table created via ${endpoint}`,
          created: true,
        });
      }
    } catch {
      continue;
    }
  }

  // Approach 2: Try with "sql" key instead of "query"
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql: CREATE_TABLE_SQL }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      return NextResponse.json({
        success: true,
        message: "app_data table created via exec_sql RPC",
        created: true,
      });
    }
  } catch {
    // continue
  }

  // If all approaches fail, return instructions
  return NextResponse.json(
    {
      success: false,
      error:
        "Could not auto-create app_data table. Please run the migration manually: " +
        "supabase db push (migration 004_app_data_table.sql) or paste the SQL into the Supabase SQL editor.",
    },
    { status: 500 },
  );
}
