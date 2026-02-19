# Master Admin / AI Command Centre — CTO Requirements & Build Plan

## 0) Executive Intent

Build a **company-level Super Admin portal** ("AI Command Centre") that gives leadership and SRE/Platform teams full control over:

- Tenant health, spend, and risk
- Build orchestration and failure recovery
- Model routing + policy enforcement
- Deploy governance and incident response
- Security, audit, and compliance workflows

This plan is grounded in what already exists in the backend (FastAPI, Supabase, orchestration, Nexus, budget controls) and defines what to add to make it enterprise-grade.

---

## 1) Backend Configuration Feedback (Current State)

## 1.1 What is configured well today

1. **Strong config backbone (Pydantic settings + validation)**
   - Centralized settings include Supabase, model IDs, deploy settings, CORS, build limits, and Netlify knobs.
   - Critical requirement enforcement already exists for `SUPABASE_SERVICE_ROLE_KEY`.

2. **Clear API domain surfaces already exist**
   - Tenants, projects, builds, deployments, publish, usage, integrations, and Nexus endpoints are already exposed.

3. **Core governance primitives are present**
   - Auth user object supports tenant access checks and service-role distinction.
   - Budget checks and rate limiting dependencies are already wired.
   - Abuse detector logic exists (token velocity, build bombs, cost spikes).

4. **Advanced orchestration assets already exist**
   - LangGraph-style multi-agent orchestrator and model router are in place.
   - Neural Nexus state engine exists for context/feedback intelligence.

## 1.2 CTO concerns / configuration gaps

1. **Single control-plane boundary is not fully enforced**
   - Some high-impact logic still runs in Next API routes (generation/swarm/publish/nexus proxy), creating policy drift risk.

2. **No dedicated “platform-admin” API surface**
   - Existing endpoints are mostly tenant/project scoped; we need company-wide admin APIs with strict RBAC + reason codes.

3. **Rate limiting strategy needs hardening for distributed scale**
   - In-memory style controls (in parts of stack) are not enough for multi-instance global limits.

4. **Audit/event taxonomy is not yet unified**
   - We have usage/build events, but no single canonical immutable admin audit stream for every privileged action.

5. **Operational controls are reactive, not command-centre-first**
   - Need proactive controls: global kill switches, model disable lists, tenant quarantine, deployment freeze windows.

---

## 2) Target Product: “AI Command Centre” (Super Admin)

## 2.1 Primary users

- CTO / VP Engineering
- Platform/SRE Lead
- Security/Compliance Lead
- FinOps Lead
- On-call Incident Commander

## 2.2 Non-negotiable outcomes

- One pane of glass for platform-level state
- Hard controls over cost/risk/blast radius
- Explainable governance decisions (who did what, when, and why)
- Fast incident response (minutes, not hours)

---

## 3) Functional Requirements (Master Admin)

## 3.1 Platform Overview Dashboard

Must show near-real-time KPIs:

- Active tenants, active builds, failure rate (5m/1h/24h)
- Spend burn rate (hour/day/month), budget breach forecasts
- Queue depth, median build latency, p95 deploy latency
- Provider health (Anthropic, DeepSeek, Supabase, Netlify)
- Security posture score (abuse findings, suspicious activity)

## 3.2 Tenant Command Console

For each tenant:

- Billing + usage timeline (tokens, build count, cost)
- Current throttles and policy profile
- Recent failures and unresolved incidents
- Risk flags from abuse detector
- Controls:
  - Pause/resume tenant build rights
  - Override limits (temporary with expiry)
  - Quarantine tenant (read-only emergency mode)
  - Force token/session invalidation

## 3.3 Build Orchestration Control Room

- Live global build board (queued/running/blocked/failed)
- Drill-down into each build: stage timings, model calls, costs, errors
- Actions:
  - Cancel build
  - Retry stage from checkpoint
  - Re-route model tier
  - Push to manual approval state

## 3.4 AI Policy & Model Governance

- Model registry view:
  - allowed models
  - default tier mapping per task type
  - per-tenant model policy overrides
- Prompt/policy versioning:
  - active prompt set id
  - canary rollout percentage
  - rollback to previous prompt set
- Safety policies:
  - deny-list prompts/patterns
  - data exfiltration patterns
  - prohibited deployment types

## 3.5 Deployment Governance Centre

- Global deployment feed by provider/region
- Approval matrix for production publish
- Freeze window controls (e.g., weekends/releases)
- Emergency actions:
  - Global publish freeze
  - Tenant-specific deploy lock
  - Rollback to last known healthy release

## 3.6 Security, Compliance & Audit Hub

- Immutable admin audit log (WORM-like semantics)
- Privileged action records include:
  - actor, role, time, IP, reason code, ticket link, diff of config change
- Compliance exports (SOC2/GDPR evidence bundles)
- Secret and key posture dashboard (age/rotation status)

## 3.7 Incident & Runbook Automation

