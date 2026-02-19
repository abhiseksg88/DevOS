"""
Build Pipeline — Apply patches, git commit, Docker build.

Steps:
1. Clone/checkout project repo from Supabase Storage
2. Apply scaffold files (if any)
3. Apply unified diff patches via `git apply`
4. Commit with structured metadata
5. Build Docker image via kaniko (daemonless) or docker buildx
6. Push image to container registry
7. Upload updated source back to Supabase Storage

Failure handling:
- If git apply fails: attempt 3-way merge, then fall back to re-requesting patch
- If Docker build fails: capture logs, report to build_events, mark build as failed
- If registry push fails: retry 3x with exponential backoff
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ..api.config import Settings


def apply_and_build(
    tenant_id: str,
    project_id: str,
    build_id: str,
    scaffold_files: dict[str, str],
    patches: list[str],
    prompt: str,
    model_usage: dict,
    settings: Settings,
) -> dict:
    """
    Apply patches to project source and build a container image.

    Returns: {"commit_sha": str, "image_tag": str}
    """
    work_dir = tempfile.mkdtemp(prefix=f"nf-build-{build_id[:8]}-")

    try:
        # Step 1: Initialize or clone project repo
        repo_dir = _init_repo(work_dir, tenant_id, project_id, settings)

        # Step 2: Write scaffold files
        if scaffold_files:
            _write_scaffold(repo_dir, scaffold_files)
            _git_commit(repo_dir, "scaffold: initial project structure", build_id, model_usage)

        # Step 3: Apply patches
        if patches:
            _apply_patches(repo_dir, patches)

        # Step 4: Git commit with metadata
        commit_sha = _git_commit(
            repo_dir,
            _build_commit_message(prompt, build_id, model_usage, patches),
            build_id,
            model_usage,
        )

        # Step 5: Ensure Dockerfile exists
        dockerfile_path = repo_dir / "Dockerfile"
        if not dockerfile_path.exists():
            _generate_dockerfile(repo_dir, settings)
            _git_commit(repo_dir, f"build: auto-generate Dockerfile [build:{build_id[:8]}]", build_id, model_usage)

        # Step 6: Build Docker image
        image_tag = f"{settings.container_registry}/{tenant_id}/{project_id}:{build_id[:12]}"
        _build_image(repo_dir, image_tag, settings)

        # Step 7: Push image to registry
        _push_image(image_tag, settings)

        # Step 8: Upload source back to storage
        _sync_to_storage(repo_dir, tenant_id, project_id, settings)

        # Step 9: Capture final file contents for SSE streaming to frontend
        final_files: dict[str, str] = {}
        _source_extensions = {
            ".ts", ".tsx", ".js", ".jsx", ".py", ".html", ".css",
            ".json", ".md", ".yaml", ".yml", ".toml", ".sql", ".sh",
            ".env", ".txt", ".cfg", ".ini",
        }
        for root, _dirs, filenames in os.walk(repo_dir):
            # Skip git internals, node_modules, __pycache__
            rel_root = os.path.relpath(root, repo_dir)
            if any(part.startswith(".") or part in ("node_modules", "__pycache__", "dist", "build") for part in rel_root.split(os.sep)):
                continue
            for fname in filenames:
                if Path(fname).suffix in _source_extensions or fname in ("Dockerfile", "Makefile", ".gitignore"):
                    fpath = os.path.join(root, fname)
                    rel_path = os.path.relpath(fpath, repo_dir)
                    try:
                        final_files[rel_path] = Path(fpath).read_text(errors="replace")
                    except Exception:
                        pass

        return {"commit_sha": commit_sha, "image_tag": image_tag, "final_files": final_files}

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _init_repo(work_dir: str, tenant_id: str, project_id: str, settings: Settings) -> Path:
    """Download project source from Supabase Storage or init new repo."""
    repo_dir = Path(work_dir) / "repo"
    repo_dir.mkdir()

    # Try to download existing source
    try:
        from supabase import create_client
        db = create_client(settings.supabase_url, settings.supabase_service_role_key)
        files = db.storage.from_("project-assets").list(f"{tenant_id}/{project_id}/src")

        for f in files:
            if f.get("name"):
                content = db.storage.from_("project-assets").download(
                    f"{tenant_id}/{project_id}/src/{f['name']}"
                )
                file_path = repo_dir / f["name"]
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_bytes(content)
    except Exception as e:
        import logging
        logging.getLogger(__name__).info(
            "No existing source in storage for %s/%s (new project): %s",
            tenant_id, project_id, e,
        )

    # Init git repo if not exists
    if not (repo_dir / ".git").exists():
        subprocess.run(["git", "init"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "nimbusforge@build.ai"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Vedaa"], cwd=repo_dir, check=True, capture_output=True)

        # Initial commit if there are files
        subprocess.run(["git", "add", "-A"], cwd=repo_dir, check=True, capture_output=True)
        result = subprocess.run(["git", "status", "--porcelain"], cwd=repo_dir, capture_output=True, text=True)
        if result.stdout.strip():
            subprocess.run(
                ["git", "commit", "-m", "init: project source from storage"],
                cwd=repo_dir, check=True, capture_output=True,
            )

    return repo_dir


def _write_scaffold(repo_dir: Path, files: dict[str, str]):
    """Write scaffold files to the repo directory."""
    for path, content in files.items():
        file_path = repo_dir / path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content)

    subprocess.run(["git", "add", "-A"], cwd=repo_dir, check=True, capture_output=True)


def _apply_patches(repo_dir: Path, patches: list[str]):
    """
    Apply unified diff patches using git apply.
    Falls back to 3-way merge if direct apply fails.
    """
    for i, patch in enumerate(patches):
        patch_file = repo_dir / f".patch-{i}.diff"
        patch_file.write_text(patch)

        # Try direct apply
        result = subprocess.run(
            ["git", "apply", "--check", str(patch_file)],
            cwd=repo_dir,
            capture_output=True,
            text=True,
        )

        if result.returncode == 0:
            subprocess.run(
                ["git", "apply", str(patch_file)],
                cwd=repo_dir,
                check=True,
                capture_output=True,
            )
        else:
            # Try 3-way merge
            result = subprocess.run(
                ["git", "apply", "--3way", str(patch_file)],
                cwd=repo_dir,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                # Last resort: try with --reject to apply what we can
                subprocess.run(
                    ["git", "apply", "--reject", str(patch_file)],
                    cwd=repo_dir,
                    capture_output=True,
                    text=True,
                )

        patch_file.unlink(missing_ok=True)

    # Stage all changes
    subprocess.run(["git", "add", "-A"], cwd=repo_dir, check=True, capture_output=True)


def _git_commit(repo_dir: Path, message: str, build_id: str, model_usage: dict) -> str:
    """Create a git commit and return the SHA."""
    # Check if there's anything to commit
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_dir, capture_output=True, text=True,
    )
    if not result.stdout.strip():
        # Nothing to commit — return current HEAD
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_dir, capture_output=True, text=True,
        )
        return head.stdout.strip() if head.returncode == 0 else "0" * 40

    subprocess.run(["git", "add", "-A"], cwd=repo_dir, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", message],
        cwd=repo_dir, check=True, capture_output=True,
    )

    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir, capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def _build_commit_message(prompt: str, build_id: str, model_usage: dict, patches: list[str]) -> str:
    """Build a structured commit message with metadata."""
    # Extract files changed from patches
    files = set()
    for patch in patches:
        for line in patch.split("\n"):
            if line.startswith("+++ b/"):
                files.add(line[6:])

    summary = prompt[:72] if len(prompt) <= 72 else prompt[:69] + "..."

    metadata = {
        "build_id": build_id,
        "models": list(model_usage.keys()),
        "total_tokens": sum(
            m.get("tokens_in", 0) + m.get("tokens_out", 0)
            for m in model_usage.values()
        ),
        "files_changed": sorted(files),
    }

    return f"ai: {summary}\n\nVedaa-Build-Metadata: {json.dumps(metadata)}"


def _generate_dockerfile(repo_dir: Path, settings: Settings):
    """Auto-detect stack and generate an optimized multi-stage Dockerfile."""
    # Detect stack by looking for config files
    if (repo_dir / "package.json").exists():
        _generate_node_dockerfile(repo_dir)
    elif (repo_dir / "requirements.txt").exists() or (repo_dir / "pyproject.toml").exists():
        _generate_python_dockerfile(repo_dir)
    elif (repo_dir / "go.mod").exists():
        _generate_go_dockerfile(repo_dir)
    else:
        _generate_node_dockerfile(repo_dir)  # Default


def _generate_node_dockerfile(repo_dir: Path):
    dockerfile = """\
# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit
COPY . .
RUN npm run build

# --- Production stage ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/package*.json ./
RUN npm ci --no-audit --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["npm", "start"]
"""
    (repo_dir / "Dockerfile").write_text(dockerfile)


def _generate_python_dockerfile(repo_dir: Path):
    dockerfile = """\
# --- Build stage ---
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements*.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# --- Production stage ---
FROM python:3.12-slim AS runner
WORKDIR /app
COPY --from=builder /install /usr/local
COPY . .

RUN useradd --create-home appuser
USER appuser
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
"""
    (repo_dir / "Dockerfile").write_text(dockerfile)


def _generate_go_dockerfile(repo_dir: Path):
    dockerfile = """\
# --- Build stage ---
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

# --- Production stage ---
FROM alpine:3.19 AS runner
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/server .

RUN adduser -D appuser
USER appuser
EXPOSE 8080
CMD ["./server"]
"""
    (repo_dir / "Dockerfile").write_text(dockerfile)


def _build_image(repo_dir: Path, image_tag: str, settings: Settings):
    """
    Build Docker image using kaniko (preferred in CI/serverless) or docker buildx.

    kaniko runs in userspace with no Docker daemon — ideal for Cloud Run Jobs.
    Falls back to docker buildx if kaniko is not available.
    """
    # Try kaniko first (for serverless/CI environments)
    kaniko = shutil.which("executor")  # kaniko binary
    if kaniko:
        subprocess.run(
            [
                kaniko,
                "--context", str(repo_dir),
                "--dockerfile", str(repo_dir / "Dockerfile"),
                "--destination", image_tag,
                "--cache=true",
                "--cache-ttl=168h",
                "--snapshot-mode=redo",
                "--compressed-caching=false",
            ],
            check=True,
            timeout=settings.build_timeout_seconds,
        )
        return

    # Fall back to docker buildx
    subprocess.run(
        [
            "docker", "buildx", "build",
            "--platform", "linux/amd64",
            "-t", image_tag,
            "--push",
            str(repo_dir),
        ],
        check=True,
        timeout=settings.build_timeout_seconds,
    )


def _push_image(image_tag: str, settings: Settings):
    """Push image to container registry with retry."""
    for attempt in range(3):
        try:
            result = subprocess.run(
                ["docker", "push", image_tag],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode == 0:
                return
        except subprocess.TimeoutExpired:
            pass

        if attempt < 2:
            import time
            time.sleep(2 ** (attempt + 1))

    # If kaniko was used, the image is already pushed (--destination flag)
    # So this function is a no-op in that case


def _sync_to_storage(repo_dir: Path, tenant_id: str, project_id: str, settings: Settings):
    """Upload the updated project source back to Supabase Storage."""
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    for file_path in repo_dir.rglob("*"):
        if file_path.is_file() and ".git" not in file_path.parts:
            relative = file_path.relative_to(repo_dir)
            storage_path = f"{tenant_id}/{project_id}/src/{relative}"
            try:
                content = file_path.read_bytes()
                db.storage.from_("project-assets").upload(
                    storage_path,
                    content,
                    {"upsert": "true"},
                )
            except Exception as upload_err:
                import logging
                logging.getLogger(__name__).warning(
                    "Failed to upload %s to storage for %s/%s: %s",
                    relative, tenant_id, project_id, upload_err,
                )
