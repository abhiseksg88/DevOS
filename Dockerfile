# =============================================================================
# NimbusForge Control Plane — Production Dockerfile
# Multi-stage build for the FastAPI + Agent Orchestrator
# =============================================================================

# --- Build stage ---
FROM python:3.12-slim AS builder

WORKDIR /app

# Install build dependencies (gcc for C extensions, libffi/libssl for cryptography)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    git \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# --- Production stage ---
FROM python:3.12-slim AS runner

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

COPY nimbusforge/ ./nimbusforge/

RUN useradd --create-home appuser
USER appuser

# Railway dynamically assigns PORT; default to 8000 for local dev
ENV PORT=8000
EXPOSE ${PORT}

# Health check (uses PORT env var)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Single worker mode for Railway (memory constrained)
# Use shell form so $PORT gets expanded at runtime
CMD uvicorn nimbusforge.api.main:app --host 0.0.0.0 --port $PORT --log-level info
