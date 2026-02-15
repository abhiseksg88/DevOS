# NimbusForge — 90-Day Roadmap

## Phase 1: Foundation (Days 1–30)

### Week 1–2: Core Infrastructure
- [ ] Supabase project setup (Postgres, Auth, Realtime, Storage)
- [ ] Run SQL migration: `001_core_schema.sql` — tables, indexes, RLS, triggers
- [ ] Configure Auth providers: Google OAuth, GitHub OAuth
- [ ] Create `project-assets` storage bucket with RLS policies
- [ ] Deploy FastAPI control plane to Cloud Run (single region: us-central1)
- [ ] Wire up Supabase service-role key for backend writes
- [ ] Implement JWT validation middleware
- [ ] Basic CRUD: tenants, tenant_members, projects

### Week 2–3: Agent Pipeline v1
- [ ] LLM Router: Anthropic (Opus/Sonnet/Haiku) + DeepSeek integration
- [ ] Planner agent: prompt -> structured plan JSON
- [ ] Coder agent: plan -> unified diff patches (Sonnet)
- [ ] Reviewer agent: patches -> approve/reject (Haiku)
- [ ] Plan caching with SHA-256 prompt hash + TTL
- [ ] build_events streaming via SSE
- [ ] Usage logging: every LLM call tracked with tokens + cost

### Week 3–4: Build Pipeline v1
- [ ] Git repo management: init, apply patches, commit with metadata
- [ ] Dockerfile auto-generation (Node.js, Python, Go)
- [ ] Docker image build via kaniko (Cloud Run Jobs)
- [ ] Push to GCR (Google Container Registry)
- [ ] Deploy to Cloud Run with preview URL
- [ ] Basic health check post-deploy

**Milestone**: End-to-end flow works. User types prompt -> gets preview URL.

## Phase 2: Product Polish (Days 31–60)

### Week 5–6: Frontend MVP
- [ ] Next.js app with Supabase Auth (Google/GitHub login)
- [ ] Project dashboard: create/list/archive projects
- [ ] Build UI: prompt input -> real-time streaming build log
- [ ] Preview panel: embedded iframe with live preview
- [ ] Monaco editor for viewing generated/patched code
- [ ] Responsive layout (desktop-first, mobile-functional)

### Week 6–7: Agent Improvements
- [ ] Scaffolder agent (DeepSeek): full project generation from template
- [ ] Coder<->Reviewer loop with max 5 iterations
- [ ] Fallback chain: Opus->Sonnet, Sonnet->DeepSeek
- [ ] Memory files: architecture.md, api_contracts.md, design_system.json
- [ ] Context retrieval: RAG over project files for relevant context
- [ ] Retry logic with exponential backoff on provider errors

