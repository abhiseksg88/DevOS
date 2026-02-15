# Git Workflow Guide - Pull to Push

Complete step-by-step guide for working with the Universal Table + Global Injection implementation.

## Quick Start (Copy & Paste)

```bash
# 1. Pull latest code
git pull origin claude/ai-cloud-app-builder-OZ1AV

# 2. Setup database
cd supabase && supabase db push && cd ..

# 3. Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# 4. Start backend (Terminal 1)
cd nimbusforge && uvicorn api.main:app --reload

# 5. Start frontend (Terminal 2)
cd frontend && npm run dev

# 6. Test in browser (Terminal 3)
# Open http://localhost:3000

# 7. When done making changes, commit and push
git add .
git commit -m "feat: Your changes here"
git push -u origin claude/ai-cloud-app-builder-OZ1AV
```

---

## 10 Phases Explained

### Phase 1: Pull Latest Code
Ensures you have the latest implementation.

```bash
git branch                                    # Verify current branch
git pull origin claude/ai-cloud-app-builder-OZ1AV  # Get latest
git log --oneline -5                          # See recent commits
git status                                    # Verify clean state
```

### Phase 2: Review Implementation
Understand what was built.

```bash
git log --name-status -2                      # See all changed files
cat supabase/migrations/004_app_data_table.sql  # See database schema
git show --stat af717e1                       # See main commit details
```

### Phase 3: Verify Environment
Check all required files are present.

```bash
cd /home/user/DevOS
ls -la | grep SETUP_CHECKLIST
ls -la frontend/src/app/api/preview-credentials/
grep -n "preview/credentials" nimbusforge/api/main.py
```

### Phase 4: Run Migration & Setup
Initialize database and configure environment.

```bash
cd supabase && supabase db push              # Create app_data table
supabase db list                              # Verify table created

# Set your actual credentials
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Verify
echo $SUPABASE_URL
```

### Phase 5: Start Services
Run backend and frontend in separate terminals.

**Terminal 1 - Backend:**
```bash
cd /home/user/DevOS/nimbusforge
uvicorn api.main:app --reload
# Should see: Application startup complete
```

**Terminal 2 - Frontend:**
```bash
cd /home/user/DevOS/frontend
npm run dev
# Should see: Local: http://localhost:3000
```

**Terminal 3 - Testing:**
```bash
cd /home/user/DevOS
```

### Phase 6: Verify Components
Test each piece is working.

```bash
# Backend health
curl http://localhost:8000/health

# Database connection
curl http://localhost:8000/debug/db

# Credentials endpoint
curl http://localhost:3000/api/preview-credentials

# Browser test - Open http://localhost:3000
```

### Phase 7: Follow Testing Checklist
Comprehensive testing guide.

```bash
cat SETUP_CHECKLIST.md
# Follow all 10 steps in the checklist
```

### Phase 8: Make Your Changes
When you modify code.

```bash
git status                                    # See what changed
git diff nimbusforge/api/main.py            # See line-by-line changes
git add .                                     # Stage all changes
# OR stage specific files:
git add nimbusforge/api/main.py frontend/src/...
```

### Phase 9: Commit Your Changes
Save your work with a clear message.

```bash
git commit -m "feat: Brief description

Longer explanation of what changed and why.

- Change 1
- Change 2

https://claude.ai/code/session_01MNRjytZsAyepLXRzd9BHpL"

git log --oneline -1                          # Verify commit created
git status                                    # Verify working tree clean
```

### Phase 10: Push to Remote
Upload your changes.

```bash
git push -u origin claude/ai-cloud-app-builder-OZ1AV
git status                                    # Verify push succeeded
```

---

## Common Git Commands

### View Changes
```bash
git status                      # See all changed files
git diff                        # See all changes (unstaged)
git diff --cached               # See staged changes only
git diff filename              # Changes in specific file
git log --oneline -10          # See last 10 commits
git show commit-hash           # See full commit details
```

### Stage & Commit
```bash
git add .                       # Stage all changes
git add file1 file2            # Stage specific files
git commit -m "message"        # Create commit
git reset --soft HEAD~1        # Undo commit (keep changes)
```