- Incident declaration and severity tagging
- Auto-playbooks:
  - cost spike playbook
  - model outage playbook
  - deployment failure storm playbook
- Timeline + postmortem artifact generation

## 3.8 Neural Nexus Governance View

- Nexus quality indicators (context size, freshness, retrieval hit quality)
- Feedback ingestion health
- Controls:
  - reset/rebuild project state matrix
  - mute bad feedback loops
  - reindex component RAG corpus

---

## 4) Technical Architecture for Admin Portal

## 4.1 New backend domain: `platform_admin`

Add a dedicated FastAPI router namespace:

- `/platform-admin/overview`
- `/platform-admin/tenants/{id}/controls`
- `/platform-admin/builds/*`
- `/platform-admin/policies/*`
- `/platform-admin/deployments/*`
- `/platform-admin/incidents/*`
- `/platform-admin/audit/*`

All endpoints require `platform_admin` role + step-up authentication for destructive actions.

## 4.2 Data model additions (Supabase/Postgres)

1. `platform_admin_roles`
   - user_id, role, scopes, granted_by, expires_at

2. `platform_control_flags`
   - scope (`global|tenant|project`), key, value, reason, expires_at

3. `platform_audit_log`
   - immutable append-only log for privileged actions

4. `incident_records`
   - incident metadata, severity, owner, status, timeline events

5. `policy_versions`
   - model routing, prompt policy, rollout metadata

6. `system_health_snapshots`
   - periodic metrics for trend charts

## 4.3 Event pipeline

- Standardize events from builds, usage, deploy, abuse detector, and admin actions into a canonical event schema.
- Persist to unified event store table + stream to dashboard via SSE/WebSocket.

## 4.4 Guardrails

- Two-person rule for highest-risk actions:
  - global model disable
  - global publish freeze
  - tenant data purge
- Time-bound overrides auto-expire.
- Mandatory reason code + optional ticket URL for every privileged mutation.

---

## 5) UX Requirements (Super Admin Experience)

## 5.1 Information hierarchy

1. **Global posture first** (red/yellow/green)
2. **Drill-down by tenant/system/component**
3. **Action panel always visible** with safe defaults

## 5.2 Interaction model

- Every destructive action: preview impact + confirmation phrase
- Real-time updates without page refresh
- Keyboard-first command palette for operators

## 5.3 Core pages

1. Overview
2. Tenants
3. Builds
4. AI Policies
5. Deployments
6. Security & Audit
7. Incidents
8. Nexus Governance

---

## 6) Security Requirements (Must Have)

- RBAC + ABAC (scope constraints by environment/tenant)
- Step-up auth for sensitive actions
- Signed audit events (tamper-evident chain hash)
- Strict server-side authorization checks (never trust client role claims)
- Secret redaction in logs and UI

---

## 7) Delivery Plan (90 Days)

## Phase 1 (Weeks 1-3): Foundations

- Define admin RBAC model
- Create `platform_admin` backend router + read-only overview endpoints
- Add `platform_audit_log` table and middleware hook for privileged actions
- Ship Admin Overview MVP

## Phase 2 (Weeks 4-6): Operational Controls

- Tenant controls (pause/quarantine/limit override)
- Build control room with cancel/retry/reroute actions
- Global control flags service
- Incident declaration + timeline tracking

## Phase 3 (Weeks 7-9): AI & Deploy Governance

- Policy versioning and model routing controls
- Deploy freeze/lock workflows
- Approval flows and reason-code enforcement
- Nexus governance controls

## Phase 4 (Weeks 10-12): Hardening & Compliance

- Two-person approvals for critical actions
- Compliance export packs
- SLO dashboards + alerting integration
- Game-day exercises and incident runbook validation

---

## 8) Org & Operating Model

- **Admin Product Owner**: CTO delegate
- **Platform Engineering**: backend controls + event model
- **Security**: policy and audit requirements
- **FinOps**: cost policy thresholds
- **On-call rotation**: command centre operational ownership

Weekly governance review:

- Top incidents
- Budget breaches
- Policy changes
- Failed deployments
- Abuse findings and remediations

---

## 9) Success Metrics (for Master Admin)

1. MTTR for platform incidents < 20 minutes
2. Cost anomaly detection-to-mitigation < 5 minutes
3. 100% privileged actions captured in immutable audit log
4. 0 unauthorized admin actions
5. Build failure storm containment within 10 minutes
6. Deployment rollback success > 99%

---

## 10) Immediate Next Steps (This Week)

1. Align architecture decision: backend as sole control plane for privileged workflows.
2. Draft `platform_admin` API spec and RBAC matrix.
3. Create migration for `platform_admin_roles`, `platform_control_flags`, `platform_audit_log`, `incident_records`, `policy_versions`.
4. Ship read-only Admin Overview page with real metrics from existing usage/build/deploy tables.
5. Add privileged-action audit middleware before exposing mutation endpoints.

If we execute this plan, the Admin Portal becomes the company’s **true AI Command Centre**: safe, observable, governable, and decisive in incident conditions.
