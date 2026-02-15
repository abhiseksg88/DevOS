#!/usr/bin/env python3
"""
Cron job: Reset monthly budgets on the 1st of each month.

Schedule: 0 0 1 * * (midnight on the 1st)

This is a safety net — the SQL migration includes a pg_cron version too.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nimbusforge.api.config import get_settings
from supabase import create_client


def main():
    settings = get_settings()
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)
    db.table("tenants").update({"monthly_spent_usd": 0}).neq("id", "impossible").execute()
    print("Monthly budgets reset for all tenants.")


if __name__ == "__main__":
    main()
