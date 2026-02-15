# Railway Deployment Guide

Quick guide to deploy DevOS backend to Railway.

## Prerequisites

1. Railway account: https://railway.app
2. GitHub repo pushed to GitHub

## Deployment Steps

### Option 1: Deploy from GitHub (Recommended)

1. **Go to Railway Dashboard**
   - Visit https://railway.app/new
   - Click "Deploy from GitHub repo"

2. **Connect Repository**
   - Select `abhiseksg88/DevOS`
   - Railway will auto-detect the Dockerfile

3. **Add Environment Variables**
   Click "Variables" and add:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ANTHROPIC_API_KEY=sk-ant-...
   NETLIFY_TOKEN=your-netlify-token
   NETLIFY_TEAM_SLUG=devos
   NETLIFY_SITE_PREFIX=devos
   NETLIFY_CUSTOM_DOMAIN=vedaa.io
   PORT=8000
   ```

4. **Deploy**
   - Railway will build the Docker image
   - Deploy will start automatically
   - You'll get a URL: `https://devos-backend-production.up.railway.app`

5. **Set Up Custom Domain (Optional)**
   - Go to Settings → Domains
   - Add `api.vedaa.io`
   - Update DNS: CNAME `api` → `devos-backend-production.up.railway.app`

### Option 2: Deploy via Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Link to project (or create new)
railway link

# Add environment variables
railway variables set SUPABASE_URL=https://your-project.supabase.co
railway variables set SUPABASE_SERVICE_ROLE_KEY=your-key
# ... add all other variables

# Deploy
railway up
```

## Post-Deployment

### 1. Update Frontend Environment Variable

In Vercel (or wherever frontend is deployed):
```
NEXT_PUBLIC_API_URL=https://devos-backend-production.up.railway.app
```

### 2. Test the API

```bash
curl https://devos-backend-production.up.railway.app/health
# Should return: {"status": "ok"}
```

### 3. Monitor Logs

```bash
railway logs
```

## Troubleshooting

**Build fails with "pydantic-core requires Rust":**
- This shouldn't happen with Dockerfile (it has gcc)
- If it does, the Dockerfile already handles it

**503 Service Unavailable:**
- Check logs: `railway logs`
- Verify environment variables are set
- Check Supabase URL is accessible

**Port issues:**
- Railway auto-detects port 8000 from Dockerfile
- Or set `PORT=8000` in environment variables

## Auto-Deploy on Git Push

Railway automatically deploys when you push to the linked branch (usually `main` or `claude/ai-cloud-app-builder-OZ1AV`).

To change deploy branch:
1. Go to Settings → Service
2. Change "Production Branch"

## Cost

- **Free tier**: 500 hours/month ($5 credit)
- **Starter**: $5/month minimum
- **Pro**: $20/month minimum

For POC, free tier is sufficient!

## Migration to Cloud Run Later

When ready to migrate:
1. All code is Docker-based (works anywhere)
2. Environment variables stay the same
3. Just change `NEXT_PUBLIC_API_URL` in frontend
4. Zero code changes needed

---

**Quick Deploy (3 minutes):**
1. Go to https://railway.app/new
2. Select GitHub repo
3. Paste environment variables
4. Deploy!

URL: `https://your-service.up.railway.app`
