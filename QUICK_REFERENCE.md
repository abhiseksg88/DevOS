# Quick Reference Guide - Universal Table Strategy

## 🚀 5-Minute Setup

```bash
# 1. Run migration
cd supabase && supabase db push

# 2. Set environment variables
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_ANON_KEY=your-anon-key
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# 3. Start services
cd nimbusforge && uvicorn api.main:app --reload  # Terminal 1
cd frontend && npm run dev                        # Terminal 2

# 4. Open http://localhost:3000 and test!
```

---

## 📝 Database Schema (One Table to Rule Them All)

```javascript
{
  id: UUID,                    // auto-generated
  tenant_id: UUID,             // automatic via RLS
  project_id: UUID,            // automatic
  app_instance_id: TEXT,       // session ID
  collection: TEXT,            // "meals", "todos", "contacts"
  record_id: TEXT,             // user ID (usually UUID)
  data: JSONB,                 // flexible: {name: "...", email: "..."}
  version: INTEGER,            // for conflict detection
  created_at: TIMESTAMPTZ,     // automatic
  updated_at: TIMESTAMPTZ      // automatic
}
```

---

## 🔧 CRUD Operations (Copy-Paste Ready)

### CREATE
```javascript
const { data, error } = await window.supabase
  .from('app_data')
  .insert({
    collection: 'meals',
    record_id: crypto.randomUUID(),
    data: { name: 'Breakfast', date: '2025-02-15' }
  })
  .select()
  .single();

if (error) console.error(error);
else console.log('Created:', data);
```

### READ
```javascript
const { data, error } = await window.supabase
  .from('app_data')
  .select('*')
  .eq('collection', 'meals')
  .order('created_at', { ascending: false });

if (error) console.error(error);
else console.log('Meals:', data.map(row => ({ id: row.record_id, ...row.data })));
```

### UPDATE (with version check)
```javascript
const { data, error } = await window.supabase
  .from('app_data')
  .update({ data: newData, version: v + 1 })
  .eq('collection', 'meals')
  .eq('record_id', id)
  .eq('version', v)  // ← prevents conflicts
  .select()
  .single();

if (error?.code === 'PGRST116') {
  // Conflict! Someone else updated it
  console.error('Item modified elsewhere');
} else if (error) {
  console.error(error);
}
```

### DELETE
```javascript
const { error } = await window.supabase
  .from('app_data')
  .delete()
  .eq('collection', 'meals')
  .eq('record_id', id);

if (error) console.error(error);
else console.log('Deleted');
```

---

## ⚡ Required Pattern (LLM Enforces This)

```jsx
'use client';
import { useState, useEffect } from 'react';

export default function MyApp() {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);  // ← REQUIRED
  const [error, setError] = useState(null);          // ← REQUIRED

  // LOAD ON MOUNT
  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: err } = await window.supabase
        .from('app_data')
        .select('*')
        .eq('collection', 'items');

      if (err) throw err;
      setItems(data.map(row => ({ id: row.record_id, ...row.data })));
    } catch (e) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  }

  // SHOW LOADING STATE
  if (isLoading) return <div>Loading...</div>;

  // SHOW ERROR STATE
  if (error) return <div className="error">Error: {error}</div>;

  // SHOW EMPTY STATE
  if (items.length === 0) return <div>No items yet</div>;

  // RENDER LIST
  return (
    <ul>
      {items.map(item => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}
```

---

## 🧠 LLM Will Generate This For You

When you say "Build a meal planner", the LLM generates:

1. ✅ `useEffect` to load meals on mount
2. ✅ `isLoading` state while fetching
3. ✅ Error handling with `try/catch`
4. ✅ CREATE: Button to add meal with `.insert()`
5. ✅ READ: List meals with `.select()`
6. ✅ UPDATE: Edit meal with version check
7. ✅ DELETE: Remove meal with `.delete()`
8. ✅ Empty state: Show message if no meals
9. ✅ Error display: Show error to user
10. ✅ Loading UI: Show "Loading..." while fetching

**You just say what you want. The LLM handles the database code.**

---

## 🔍 Debugging Tips

### Check if Supabase is ready
```javascript
// In browser console (preview iframe)
console.log(window.__supabase_ready);  // Should be true
console.log(window.supabase);           // Should be Supabase client
```

### Check data in database
```sql
-- View all meals
SELECT * FROM app_data WHERE collection = 'meals' ORDER BY created_at DESC;

-- Count by collection
SELECT collection, COUNT(*) FROM app_data GROUP BY collection;

-- Check version conflicts
SELECT record_id, version, data FROM app_data WHERE collection = 'meals';
```

### Check RLS is working
```sql
-- View RLS policies
SELECT * FROM pg_policies WHERE tablename = 'app_data';

-- Test as specific user (admin only)
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub": "user-uuid-here"}';
SELECT * FROM app_data;
```

---

## 💡 Pro Tips

