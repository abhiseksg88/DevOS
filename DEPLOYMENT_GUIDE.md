# DevOS Deployment Guide

Complete guide to deploy DevOS platform to production.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    DevOS Platform                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Frontend (Next.js)          Backend (Python FastAPI)       │
│  Deploy to: Vercel          Deploy to: Railway              │
│  URL: vedaa.io              URL: api.vedaa.io               │
│                                                              │
│  User Apps (Generated)                                       │
│  Deploy to: Netlify                                          │
│  URL: *.vedaa.io (meal-planner.vedaa.io, etc.)             │
│                                                              │
│  Database: Supabase (hosted)                                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Deploy Backend to Railway (5 minutes)

### Prerequisites
- Railway account: https://railway.app
- Supabase credentials ready
- Netlify personal access token

### Steps

1. **Go to Railway Dashboard**
   - Visit: https://railway.app/new
   - Click "Deploy from GitHub repo"

2. **Connect Repository**
   - Select `abhiseksg88/DevOS`
   - Select branch: `claude/ai-cloud-app-builder-OZ1AV` (or `main`)
   - Railway will auto-detect Dockerfile

3. **Configure Environment Variables**

   Click "Variables" tab and add ALL of these:

   ```env
   # Supabase
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

   # LLM
   ANTHROPIC_API_KEY=sk-ant-api03-...

   # Netlify (use NF_ prefix on Netlify — it reserves the NETLIFY_ prefix)
   NF_TOKEN=your-netlify-personal-access-token
   NF_TEAM_SLUG=devos
   NF_SITE_PREFIX=devos
   NF_CUSTOM_DOMAIN=vedaa.io

   # Server
   PORT=8000
   ```

4. **Deploy**
   - Click "Deploy"
   - Wait 2-3 minutes for Docker build
   - You'll get URL: `https://devos-backend-production.up.railway.app`

5. **Test API**
   ```bash
   curl https://your-railway-url.up.railway.app/health
   # Should return: {"status": "ok"}
   ```

6. **Optional: Add Custom Domain**
   - Go to Settings → Networking → Custom Domain
   - Add: `api.vedaa.io`
   - Railway will give you a CNAME record
   - Add to your DNS:
     ```
     Type: CNAME
     Name: api
     Value: devos-backend-production.up.railway.app
     TTL: Auto
     ```

---

## Phase 2: Configure DNS for Custom Domains (5 minutes)

### Setup Wildcard DNS for User Apps

Your domain `vedaa.io` is already connected to Netlify. Now add wildcard DNS:

1. **Go to Your DNS Provider** (Cloudflare, GoDaddy, etc.)

2. **Add Wildcard CNAME Record**
   ```
   Type: CNAME
   Name: *
   Value: vedaaio.netlify.app.
   TTL: Auto or 300
   ```

3. **Verify DNS Propagation**
   ```bash
   dig meal-planner.vedaa.io
   # Should resolve to Netlify's IP
   ```

4. **Wait 5-10 minutes** for DNS to propagate globally

---

## Phase 3: Deploy Frontend to Vercel (3 minutes)

### Prerequisites
- Vercel account: https://vercel.com

### Steps

1. **Go to Vercel Dashboard**
   - Visit: https://vercel.com/new
   - Click "Import Git Repository"

2. **Connect Repository**
   - Select `abhiseksg88/DevOS`
   - Root Directory: `frontend`
   - Framework Preset: Next.js (auto-detected)

3. **Configure Environment Variables**

   Add in Vercel dashboard:
   ```env
   NEXT_PUBLIC_API_URL=https://your-railway-url.up.railway.app
   # Or if using custom domain:
   NEXT_PUBLIC_API_URL=https://api.vedaa.io

   # Supabase (for frontend)
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

4. **Deploy**
   - Click "Deploy"
   - Wait 1-2 minutes for build
   - You'll get URL: `https://devos.vercel.app`

5. **Add Custom Domain**
   - Go to Project Settings → Domains
   - Add: `vedaa.io` (or `app.vedaa.io`)
   - Vercel will guide you through DNS setup
   - Add CNAME: `vedaa.io` → `cname.vercel-dns.com`

---

## Phase 4: Run Database Migrations (2 minutes)

### Apply Supabase Migrations

1. **Install Supabase CLI** (if not already)
   ```bash
   npm install -g supabase
   ```

2. **Link to Your Project**
   ```bash
   cd /home/user/DevOS
   supabase link --project-ref your-project-ref
   ```

3. **Push Migrations**
   ```bash
   supabase db push
   ```

   This will apply:
   - `001_core_schema.sql` (tenants, projects, users)
   - `002_builds.sql` (build pipeline)
   - `006_netlify_deployments.sql` (Netlify + custom domains)

4. **Verify**
   - Go to Supabase Dashboard → SQL Editor
   - Run: `SELECT * FROM projects LIMIT 1;`
   - Check that `custom_domain` column exists

---

## Phase 5: Test End-to-End (10 minutes)

### 1. Test Platform Access
```bash
# Visit your frontend
open https://vedaa.io

# Should load DevOS workspace
```

### 2. Test App Generation
1. Sign up / Log in
2. Create new project: "Test App"
3. Chat: "Create a simple todo list app"
4. Wait for code generation
5. Preview should render

