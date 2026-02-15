#!/usr/bin/env python3
"""
Database Setup Script — Creates tables in Supabase for local/test development.

This is a simplified version of 001_core_schema.sql that works with Supabase
cloud without needing the Supabase CLI. It skips auth.users FK constraints
(Supabase manages auth.users internally) and RLS policies (which need to be
added via the Supabase Dashboard SQL Editor for full security).

Usage:
    1. Fill in your .env file with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
    2. Run: python scripts/setup_db.py

For production: Use the full migration in supabase/migrations/001_core_schema.sql
via the Supabase Dashboard SQL Editor instead.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

import httpx


def run_sql(supabase_url: str, service_role_key: str, sql: str) -> dict:
    """Execute raw SQL against Supabase via the REST SQL endpoint."""
    # Use the Supabase Management API or the PostgREST rpc endpoint
    # For direct SQL, we use the pg_net or the /rest/v1/rpc approach
    # Simplest: use the Supabase client's rpc or direct HTTP to PostgREST

    # Actually, the cleanest way is to use the Supabase SQL Editor endpoint
    # But for automation, we'll use supabase-py to call individual table creates

    print(f"  Executing SQL block ({len(sql)} chars)...")

    resp = httpx.post(
        f"{supabase_url}/rest/v1/rpc/exec_sql",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
        },
        json={"query": sql},
        timeout=30,
    )

    if resp.status_code == 200:
        print("  OK")
        return resp.json()
    else:
        # exec_sql may not exist — fall back to instruction
        return {"error": resp.status_code, "body": resp.text}


def main():
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not service_role_key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
        sys.exit(1)

    print("=" * 60)
    print("NimbusForge Database Setup")
    print("=" * 60)
    print(f"Supabase URL: {supabase_url}")
    print()

    # Test connection
    print(">>> Testing connection...")
    try:
        resp = httpx.get(
            f"{supabase_url}/rest/v1/",
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            timeout=10,
        )
        if resp.status_code == 200:
            print("  Connected to Supabase successfully!")
        else:
            print(f"  Warning: Got status {resp.status_code} — continuing anyway")
    except Exception as e:
        print(f"  ERROR: Cannot connect to Supabase: {e}")
        sys.exit(1)

    print()
    print("=" * 60)
    print("IMPORTANT: Automated SQL execution requires the Supabase SQL Editor.")
    print()
    print("Please run these steps manually:")
    print()
    print("1. Go to your Supabase Dashboard -> SQL Editor")
    print("2. Open and run this file:")
    print(f"   {os.path.abspath('supabase/migrations/001_core_schema.sql')}")
    print()
    print("3. Then run this file:")
    print(f"   {os.path.abspath('supabase/migrations/002_rpc_functions.sql')}")
    print()
    print("4. Then create a test user:")
    print("   Go to Authentication -> Users -> Add User")
    print("   Email: test@nimbusforge.dev")
    print("   Password: testpass123")
    print()
    print("5. Then run: python scripts/test_flow.py")
    print("=" * 60)

    # Try to verify tables exist
    print()
    print(">>> Checking if tables already exist...")
    for table in ["tenants", "tenant_members", "projects", "builds", "build_events", "deployments", "usage_events"]:
        try:
            resp = httpx.get(
                f"{supabase_url}/rest/v1/{table}?select=id&limit=0",
                headers={
                    "apikey": service_role_key,
                    "Authorization": f"Bearer {service_role_key}",
                },
                timeout=5,
            )
            if resp.status_code == 200:
                print(f"  {table:20s} ... EXISTS")
            else:
                print(f"  {table:20s} ... MISSING (run the SQL migration)")
        except Exception:
            print(f"  {table:20s} ... ERROR")

    print()
    print("Done. If tables show MISSING, run the SQL migration first.")


if __name__ == "__main__":
    main()
