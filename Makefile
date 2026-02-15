# =============================================================================
# NimbusForge — Development Commands
# =============================================================================

.PHONY: setup install db-setup run test-flow test-health clean

# ---------- First-time setup (run once) ----------

setup: install db-setup
	@echo ""
	@echo "=== Setup complete ==="
	@echo "1. Edit .env with your real API keys"
	@echo "2. Run: make run"
	@echo "3. In another terminal: make test-flow"

install:
	@echo ">>> Installing Python dependencies..."
	pip install -r requirements.txt
	@echo ">>> Done."

db-setup:
	@echo ">>> Checking .env exists..."
	@test -f .env || (echo "ERROR: .env not found. Run: cp .env.example .env && edit it" && exit 1)
	@echo ">>> To set up the database:"
	@echo "    Option A (Supabase Dashboard): Paste supabase/migrations/001_core_schema.sql into SQL Editor"
	@echo "    Option B (Supabase CLI):       supabase db push"
	@echo "    Option C (Test mode):          make db-setup-test"

db-setup-test:
	@echo ">>> Running test-compatible schema against Supabase..."
	python scripts/setup_db.py

# ---------- Run the API ----------

run:
	@echo ">>> Starting NimbusForge API on http://localhost:8000"
	@echo ">>> Swagger docs at http://localhost:8000/docs"
	uvicorn platform.api.main:app --host 0.0.0.0 --port 8000 --reload

run-prod:
	uvicorn platform.api.main:app --host 0.0.0.0 --port 8000 --workers 4

# ---------- Testing ----------

test-health:
	@curl -s http://localhost:8000/health | python -m json.tool

test-flow:
	@echo ">>> Running end-to-end test flow..."
	python scripts/test_flow.py

# ---------- Cleanup ----------

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