### 3. Test Netlify Publish (Critical!)
1. Click **"Publish"** button in workspace
2. Should see progress:
   - ✅ Generating deployment...
   - ✅ Uploading to Netlify...
   - ✅ Deploying...
   - ✅ Published successfully!
3. Should display:
   - 🌐 **Live at: test-app.vedaa.io** (custom domain!)
   - URL: `https://test-app.vedaa.io`

### 4. Verify Custom Domain
```bash
# Both URLs should work:
curl -I https://test-app.vedaa.io
curl -I https://devos-test-app.netlify.app

# Should return 200 OK
```

### 5. Test SSL Certificate
- Visit `https://test-app.vedaa.io` in browser
- Click padlock icon
- Should show valid SSL certificate (issued by Netlify)

---

## Phase 6: Configure Auto-Deploy

### Railway (Backend)
- Already configured! Pushes to `claude/ai-cloud-app-builder-OZ1AV` auto-deploy
- To change: Settings → Deployments → Production Branch

### Vercel (Frontend)
- Already configured! Pushes to main branch auto-deploy
- To change: Settings → Git → Production Branch

---

## Monitoring & Logs

### Railway Backend Logs
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# View logs
railway logs
```

### Vercel Frontend Logs
- Go to: https://vercel.com/your-project/deployments
- Click latest deployment → "Function Logs"

### Netlify User App Logs
- Go to: https://app.netlify.com/sites/devos-{slug}/deploys
- Click latest deploy → "Deploy log"

---

## Troubleshooting

### Backend Issues

**Problem**: `503 Service Unavailable`
- Check Railway logs: `railway logs`
- Verify environment variables are set
- Check Supabase URL is accessible

**Problem**: `Netlify not configured`
- On Railway (backend): Set `NETLIFY_TOKEN` in environment variables
- On Netlify (frontend): Set `NF_TOKEN` in environment variables (Netlify reserves the `NETLIFY_` prefix)
- Restart deployment

### Frontend Issues

**Problem**: `Failed to fetch from API`
- Check `NEXT_PUBLIC_API_URL` is set correctly in Vercel
- Redeploy frontend after changing env vars

**Problem**: CORS errors
- Backend already has CORS enabled
- Check that API URL matches exactly (no trailing slash)

### Custom Domain Issues

**Problem**: `Custom domain failed to assign`
- Check DNS: `dig *.vedaa.io`
- Verify wildcard CNAME exists: `*.vedaa.io` → `vedaaio.netlify.app.`
- Wait 10-15 minutes for DNS propagation
- App will fall back to `*.netlify.app` automatically

**Problem**: SSL certificate pending
- Netlify auto-issues SSL within 1-2 minutes
- Check: https://app.netlify.com/sites/devos-{slug}/settings/domain
- If stuck, remove and re-add custom domain

---

## Cost Summary (POC Phase)

| Service | Tier | Cost | Limits |
|---------|------|------|--------|
| Railway | Free | $0 (500 hours) | Sufficient for POC |
| Vercel | Free | $0 | 100GB bandwidth |
| Netlify | Free | $0 | 100GB bandwidth |
| Supabase | Free | $0 | 500MB database |
| **Total** | | **$0/month** | Good for 50-100 users |

**Upgrade Triggers:**
- Railway: $5/month when free hours run out
- Vercel: $20/month for custom domains + more bandwidth
- Netlify: $19/month for more sites + bandwidth
- Supabase: $25/month for more storage + features

---

## Migration to Cloud Run (Future)

When ready for enterprise-grade backend:

1. **Enable Cloud Run API**
2. **Deploy Backend**
   ```bash
   gcloud run deploy devos-api --source . --region us-central1
   ```
3. **Update Frontend Environment Variable**
   ```
   NEXT_PUBLIC_API_URL=https://devos-api-abc123-uc.a.run.app
   ```
4. **Zero Code Changes** (Docker-based, works everywhere)

---

## Success Checklist

✅ Backend deployed to Railway: `https://api.vedaa.io`
✅ Frontend deployed to Vercel: `https://vedaa.io`
✅ Database migrations applied (Supabase)
✅ DNS configured: `*.vedaa.io` → Netlify
✅ Published test app: `https://test-app.vedaa.io`
✅ SSL certificates active (Netlify auto-issued)
✅ Both custom domain + fallback work
✅ Auto-deploy configured (git push → deploy)
✅ Environment variables set correctly
✅ Monitoring & logs accessible

---

## Quick Deploy Commands

```bash
# Backend (Railway)
railway up

# Frontend (Vercel)
vercel --prod

# Database (Supabase)
supabase db push

# Test everything
curl https://api.vedaa.io/health
curl https://vedaa.io
curl https://test-app.vedaa.io
```

---

## Support & Next Steps

**After POC is Live:**
1. Invite seed investors to try the platform
2. Collect feedback on admin dashboard metrics
3. Monitor usage (projects created, deployments, etc.)
4. Prepare for migration to Cloud Run (if needed)
5. Set up production monitoring (Sentry, LogRocket)

**Questions?**
- Backend logs: `railway logs`
- Frontend logs: Vercel dashboard
- Database: Supabase dashboard
- Netlify: app.netlify.com

🚀 **You're ready to launch!**
