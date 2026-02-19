"""
Pydantic models for API request/response schemas.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums (mirror SQL types)
# ---------------------------------------------------------------------------

class TenantRole(str, Enum):
    owner = "owner"
    admin = "admin"
    member = "member"
    viewer = "viewer"

class ProjectStatus(str, Enum):
    active = "active"
    archived = "archived"
    suspended = "suspended"

class BuildStatus(str, Enum):
    queued = "queued"
    planning = "planning"
    awaiting_approval = "awaiting_approval"
    scaffolding = "scaffolding"
    coding = "coding"
    reviewing = "reviewing"
    building = "building"
    deploying = "deploying"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"

class DeploymentStatus(str, Enum):
    pending = "pending"
    active = "active"
    draining = "draining"
    stopped = "stopped"
    failed = "failed"
    rolled_back = "rolled_back"

class PlanTier(str, Enum):
    free = "free"
    pro = "pro"
    enterprise = "enterprise"

class IntegrationCategory(str, Enum):
    llm = "llm"
    auth = "auth"
    database = "database"
    payment = "payment"
    email = "email"
    storage = "storage"
    analytics = "analytics"
    custom = "custom"

class IntegrationStatus(str, Enum):
    active = "active"
    inactive = "inactive"
    error = "error"


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class TenantCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    slug: str = Field(..., min_length=1, max_length=50, pattern=r"^[a-z0-9\-]+$")
    plan: PlanTier = PlanTier.free

class TenantUpdate(BaseModel):
    name: Optional[str] = None
    plan: Optional[PlanTier] = None
    monthly_budget_usd: Optional[float] = None
    settings: Optional[dict] = None

class MemberInvite(BaseModel):
    email: str
    role: TenantRole = TenantRole.member

class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    slug: str = Field(..., min_length=1, max_length=50, pattern=r"^[a-z0-9\-]+$")
    description: str = ""
    stack: dict = Field(default_factory=dict)

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[ProjectStatus] = None
    stack: Optional[dict] = None
    settings: Optional[dict] = None

class BuildCreate(BaseModel):
    """User submits a natural-language prompt to trigger a build."""
    prompt: str = Field(..., min_length=1, max_length=10000)

class DeploymentCreate(BaseModel):
    build_id: UUID
    provider: str = "cloudrun"
    region: str = "us-central1"

class RollbackRequest(BaseModel):
    deployment_id: UUID

class IntegrationCreate(BaseModel):
    """Add an integration connector to a project."""
    provider: str = Field(..., min_length=1, max_length=50, pattern=r"^[a-z0-9_\-]+$")
    category: IntegrationCategory
    display_name: str = Field(..., min_length=1, max_length=100)
    credentials: dict = Field(default_factory=dict)
    config: dict = Field(default_factory=dict)

class IntegrationUpdate(BaseModel):
    """Update an integration's credentials or config."""
    display_name: Optional[str] = None
    credentials: Optional[dict] = None
    config: Optional[dict] = None
    status: Optional[IntegrationStatus] = None


class BuildApproval(BaseModel):
    """User approves, modifies, or rejects a build plan (HITL checkpoint)."""
    action: str = Field(..., pattern=r"^(approve|modify|reject)$")
    modified_plan: Optional[dict] = None
    notes: Optional[str] = None


class PublishRequest(BaseModel):
    """Frontend sends the fully-built HTML document to deploy."""
    html: str = Field(..., min_length=1, description="Complete HTML to deploy to Netlify")
    custom_subdomain: Optional[str] = Field(
        None,
        max_length=40,
        pattern=r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$",
        description="Custom subdomain slug (e.g. 'my-app' for my-app.vedaa.io)",
    )

class PublishResponse(BaseModel):
    deploy_id: str
    url: str
    status: str  # 'deploying' | 'ready' | 'failed'
    netlify_site_id: str
    custom_domain: Optional[str] = None

class PublishStatusResponse(BaseModel):
    state: str  # 'preparing' | 'uploading' | 'uploaded' | 'ready' | 'error'
    url: str

class SubdomainCheckResponse(BaseModel):
    available: bool
    subdomain: str
    domain: str
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class TenantResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    plan: PlanTier
    monthly_budget_usd: float
    monthly_spent_usd: float
    created_at: datetime

class MemberResponse(BaseModel):
    id: UUID
    user_id: UUID
    role: TenantRole
    created_at: datetime

class ProjectResponse(BaseModel):
    id: UUID
    tenant_id: UUID
    name: str
    slug: str
    description: str
    status: ProjectStatus
    stack: dict
    created_at: datetime
    updated_at: datetime

class BuildResponse(BaseModel):
    id: UUID
    tenant_id: UUID
    project_id: UUID
    status: BuildStatus
    prompt: str
    files_changed: list[str]
    commit_sha: Optional[str]
    image_tag: Optional[str]
    total_tokens_in: int
    total_tokens_out: int
    total_cost_usd: float
    error_message: Optional[str]
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    created_at: datetime

class BuildEventResponse(BaseModel):
    id: UUID
    build_id: UUID
    kind: str
    agent: Optional[str]
    payload: dict
    seq: int
    created_at: datetime

class DeploymentResponse(BaseModel):
    id: UUID
    project_id: UUID
    build_id: UUID
    status: DeploymentStatus
    provider: str
    region: str
    image_tag: str
    preview_url: Optional[str]
    service_name: Optional[str]
    revision_id: Optional[str]
    traffic_pct: int
    created_at: datetime

class UsageSummary(BaseModel):
    tenant_id: UUID
    period: str
    total_builds: int
    total_tokens_in: int
    total_tokens_out: int
    total_cost_usd: float
    by_model: dict

class IntegrationResponse(BaseModel):
    id: UUID
    tenant_id: UUID
    project_id: UUID
    provider: str
    category: IntegrationCategory
    display_name: str
    status: IntegrationStatus
    credentials: dict  # Masked — only hints, never raw keys
    config: dict
    last_tested_at: Optional[datetime]
    last_test_ok: Optional[bool]
    last_error: Optional[str]
    created_at: datetime
    updated_at: datetime

class IntegrationTestResult(BaseModel):
    ok: bool
    message: str
    latency_ms: Optional[int] = None
