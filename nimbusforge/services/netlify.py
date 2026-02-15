"""
Netlify API client for one-click publish.

Deploys a self-contained index.html (React + Babel + Tailwind + Supabase)
to a per-project Netlify site using the file digest API.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import time

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://api.netlify.com/api/v1"


class NetlifyService:
    """Thin wrapper around the Netlify REST API."""

    def __init__(self, token: str, team_slug: str, site_prefix: str):
        self.headers = {"Authorization": f"Bearer {token}"}
        self.team_slug = team_slug
        self.site_prefix = site_prefix

    # ------------------------------------------------------------------
    # Sites
    # ------------------------------------------------------------------

    def create_site(self, project_slug: str) -> dict:
        """Create a new Netlify site for the project.

        Returns ``{"site_id": ..., "url": ..., "name": ...}``.
        """
        site_name = f"{self.site_prefix}-{project_slug}"

        resp = httpx.post(
            f"{BASE_URL}/{self.team_slug}/sites",
            headers=self.headers,
            json={"name": site_name},
            timeout=30,
        )

        # 422 means name is taken — append random suffix and retry once
        if resp.status_code == 422:
            site_name = f"{site_name}-{secrets.token_hex(3)}"
            logger.info("Site name taken, retrying with: %s", site_name)
            resp = httpx.post(
                f"{BASE_URL}/{self.team_slug}/sites",
                headers=self.headers,
                json={"name": site_name},
                timeout=30,
            )

        resp.raise_for_status()
        data = resp.json()
        logger.info("Created Netlify site: %s (%s)", data["name"], data["id"])
        return {
            "site_id": data["id"],
            "url": data.get("ssl_url") or data.get("url", ""),
            "name": data["name"],
        }

    def delete_site(self, site_id: str) -> None:
        """Delete a Netlify site."""
        resp = httpx.delete(
            f"{BASE_URL}/sites/{site_id}",
            headers=self.headers,
            timeout=30,
        )
        resp.raise_for_status()
        logger.info("Deleted Netlify site: %s", site_id)

    # ------------------------------------------------------------------
    # Deploys
    # ------------------------------------------------------------------

    def deploy_html(self, site_id: str, html: str) -> dict:
        """Deploy a single ``index.html`` to the Netlify site.

        Uses the file-digest method:
        1. POST digest → Netlify returns list of files it needs
        2. PUT each required file

        Returns ``{"deploy_id": ..., "url": ..., "state": ...}``.
        """
        html_bytes = html.encode("utf-8")
        sha1 = hashlib.sha1(html_bytes).hexdigest()

        # Step 1: create deploy with file digest
        resp = httpx.post(
            f"{BASE_URL}/sites/{site_id}/deploys",
            headers=self.headers,
            json={"files": {"/index.html": sha1}},
            timeout=30,
        )
        resp.raise_for_status()
        deploy = resp.json()
        deploy_id = deploy["id"]

        # Step 2: upload file if Netlify doesn't already have it
        required = deploy.get("required", [])
        if sha1 in required:
            logger.info("Uploading index.html to deploy %s", deploy_id)
            upload_resp = httpx.put(
                f"{BASE_URL}/deploys/{deploy_id}/files/index.html",
                headers={
                    **self.headers,
                    "Content-Type": "application/octet-stream",
                },
                content=html_bytes,
                timeout=60,
            )
            upload_resp.raise_for_status()
        else:
            logger.info("index.html already cached, skipping upload")

        return {
            "deploy_id": deploy_id,
            "url": deploy.get("ssl_url") or deploy.get("url", ""),
            "state": deploy.get("state", "uploading"),
        }

    # ------------------------------------------------------------------
    # Status polling
    # ------------------------------------------------------------------

    def get_deploy_status(self, deploy_id: str) -> dict:
        """Get current deploy status.

        Returns ``{"state": ..., "url": ...}``.
        States: ``preparing`` → ``uploading`` → ``uploaded`` → ``ready``
        """
        resp = httpx.get(
            f"{BASE_URL}/deploys/{deploy_id}",
            headers=self.headers,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "state": data.get("state", "unknown"),
            "url": data.get("ssl_url") or data.get("url", ""),
        }

    def wait_for_ready(self, deploy_id: str, max_wait: int = 120) -> dict:
        """Block until deploy reaches ``ready`` state or raise on timeout/error.

        Returns final ``{"state": "ready", "url": ...}``.
        """
        deadline = time.monotonic() + max_wait
        while time.monotonic() < deadline:
            status = self.get_deploy_status(deploy_id)
            if status["state"] == "ready":
                logger.info("Deploy %s is ready: %s", deploy_id, status["url"])
                return status
            if status["state"] in ("error", "failed"):
                raise RuntimeError(f"Deploy {deploy_id} failed with state: {status['state']}")
            time.sleep(2)

        raise TimeoutError(f"Deploy {deploy_id} not ready after {max_wait}s")
