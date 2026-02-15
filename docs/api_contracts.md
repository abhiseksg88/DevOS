# NimbusForge — API Contracts

## Base URL
```
Production: https://api.nimbusforge.dev/v1
Local:      http://localhost:8000
```

## Authentication
All endpoints require `Authorization: Bearer <supabase_jwt>` header.
JWT is obtained via Supabase Auth (Google/GitHub OAuth).

## Endpoints

### Tenants

```
POST   /tenants                         -> TenantResponse (201)
GET    /tenants                         -> TenantResponse[] (200)
GET    /tenants/{tenant_id}             -> TenantResponse (200)
PATCH  /tenants/{tenant_id}             -> TenantResponse (200)
POST   /tenants/{tenant_id}/members     -> MemberResponse (201)
GET    /tenants/{tenant_id}/members     -> MemberResponse[] (200)
```

### Projects

```
POST   /tenants/{tenant_id}/projects                    -> ProjectResponse (201)
GET    /tenants/{tenant_id}/projects?status=active       -> ProjectResponse[] (200)
GET    /tenants/{tenant_id}/projects/{project_id}        -> ProjectResponse (200)
PATCH  /tenants/{tenant_id}/projects/{project_id}        -> ProjectResponse (200)
```

### Builds

```
POST   /tenants/{tenant_id}/projects/{project_id}/builds              -> BuildResponse (201)
GET    /tenants/{tenant_id}/projects/{project_id}/builds?limit=20     -> BuildResponse[] (200)
GET    /tenants/{tenant_id}/projects/{project_id}/builds/{build_id}   -> BuildResponse (200)
POST   /tenants/{tenant_id}/projects/{project_id}/builds/{build_id}/cancel -> {status: cancelled}
GET    /tenants/{tenant_id}/projects/{project_id}/builds/{build_id}/events?after_seq=0 -> SSE stream
```

### Deployments

```
POST   /tenants/{tenant_id}/projects/{project_id}/deployments          -> DeploymentResponse (201)
GET    /tenants/{tenant_id}/projects/{project_id}/deployments          -> DeploymentResponse[] (200)
POST   /tenants/{tenant_id}/projects/{project_id}/deployments/rollback -> {status: rolling_back}
```

### Usage

```
GET    /tenants/{tenant_id}/usage?period=current_month -> UsageSummary (200)
```

## SSE Event Stream Format

```
GET /tenants/{tid}/projects/{pid}/builds/{bid}/events?after_seq=0

Content-Type: text/event-stream

data: {"id":"...","kind":"agent_start","agent":"opus","payload":{"message":"Planning..."},"seq":1}
data: {"id":"...","kind":"patch","agent":"sonnet","payload":{"diff":"--- a/..."},"seq":5}
data: {"id":"...","kind":"deploy_progress","payload":{"preview_url":"https://..."},"seq":12}
data: {"kind":"stream_end","build_status":"succeeded"}
```

## Error Responses

```json
// 400 Bad Request
{"detail": "No fields to update"}

// 401 Unauthorized
{"detail": "Token verification failed"}

// 402 Payment Required (budget exceeded)
{"detail": "Monthly budget of $10.00 exceeded. Current spend: $10.23."}

// 403 Forbidden
{"detail": "Access denied to this tenant"}

// 404 Not Found
{"detail": "User not found with that email"}

// 429 Too Many Requests
{"detail": "Rate limit exceeded. Try again shortly."}
```

## Request Schemas

### BuildCreate
```json
{
  "prompt": "Add a dark mode toggle to the settings page with persistent preference"
}
```

### DeploymentCreate
```json
{
  "build_id": "uuid",
  "provider": "cloudrun",  // or "flyio"
  "region": "us-central1"
}
```

### RollbackRequest
```json
{
  "deployment_id": "uuid"
}
```