### Tip 1: Collection Naming
```javascript
// ✅ Good (lowercase, no spaces)
collection: 'meals'
collection: 'user_profiles'
collection: 'contact_list'

// ❌ Bad (spaces, caps, special chars)
collection: 'My Meals'
collection: 'Meals_V2'
collection: 'meals!'
```

### Tip 2: JSONB Structure
```javascript
// ✅ Any structure is fine (no schema needed)
data: { name: 'Breakfast', items: [] }
data: { title: 'Task 1', done: false, dueDate: '2025-02-15' }
data: { firstName: 'John', email: 'john@example.com', phone: '123-456' }

// Can evolve over time without migrations!
// Old records: { name: 'Breakfast' }
// New records: { name: 'Breakfast', calories: 500 }
// No database change needed!
```

### Tip 3: Error Handling
```javascript
// ✅ Always handle errors
if (error) {
  setError(error.message);  // Show to user
  console.error(error);     // Log for debugging
}

// ❌ Never silent fail
// ❌ Never console.error only
// ❌ Never ignore network errors
```

### Tip 4: Loading States
```javascript
// ✅ Show feedback while waiting
if (isLoading) return <spinner />;

// ❌ Never blank screen
// ❌ Never freeze UI
// ❌ Never assume instant
```

---

## 🚨 Common Mistakes (Reviewer Will Catch)

### ❌ Using localStorage
```javascript
// WRONG! Will be rejected by Reviewer
localStorage.setItem('meals', JSON.stringify(meals));

// RIGHT! Use database
await window.supabase.from('app_data').insert(...);
```

### ❌ Mocking data
```javascript
// WRONG! Will be rejected
const [meals] = useState([
  { id: 1, name: 'Breakfast' },
  { id: 2, name: 'Lunch' }
]);

// RIGHT! Fetch from database
const { data } = await window.supabase.from('app_data').select(...);
```

### ❌ Missing error handling
```javascript
// WRONG! Will be rejected
const { data } = await window.supabase.from('app_data').insert(...);
setMeals([...meals, data]);  // What if error?

// RIGHT! Check for error
const { data, error } = await window.supabase.from('app_data').insert(...);
if (error) {
  setError(error.message);
  return;
}
setMeals([...meals, data]);
```

### ❌ UPDATE without version check
```javascript
// WRONG! Will be rejected (data conflicts)
await window.supabase
  .from('app_data')
  .update({ data: newData, version: v + 1 })
  .eq('record_id', id)
  .select()
  .single();

// RIGHT! Check version for conflicts
await window.supabase
  .from('app_data')
  .update({ data: newData, version: v + 1 })
  .eq('record_id', id)
  .eq('version', v)  // ← Detects conflicts
  .select()
  .single();
```

---

## 📈 Performance Tips

### Query Optimization
```javascript
// ✅ Good - filtered, ordered, limited
await window.supabase
  .from('app_data')
  .select('*')
  .eq('collection', 'meals')
  .order('created_at', { ascending: false })
  .limit(50);

// ⚠️ Caution - unbounded queries
await window.supabase
  .from('app_data')
  .select('*');  // Could be thousands of rows!
```

### Batch Operations
```javascript
// ✅ Good - batch insert
await window.supabase
  .from('app_data')
  .insert([
    { collection: 'meals', record_id: id1, data: {...} },
    { collection: 'meals', record_id: id2, data: {...} },
  ]);

// ⚠️ Slower - loop and insert
for (const meal of meals) {
  await window.supabase.from('app_data').insert(...);
}
```

---

## 🎯 Next Steps

1. **Run migrations**: `supabase db push`
2. **Set env vars**: Copy `.env.example` and fill in Supabase credentials
3. **Start services**: Backend + frontend
4. **Test**: Open workspace, send "Build a meal planner" prompt
5. **Verify**: Check data persists in Supabase after reload
6. **Deploy**: Follow deployment checklist in IMPLEMENTATION_COMPLETE.md

---

## 📞 Troubleshooting

| Problem | Solution |
|---------|----------|
| "window.supabase is undefined" | Supabase SDK didn't load from CDN. Check internet. |
| "Cannot read property 'from' of undefined" | Wait for 'supabase:ready' event before using. |
| "RLS policy violation" | Check tenant_id context. Are you in correct tenant? |
| "Version conflict" | Two users edited same record. Show "Refresh and retry". |
| "Query timeout" | Add limit() to queries. Use indexes for filtering. |
| "Data not persisting" | Check if insert() returned error. Verify no localStorage. |

---

## 🎓 Learning Resources

- **Full Meal Planner Example**: See CODER_SYSTEM in `prompts.py`
- **CRUD Patterns**: Lines 103-183 in `prompts.py`
- **Database Validation**: REVIEWER_SYSTEM in `prompts.py`
- **Planning Guide**: PLANNER_SYSTEM in `prompts.py`

---

**Ready to build? Start by testing with "Build a meal planner" in the workspace!** 🚀