### Push & Pull
```bash
git pull origin branch-name    # Get latest from remote
git push -u origin branch-name # Push to remote with tracking
git push                       # Push if tracking is set
```

### Undo Changes
```bash
git checkout .                 # Discard ALL local changes (CAREFUL!)
git checkout filename          # Discard changes in one file
git clean -fd                  # Remove untracked files (CAREFUL!)
```

---

## Troubleshooting

### "Your branch is behind"
```bash
git pull origin claude/ai-cloud-app-builder-OZ1AV
```

### "Merge conflict in file X"
```bash
git diff file_path             # See the conflict
# Edit the file to resolve
git add file_path
git commit
```

### "Cannot push - needs authentication"
```bash
git config user.email "your-email@example.com"
git config user.name "Your Name"
git push -u origin claude/ai-cloud-app-builder-OZ1AV
```

### "Untracked files in working directory"
```bash
git status                     # See which files
git add file_name
git commit -m "Add file"
git push -u origin claude-ai-cloud-app-builder-OZ1AV
```

### "Working tree clean but hook says otherwise"
```bash
git status
git add .
git commit -m "Fix: Address hook feedback"
git push -u origin claude/ai-cloud-app-builder-OZ1AV
```

---

## Branch Information

- **Branch Name**: `claude/ai-cloud-app-builder-OZ1AV`
- **Remote**: `origin/claude/ai-cloud-app-builder-OZ1AV`
- **Status**: Feature branch with Universal Table implementation
- **Total Changes**: 1,665+ lines added across 11 files

### Recent Commits
1. `docs: Add setup checklist for testing and deployment`
2. `feat: Implement Universal Table + Global Injection strategy for persistent data`

---

## Documentation Files

Start with these in order:
1. **SETUP_CHECKLIST.md** - Step-by-step testing checklist
2. **QUICK_REFERENCE.md** - CRUD copy-paste patterns & 5-min setup
3. **IMPLEMENTATION_COMPLETE.md** - Full technical reference
4. **GIT_WORKFLOW.md** - This file

---

## Key Files Modified

### Backend Changes
- `nimbusforge/api/config.py` - Supabase credential validation
- `nimbusforge/api/main.py` - `/preview/credentials` endpoint
- `nimbusforge/agents/orchestrator.py` - Auto-table-creation check
- `nimbusforge/agents/prompts.py` - 250+ lines DATABASE instruction

### Frontend Changes
- `frontend/src/lib/api.ts` - Credentials API function
- `frontend/src/components/preview/PreviewPane.tsx` - SDK injection & postMessage
- `frontend/src/app/api/preview-credentials/route.ts` - Credentials proxy route

### Database & Docs
- `supabase/migrations/004_app_data_table.sql` - Universal table schema
- `SETUP_CHECKLIST.md` - Testing checklist
- `QUICK_REFERENCE.md` - Developer guide
- `IMPLEMENTATION_COMPLETE.md` - Technical overview

---

## Next Steps

1. **Pull**: `git pull origin claude/ai-cloud-app-builder-OZ1AV`
2. **Setup**: Run supabase migration
3. **Start**: Backend & Frontend services
4. **Test**: Follow SETUP_CHECKLIST.md
5. **Make changes**: Edit files as needed
6. **Commit**: `git commit -m "your message"`
7. **Push**: `git push -u origin claude/ai-cloud-app-builder-OZ1AV`
8. **Verify**: Check status and logs

---

## Support

For detailed information, see:
- Technical details: `IMPLEMENTATION_COMPLETE.md`
- Quick CRUD examples: `QUICK_REFERENCE.md`
- Setup steps: `SETUP_CHECKLIST.md`
- Database schema: `supabase/migrations/004_app_data_table.sql`
- System prompts: `nimbusforge/agents/prompts.py` (lines 83-320)

---

**Last Updated**: After implementation
**Status**: Ready for testing & deployment
**Branch**: `claude/ai-cloud-app-builder-OZ1AV`
