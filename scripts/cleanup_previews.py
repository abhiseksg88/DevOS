#!/usr/bin/env python3
"""
Cron job: Clean up stale preview deployments.

Schedule: Run every hour via Cloud Scheduler or pg_cron.

Actions:
  1. Find active deployments with no traffic in 72 hours -> stop container
  2. Find stopped deployments older than 7 days -> delete container + record

Usage:
  python scripts/cleanup_previews.py
  # Or via Cloud Scheduler:
  gcloud scheduler jobs create http cleanup-previews \
    --schedule="0 * * * *" \
    --uri="https://api.nimbusforge.dev/internal/cleanup" \
    --http-method=POST
"""

import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nimbusforge.api.config import get_settings
from nimbusforge.preview.router import cleanup_stale_previews


def main():
    settings = get_settings()
    result = cleanup_stale_previews(settings)
    print(f"Cleanup complete: stopped={result['stopped']}, deleted={result['deleted']}")


if __name__ == "__main__":
    main()
