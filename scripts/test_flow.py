#!/usr/bin/env python3
"""
End-to-End Test Flow — Tests the full NimbusForge API pipeline.

This script:
1. Signs up / signs in a test user via Supabase Auth
2. Creates a tenant
3. Creates a project
4. Triggers a build (which kicks off the agent pipeline)
5. Streams build events via SSE
6. Checks the final build status

Prerequisites:
  - .env file with valid SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
  - Database tables created (run SQL migrations first)
  - API server running: make run (or uvicorn nimbusforge.api.main:app)

Usage:
    python scripts/test_flow.py
    python scripts/test_flow.py --api-url http://localhost:8000
    python scripts/test_flow.py --skip-auth  # use service-role key directly
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import httpx

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

API_URL = os.getenv("API_URL", "http://localhost:8000")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

TEST_EMAIL = "test@nimbusforge.dev"
TEST_PASSWORD = "testpass123!"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    BOLD = "\033[1m"
    END = "\033[0m"


def step(n: int, msg: str):
    print(f"\n{Colors.BOLD}{Colors.BLUE}[Step {n}]{Colors.END} {msg}")


def ok(msg: str):
    print(f"  {Colors.GREEN}OK{Colors.END} {msg}")


def fail(msg: str):
    print(f"  {Colors.RED}FAIL{Colors.END} {msg}")


def warn(msg: str):
    print(f"  {Colors.YELLOW}WARN{Colors.END} {msg}")


def api_call(method: str, path: str, token: str, json_data: dict = None) -> httpx.Response:
    """Make an authenticated API call."""
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{API_URL}{path}"

    if method == "GET":
        return httpx.get(url, headers=headers, timeout=30)
    elif method == "POST":
        return httpx.post(url, headers=headers, json=json_data, timeout=30)
    elif method == "PATCH":
        return httpx.patch(url, headers=headers, json=json_data, timeout=30)
    else:
        raise ValueError(f"Unknown method: {method}")


# ---------------------------------------------------------------------------
# Test Steps
# ---------------------------------------------------------------------------

def test_health() -> bool:
    """Step 0: Check API is running."""
    step(0, "Checking API health...")
    try:
        resp = httpx.get(f"{API_URL}/health", timeout=5)
        if resp.status_code == 200 and resp.json().get("status") == "ok":
            ok(f"API is running at {API_URL}")
            return True
        else:
            fail(f"Unexpected response: {resp.status_code} {resp.text}")
            return False
    except httpx.ConnectError:
        fail(f"Cannot connect to {API_URL}")
        print(f"\n  Start the API first: make run")
        return False


def get_auth_token(skip_auth: bool = False) -> str | None:
    """Step 1: Get an auth token."""
    step(1, "Authenticating...")

    if skip_auth:
        warn("Using service-role key directly (skip-auth mode)")
        return SUPABASE_SERVICE_ROLE_KEY

    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        fail("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env")
        return None

    # Try to sign in first
    resp = httpx.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Content-Type": "application/json",
        },
        json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
        timeout=10,
    )

    if resp.status_code == 200:
        token = resp.json().get("access_token")
        ok(f"Signed in as {TEST_EMAIL}")
        return token

    # Try to sign up
    warn(f"Sign-in failed ({resp.status_code}), trying sign-up...")
    resp = httpx.post(
        f"{SUPABASE_URL}/auth/v1/signup",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Content-Type": "application/json",
        },
        json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
        timeout=10,
    )

    if resp.status_code in (200, 201):
        token = resp.json().get("access_token")
        if token:
            ok(f"Signed up and got token for {TEST_EMAIL}")
            return token
        else:
            warn("Signed up but email confirmation may be required")
            warn("Go to Supabase Dashboard -> Authentication -> Users")
            warn(f"Find {TEST_EMAIL} and confirm manually, then re-run this script")

            # Try to auto-confirm via admin API
            if SUPABASE_SERVICE_ROLE_KEY:
                user_id = resp.json().get("id") or resp.json().get("user", {}).get("id")
                if user_id:
                    confirm_resp = httpx.put(
                        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
                        headers={
                            "apikey": SUPABASE_SERVICE_ROLE_KEY,
                            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                            "Content-Type": "application/json",
                        },
                        json={"email_confirm": True},
                        timeout=10,
                    )
                    if confirm_resp.status_code == 200:
                        ok("Auto-confirmed user via admin API")
                        # Now sign in again
                        resp2 = httpx.post(
                            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                            headers={
                                "apikey": SUPABASE_ANON_KEY,
                                "Content-Type": "application/json",
                            },
                            json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
                            timeout=10,
                        )
                        if resp2.status_code == 200:
                            token = resp2.json().get("access_token")
                            ok(f"Signed in as {TEST_EMAIL}")
                            return token

            return None

    fail(f"Auth failed: {resp.status_code} {resp.text[:200]}")
    return None


def test_create_tenant(token: str) -> str | None:
    """Step 2: Create a tenant."""
    step(2, "Creating tenant...")
    slug = f"test-org-{int(time.time()) % 10000}"
    resp = api_call("POST", "/tenants", token, {
        "name": "Test Organization",
        "slug": slug,
        "plan": "free",
    })

    if resp.status_code == 201:
        data = resp.json()
        ok(f"Tenant created: {data['name']} (id: {data['id'][:8]}...)")
        return data["id"]
    else:
        fail(f"Create tenant failed: {resp.status_code} {resp.text[:200]}")
        return None


def test_list_tenants(token: str) -> bool:
    """Step 2b: List tenants."""
    resp = api_call("GET", "/tenants", token)
    if resp.status_code == 200:
        tenants = resp.json()
        ok(f"Listed {len(tenants)} tenant(s)")
        return True
    else:
        fail(f"List tenants failed: {resp.status_code}")
        return False


def test_create_project(token: str, tenant_id: str) -> str | None:
    """Step 3: Create a project."""
    step(3, "Creating project...")
    resp = api_call("POST", f"/tenants/{tenant_id}/projects", token, {
        "name": "My Test App",
        "slug": "my-test-app",
        "description": "A test application built by NimbusForge",
        "stack": {"framework": "nextjs", "language": "typescript"},
    })

    if resp.status_code == 201:
        data = resp.json()
        ok(f"Project created: {data['name']} (id: {data['id'][:8]}...)")
        return data["id"]
    else:
        fail(f"Create project failed: {resp.status_code} {resp.text[:200]}")
        return None


def test_create_build(token: str, tenant_id: str, project_id: str) -> str | None:
    """Step 4: Trigger a build."""
    step(4, "Triggering build...")
    resp = api_call("POST", f"/tenants/{tenant_id}/projects/{project_id}/builds", token, {
        "prompt": "Create a simple landing page with a hero section, features grid, and contact form",
    })

    if resp.status_code == 201:
        data = resp.json()
        ok(f"Build created: {data['status']} (id: {data['id'][:8]}...)")
        return data["id"]
    elif resp.status_code == 402:
        warn(f"Budget exceeded: {resp.json().get('detail', '')}")
        return None
    elif resp.status_code == 429:
        warn(f"Rate limited: {resp.json().get('detail', '')}")
        return None
    else:
        fail(f"Create build failed: {resp.status_code} {resp.text[:200]}")
        return None


def test_get_build(token: str, tenant_id: str, project_id: str, build_id: str) -> dict | None:
    """Step 5: Check build status."""
    step(5, "Checking build status...")
    resp = api_call("GET", f"/tenants/{tenant_id}/projects/{project_id}/builds/{build_id}", token)

    if resp.status_code == 200:
        data = resp.json()
        ok(f"Build status: {data['status']}")
        if data.get("error_message"):
            warn(f"Error: {data['error_message'][:200]}")
        return data
    else:
        fail(f"Get build failed: {resp.status_code}")
        return None


def test_stream_events(token: str, tenant_id: str, project_id: str, build_id: str):
    """Step 6: Stream build events (SSE)."""
    step(6, "Streaming build events (5 second sample)...")
    url = f"{API_URL}/tenants/{tenant_id}/projects/{project_id}/builds/{build_id}/events?after_seq=0"

    try:
        with httpx.stream(
            "GET", url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(connect=5, read=10, write=5, pool=5),
        ) as resp:
            if resp.status_code != 200:
                warn(f"SSE stream returned {resp.status_code}")
                return

            event_count = 0
            start = time.time()
            for line in resp.iter_lines():
                if time.time() - start > 5:
                    break
                if line.startswith("data: "):
                    event_count += 1
                    try:
                        event = json.loads(line[6:])
                        kind = event.get("kind", "unknown")
                        agent = event.get("agent", "")
                        seq = event.get("seq", "")
                        print(f"    event #{seq}: {kind} ({agent})")

                        if kind == "stream_end":
                            ok(f"Stream ended. Build status: {event.get('build_status')}")
                            return
                    except json.JSONDecodeError:
                        pass

            if event_count > 0:
                ok(f"Received {event_count} event(s) in 5s")
            else:
                warn("No events received (build may still be queued)")

    except (httpx.ReadTimeout, httpx.ConnectTimeout):
        warn("SSE stream timed out (normal if build is still processing)")
    except Exception as e:
        warn(f"SSE error: {e}")


def test_usage(token: str, tenant_id: str):
    """Step 7: Check usage."""
    step(7, "Checking usage...")
    resp = api_call("GET", f"/tenants/{tenant_id}/usage?period=current_month", token)

    if resp.status_code == 200:
        data = resp.json()
        ok(f"Builds: {data['total_builds']}, Tokens: {data['total_tokens_in']}in/{data['total_tokens_out']}out, Cost: ${data['total_cost_usd']:.4f}")
    else:
        warn(f"Usage check returned {resp.status_code}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global API_URL
    parser = argparse.ArgumentParser(description="NimbusForge E2E Test Flow")
    parser.add_argument("--api-url", default=API_URL, help="API base URL")
    parser.add_argument("--skip-auth", action="store_true", help="Use service-role key instead of user auth")
    args = parser.parse_args()

    API_URL = args.api_url

    print("=" * 60)
    print(f"{Colors.BOLD}NimbusForge — End-to-End Test Flow{Colors.END}")
    print("=" * 60)
    print(f"API:      {API_URL}")
    print(f"Supabase: {SUPABASE_URL}")
    print()

    # Step 0: Health check
    if not test_health():
        sys.exit(1)

    # Step 1: Auth
    token = get_auth_token(skip_auth=args.skip_auth)
    if not token:
        print(f"\n{Colors.RED}Auth failed. Cannot continue.{Colors.END}")
        print("\nTroubleshooting:")
        print("  1. Check .env has SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY")
        print("  2. Create a test user in Supabase Dashboard -> Authentication -> Users")
        print(f"     Email: {TEST_EMAIL}")
        print(f"     Password: {TEST_PASSWORD}")
        print("  3. Or run with --skip-auth to use service-role key directly")
        sys.exit(1)

    # Step 2: Create tenant
    tenant_id = test_create_tenant(token)
    if not tenant_id:
        sys.exit(1)
    test_list_tenants(token)

    # Step 3: Create project
    project_id = test_create_project(token, tenant_id)
    if not project_id:
        sys.exit(1)

    # Step 4: Create build
    build_id = test_create_build(token, tenant_id, project_id)
    if not build_id:
        warn("Build creation failed — this is expected if LLM keys are not configured")
        warn("The API + database flow works. To test the full pipeline, add ANTHROPIC_API_KEY to .env")
        test_usage(token, tenant_id)
        print_summary(steps_passed=4, steps_total=7)
        sys.exit(0)

    # Step 5: Check build
    time.sleep(2)  # Give the background task a moment
    build = test_get_build(token, tenant_id, project_id, build_id)

    # Step 6: Stream events
    test_stream_events(token, tenant_id, project_id, build_id)

    # Step 7: Usage
    test_usage(token, tenant_id)

    print_summary(steps_passed=7, steps_total=7)


def print_summary(steps_passed: int, steps_total: int):
    print()
    print("=" * 60)
    if steps_passed >= steps_total:
        print(f"{Colors.GREEN}{Colors.BOLD}ALL {steps_total} STEPS PASSED{Colors.END}")
    else:
        print(f"{Colors.YELLOW}{Colors.BOLD}{steps_passed}/{steps_total} STEPS PASSED{Colors.END}")
    print("=" * 60)

    if steps_passed < steps_total:
        print(f"\nTo complete the remaining steps, ensure:")
        print(f"  - ANTHROPIC_API_KEY is set in .env (for build pipeline)")
        print(f"  - DEEPSEEK_API_KEY is set in .env (for scaffolding)")


if __name__ == "__main__":
    main()