### Week 7–8: Deploy & Preview
- [ ] Subdomain-based preview routing via Caddy
- [ ] Wildcard SSL certificate (Let's Encrypt + Cloudflare DNS)
- [ ] Preview cleanup cron: stale detection (72h), soft stop, hard delete (7d)
- [ ] Rollback: one-click rollback to previous revision
- [ ] Fly.io as alternative deploy provider
- [ ] Deploy status webhooks

**Milestone**: Usable product for internal testing. Full build/deploy/preview cycle with real UI.

## Phase 3: Scale & Harden (Days 61–90)

### Week 9–10: Cost Control & Multi-tenancy
- [ ] Budget enforcement: pre-call check, hard stop at 100%, warning at 80%
- [ ] Rate limiting: sliding window per tenant, configurable per plan tier
- [ ] Abuse detection: token velocity, build bombs, cost spikes
- [ ] Auto-suspension for critical abuse
- [ ] Usage dashboard: tokens, cost, builds per model, per day
- [ ] Billing integration (Stripe): free/pro/enterprise plans
- [ ] Audit log viewer for tenant admins

### Week 10–11: Reliability & Performance
- [ ] Circuit breaker for Supabase + LLM providers
- [ ] Redis for rate limiting (multi-instance ready)
- [ ] Background job queue (Celery/ARQ) instead of FastAPI background tasks
- [ ] Build timeout enforcement (kill at 10 min)
- [ ] Structured logging (JSON) + error tracking (Sentry)
- [ ] Health check endpoints for all services
- [ ] Load testing: 100 concurrent builds

### Week 11–12: Enterprise Features
- [ ] Team management: invite members, role-based access (owner/admin/member/viewer)
- [ ] Custom domains for deployed apps
- [ ] Environment variables management (encrypted)
- [ ] GitHub integration: push to repo, PR on every build
- [ ] API keys for CI/CD integration
- [ ] Webhook triggers (GitHub push -> auto-build)
- [ ] SOC2 prep: audit logs, data encryption, access controls

**Milestone**: Production-ready for beta launch. Multi-tenant, cost-controlled, reliable.

---

## Post-90-Day Horizon

### Q2: Growth
- Multi-region deployment (EU, APAC)
- Collaborative editing (multiple users on same project)
- Template marketplace (starter projects)
- Plugin system for custom agents
- VS Code extension

### Q3: Enterprise
- SSO (SAML/OIDC)
- Private VPC deployment
- Dedicated compute
- Compliance certifications (SOC2 Type II, GDPR)
- SLA guarantees (99.9%)

### Q4: Platform
- Kubernetes support (EKS/GKE)
- Database provisioning (managed Postgres per project)
- Serverless functions
- CDN integration
- AI-powered monitoring and auto-scaling

---

## Risks & Mitigations

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM generates insecure code | High | Critical | Haiku reviewer agent with OWASP checklist; pre-deploy security scan (Semgrep); never trust LLM output without review |
| Patch apply failures (git conflicts) | High | Medium | 3-way merge fallback; re-request patch with full file context; worst case: regenerate file (flag as exception) |
| Build timeout / hang | Medium | Medium | 10-minute hard timeout; kill process; mark failed; alert user |
| Provider outage (Anthropic/DeepSeek) | Medium | High | Fallback chain across providers; queue builds during outage; circuit breaker with 30s recovery |
| Docker build failures | Medium | Medium | Validate Dockerfile before build; cache base images; retry with simplified Dockerfile |
| Preview URL hijacking | Low | Critical | Preview URLs use cryptographic build IDs (UUID4); no enumeration possible; optional per-preview auth |
| Supabase Realtime drops | Medium | Low | SSE fallback endpoint; client-side reconnection with exponential backoff; event replay via `after_seq` |
| Storage quota exhaustion | Medium | Medium | Per-tenant storage quotas; warn at 80%; auto-archive old builds |

### Business Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM cost overruns | High | High | Strict budget enforcement; plan caching (Opus is expensive); use cheapest capable model; batch scaffolding with DeepSeek |
| Multi-tenant data leak | Low | Critical | RLS on every table; tenant_id on every row; no admin bypass; automated RLS testing; security audit |
| Competitor speed | High | Medium | Focus on patch-only (faster than regen); memory system (better context = fewer iterations); deploy speed (preview in <60s) |
| User generates malicious apps | Medium | High | Container sandboxing; no outbound network by default; resource limits per container; abuse detection |
| Regulatory compliance | Medium | Medium | Data residency options; audit logs; encryption at rest; GDPR data deletion support from day 1 |

### Operational Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Orphaned containers (cost leak) | High | Medium | Aggressive cleanup cron; stale detection; monthly reconciliation; billing alerts |
| Database performance degradation | Medium | Medium | Proper indexes (already defined); partition usage_events by month; connection pooling via PgBouncer |
| Secrets exposure | Low | Critical | Never store API keys in code; use Secret Manager; rotate keys quarterly; audit access |

---

## Success Metrics (90-Day Targets)

| Metric | Target |
|--------|--------|
| Prompt-to-preview latency | <90 seconds (p50) |
| Build success rate | >85% |
| Patch apply success rate | >95% |
| Review approval rate (first pass) | >70% |
| Cost per build (average) | <$0.15 |
| Uptime | >99.5% |
| Active beta users | 50+ |
| Projects created | 200+ |

---

## Team Requirements

| Role | Count | When |
|------|-------|------|
| Founding engineer (full-stack) | 1 | Day 1 |
| Backend/infra engineer | 1 | Week 3 |
| Frontend engineer | 1 | Week 5 |
| DevOps/SRE | 0.5 | Week 8 (contract) |
| Design | 0.5 | Week 5 (contract) |

Total: 3 FTEs + 1 contractor for first 90 days.
