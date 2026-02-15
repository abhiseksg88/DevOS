# Setup Checklist - Universal Table Implementation

Copy this checklist and check off each item as you complete it.

## Pre-Flight Checks
- [ ] You have access to Supabase project (https://app.supabase.co)
- [ ] You have Supabase credentials (URL, Anon Key, Service Role Key)
- [ ] Python 3.8+ installed: `python --version`
- [ ] Node.js 18+ installed: `node --version`
- [ ] Supabase CLI installed: `supabase --version`

## Step 1: Database Migration
```bash
cd /home/user/DevOS/supabase
supabase db push
```
- [ ] Migration runs successfully
- [ ] No errors in output
- [ ] Table `app_data` created in Supabase
- [ ] RLS policies enabled
- [ ] Indexes created

## Step 2: Environment Variables
```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
```
- [ ] Variables exported in terminal
- [ ] Verify: `echo $SUPABASE_URL` shows correct value
- [ ] Verify: `echo $SUPABASE_ANON_KEY` shows correct value
- [ ] Verify: `echo $SUPABASE_SERVICE_ROLE_KEY` shows correct value

## Step 3: Start Backend (Terminal 1)
```bash
cd /home/user/DevOS/nimbusforge
uvicorn api.main:app --reload
```
- [ ] Backend starts without errors
- [ ] See: "Application startup complete"
- [ ] Backend running on `http://127.0.0.1:8000`

## Step 4: Start Frontend (Terminal 2)
```bash
cd /home/user/DevOS/frontend
npm run dev
```
- [ ] Frontend builds successfully
- [ ] No build errors
- [ ] Frontend running on `http://localhost:3000`
- [ ] See: "ready in X.Xs"

## Step 5: Verify Backend (Terminal 3)
```bash
curl http://localhost:8000/health
```
- [ ] Returns: `{"status": "ok", "service": "nimbusforge-api"}`
- [ ] Health check passes

## Step 6: Verify Database Connection
```bash
curl http://localhost:8000/debug/db
```
- [ ] Returns: `{"status": "ok", "tenants_count": X, "app_data_table_exists": true}`
- [ ] `app_data_table_exists` is `true`

## Step 7: Verify Credentials Endpoint
```bash
curl http://localhost:3000/api/preview-credentials
```
- [ ] Returns: `{"url": "...", "anonKey": "..."}`
- [ ] URL matches your Supabase project
- [ ] anonKey is set

## Step 8: Test in Browser
- [ ] Open: http://localhost:3000
- [ ] Navigate to a project workspace
- [ ] Send prompt: "Build a meal planner"
- [ ] Code generation starts
- [ ] Watch generated code for:
  - [ ] Uses `window.supabase`
  - [ ] Has `isLoading` state
  - [ ] Has `error` state
  - [ ] Has CREATE with `.insert()`
  - [ ] Has READ with `.select()`
  - [ ] Has DELETE with `.delete()`
  - [ ] Shows loading state while fetching
  - [ ] Shows error messages
  - [ ] Shows empty state message

## Step 9: Test CRUD in Preview
- [ ] **CREATE**: Click "Add Meal" button
  - [ ] Meal appears in list
  - [ ] Loading state shows briefly
  - [ ] No errors in console
- [ ] **READ**: Reload page (Cmd+R)
  - [ ] Meals persist after reload
  - [ ] Data loaded from Supabase
  - [ ] Shows "Loading..." state initially
- [ ] **DELETE**: Click delete button
  - [ ] Meal removed from list
  - [ ] Meal removed from database

## Step 10: Verify Data in Supabase
1. Go to: https://app.supabase.com
2. Select your project
3. Go to: SQL Editor
4. Run this query:
```sql
SELECT * FROM app_data
WHERE collection = 'meals'
ORDER BY created_at DESC
LIMIT 10;
```
- [ ] Query returns meals you created in UI
- [ ] Data structure looks correct
- [ ] Column `collection` = 'meals'
- [ ] Column `data` contains meal information as JSONB

## Complete Testing Checklist
See: `/home/user/DevOS/IMPLEMENTATION_COMPLETE.md`

### Phase 1: Database Setup
- [ ] Migration applied
- [ ] Table exists
- [ ] RLS policies in place
- [ ] Indexes created

### Phase 2: Backend Endpoints
- [ ] `/debug/db` works
- [ ] `/preview/credentials` returns correct data
- [ ] Auth check works

### Phase 3: Frontend Integration
- [ ] Proxy route returns credentials
- [ ] SDK loads from CDN
- [ ] No console errors

### Phase 4: LLM Code Generation
- [ ] Generates Supabase code
- [ ] Uses correct patterns
- [ ] Has error handling
- [ ] Has loading states

### Phase 5: End-to-End CRUD
- [ ] Create works
- [ ] Read works
- [ ] Update works
- [ ] Delete works
- [ ] Data persists

### Phase 6: Multi-Tenant Isolation (Optional)
- [ ] Project A sees only its data
- [ ] Project B sees only its data
- [ ] RLS prevents cross-tenant access

### Phase 7: Concurrent Updates (Optional)
- [ ] Open same item in 2 browser tabs
- [ ] Edit in tab 1, save
- [ ] Edit in tab 2, save
- [ ] Shows conflict message

## Troubleshooting
| Problem | Solution |
|---------|----------|
| `supabase db push` fails | Check: `supabase login`, you're in correct directory |
| Backend won't start | Check: Env vars set, port 8000 free, Python 3.8+ |
| Frontend won't start | Check: `npm install` done, port 3000 free, Node 18+ |
| Data doesn't persist | Check: Table exists, RLS policies set, no console errors |
| "Supabase SDK not loaded" | Check: Browser console, internet connection, CDN access |
| Credentials endpoint fails | Check: Frontend running, backend running, env vars set |

## Documentation to Read
1. **QUICK_REFERENCE.md** - 5-minute setup guide
2. **IMPLEMENTATION_COMPLETE.md** - Full technical details
3. **prompts.py** - See complete Meal Planner example (lines 197-317)

## Success Criteria
✅ All 10 steps completed
✅ No errors in terminals
✅ Meal planner works end-to-end
✅ Data persists in Supabase
✅ Testing checklist passed

## Next Steps After Testing
1. Deploy to staging environment
2. Run integration tests
3. Performance testing with larger datasets
4. Security review with your team
5. Prepare for production deployment

---

**Last Updated**: After implementation commit
**Status**: Ready for testing and deployment
**Branch**: `claude/ai-cloud-app-builder-OZ1AV`
