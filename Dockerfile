# =============================================================================
# NimbusForge Control Plane — Production Dockerfile
# Multi-stage build for the FastAPI + Agent Orchestrator
# =============================================================================

# --- Build stage ---
FROM python:3.12-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# --- Production stage ---
FROM python:3.12-slim AS runner

WORKDIR /app

# Install runtime dependencies (git for patch operations, docker CLI for builds)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install kaniko executor for daemonless Docker builds
# (In production, kaniko runs as a separate Cloud Run Job. This is for dev.)
# RUN curl -L https://github.com/GoogleContainerTools/kaniko/releases/latest/download/executor -o /usr/local/bin/executor \
#     && chmod +x /usr/local/bin/executor

COPY --from=builder /install /usr/local

COPY platform/ ./platform/

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "platform.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
