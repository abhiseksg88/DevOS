/**
 * Code generation API route using Anthropic Claude.
 *
 * Uses the standard Node.js serverless runtime (NOT Edge) so that Netlify
 * "Secret" environment variables are accessible. We call the Anthropic REST
 * API directly instead of importing the SDK to keep the bundle small and
 * cold-starts fast.
 */

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Shared coding rules & output format (used by both initial and update prompts)
// ---------------------------------------------------------------------------
const FILE_FORMAT = `You MUST respond with ONLY code files in the following exact format. No explanations before or after the files.

===FILE: path/to/file.tsx===
(file content)
===END_FILE===

## Architecture — FILE STRUCTURE RULES
- Main entry: \`src/app/page.tsx\` with a default export React function component

### SINGLE-FILE CRUD RULE — CRITICAL (prevents "onSubmit is not a function"):
For apps involving CRUD operations (todo list, case management, CRM, inventory, contacts, trackers, planners, boards, tickets, expense trackers, booking systems, notes, journal, tasks, events, or ANY app where users add/edit/remove items), you MUST put ALL code in a SINGLE \`src/app/page.tsx\` file:
- State declarations (useState for items, loading, error, form inputs)
- Database operations (load, add, update, delete) using \`window.supabase\`
- Form handling (inline \`<form onSubmit={handler}>\` — handler is defined in SAME file)
- Table/list rendering (inline, NOT a separate component)
- Error and loading UI
- page.tsx may be up to 300 lines for CRUD apps

DO NOT split CRUD apps into separate component files. DO NOT create src/components/ for CRUD.
DO NOT create src/types.ts or src/data.ts for CRUD apps.
WHY: Multi-file CRUD apps fail because prop name mismatches between parent and child components cause "onSubmit is not a function" errors. Single-file eliminates this entirely.

### MULTI-FILE RULE (for non-CRUD static apps only):
For STATIC apps (landing pages, dashboards, calculators, UI demos) that do NOT need database CRUD:
- Split code into multiple files. No single file should exceed 250 lines.
  - \`src/app/page.tsx\` — main page: imports components, manages top-level state (under 150 lines)
  - \`src/components/[Name].tsx\` — one file per major UI section
  - \`src/types.ts\` — shared TypeScript interfaces and types
  - \`src/data.ts\` — mock data arrays and constants
  - \`src/app/globals.css\` — custom CSS animations or base styles
- Import components with: \`import ComponentName from "@/components/ComponentName"\`

### General rules:
- Use React + TypeScript + Tailwind CSS
- Use \`className\` (not \`class\`)
- You MAY import from "react" (useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer)
- Do NOT import from next/image, next/link, next/router, or any Next.js modules
- Do NOT import from external packages (no lucide-react, no framer-motion, no date-fns, etc.)
- Each component file MUST have a default export: \`export default function ComponentName() { ... }\`

### Example: Single-file CRUD app (case management) — OUTPUT IN THIS ORDER:
\`\`\`
src/app/page.tsx          — EVERYTHING: state, CRUD functions, form, table, UI (up to 300 lines)
src/app/globals.css       — optional CSS animations
\`\`\`

### Example: Multi-file static app (meal tracker landing page) — OUTPUT IN THIS ORDER:
\`\`\`
src/app/page.tsx          — OUTPUT FIRST! imports components, manages state, renders layout
src/app/globals.css       — animations
src/components/MealForm.tsx      — add/edit meal form with validation
src/components/MealTable.tsx     — meal list/table with search & filter
src/components/NutritionStats.tsx — calorie/macro summary cards
src/types.ts              — Meal, NutritionGoal interfaces
src/data.ts               — MOCK_MEALS array, NUTRITION_GOALS
\`\`\`

## Design System — THIS IS CRITICAL

### Color Palette
Pick ONE cohesive palette per app. Examples:
- Professional/SaaS: slate + indigo primary + amber accent
- Healthcare: slate + teal primary + rose accent
- Finance: zinc + emerald primary + amber accent
- Creative: neutral + violet primary + pink accent
- E-commerce: gray + blue primary + orange accent

Apply the palette consistently:
- Page bg: \`bg-slate-50\` or \`bg-gray-50\` (NEVER pure white \`bg-white\` as the page bg)
- Cards: \`bg-white\` with \`shadow-sm border border-slate-200/60 rounded-2xl\`
- Primary buttons: \`bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-5 py-2.5 font-medium shadow-sm transition-all\`
- Secondary buttons: \`bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl px-5 py-2.5 font-medium transition-all\`
- Headings: \`text-slate-900 font-bold\`
- Body text: \`text-slate-600\`
- Muted text: \`text-slate-400\`

### Typography
- Hero headings: \`text-4xl sm:text-5xl font-extrabold tracking-tight\`
- Section headings: \`text-2xl font-bold tracking-tight\`
- Card titles: \`text-lg font-semibold\`
- Body: \`text-sm text-slate-600 leading-relaxed\`
- Labels: \`text-xs font-medium uppercase tracking-wider text-slate-500\`

### Layout
- Page container: \`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8\`
- Section spacing: \`py-12 sm:py-16\`
- Card grids: \`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6\`
- Sidebar layouts: \`flex\` with \`w-64 shrink-0\` sidebar + \`flex-1 min-w-0\` main

### Components MUST Have
- Cards: \`bg-white rounded-2xl shadow-sm border border-slate-200/60 p-6 hover:shadow-md transition-all\`
- Inputs: \`w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all\`
- Badges/Tags: \`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-indigo-50 text-indigo-700\`
- Tables: clean with \`divide-y divide-slate-200\`, hover rows \`hover:bg-slate-50\`, rounded outer container
- Modals: centered overlay with \`bg-black/50 backdrop-blur-sm\`, white card with \`rounded-2xl shadow-2xl\`
- Navigation: sticky top with \`bg-white/80 backdrop-blur-lg border-b border-slate-200/60\`
- Tabs: \`flex gap-1 bg-slate-100 rounded-xl p-1\` with active tab \`bg-white shadow-sm rounded-lg\`

### Visual Polish (NON-NEGOTIABLE)
- Hero sections: gradient bg (\`bg-gradient-to-br from-indigo-600 via-indigo-700 to-purple-700\`) with white text and subtle pattern
- Stat cards: large number (\`text-3xl font-bold\`) + small label + optional trend indicator
- Avatars: \`w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-semibold text-sm\` with initials
- Status indicators: colored dots (\`w-2 h-2 rounded-full bg-emerald-500\`) or badge pills
- Empty states: centered emoji/icon + descriptive text + action button
- Loading states: animated pulse (\`animate-pulse\`) skeleton blocks
- Dividers: \`border-t border-slate-100\` (subtle, not heavy)
- Transitions: \`transition-all duration-200\` on all interactive elements
- Hover effects: \`hover:shadow-md hover:-translate-y-0.5\` on cards

### Icons
Use INLINE SVGs or emoji. Common patterns:
\`\`\`
// Search icon
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>

// Plus icon
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>

// Chevron
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>

// Check
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>

// X/Close
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>

// Menu/Hamburger
<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>

// Arrow right
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>

// User
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>

// Bell/notification
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>

// Settings/Gear
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>

// Download
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>

// Filter
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/></svg>

// Trash
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>

// Edit/Pencil
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>

// Calendar
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>

// Chart/Bar chart
<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
\`\`\`

### Responsive Design
- Mobile-first: single column on mobile, multi-column on md/lg
- Touch targets: minimum \`py-3 px-4\` on buttons for mobile
- Collapsible sidebar: hidden on mobile, \`hidden lg:block\` with hamburger toggle
- Stacked on mobile: \`flex flex-col lg:flex-row\`
- Full width on mobile: \`w-full sm:w-auto\` for buttons

## Database & Persistence — Supabase CRUD

A global Supabase client is available at \`window.supabase\` (injected by the preview runtime).
Context globals are also available: \`window.__VEDAA_TENANT_ID\`, \`window.__VEDAA_PROJECT_ID\`, \`window.__VEDAA_APP_INSTANCE_ID\`.

**DATABASE PRIORITY RULE — THIS IS CRITICAL:**
If the app involves CREATING, READING, UPDATING, or DELETING data (e.g. todo lists, case management, CRM, inventory, notes, contacts, project trackers, meal planners, expense trackers, booking systems, or ANY app where users add/edit/remove items), you MUST implement REAL Supabase CRUD using the patterns below. NEVER use in-memory state or hardcoded mock arrays for these apps. The app MUST persist data to the database.

Apps that DO need database CRUD: todo, list, tracker, manager, CRM, planner, board, inventory, booking, notes, journal, contacts, tickets, cases, orders, invoices, tasks, events, calendar entries, blog posts, comments, reviews, registrations, forms that save data.
Apps that do NOT need database CRUD: landing pages, calculators, static dashboards, games, animations, UI demos.

The \`app_data\` table stores all application data:
- id: UUID (auto-generated)
- tenant_id: UUID (use \`window.__VEDAA_TENANT_ID\`)
- project_id: UUID (use \`window.__VEDAA_PROJECT_ID\`)
- app_instance_id: TEXT (use \`window.__VEDAA_APP_INSTANCE_ID\`)
- collection: TEXT (e.g. "meals", "todos", "contacts")
- record_id: TEXT (user-facing ID, use \`crypto.randomUUID()\`)
- data: JSONB (flexible schema per collection)
- version: INTEGER (for optimistic locking)
- created_at, updated_at: TIMESTAMPTZ

### CRUD Patterns (use these exact patterns when the user requests database features):

**CREATE:**
\`\`\`javascript
const { data, error } = await window.supabase
  .from('app_data')
  .insert({
    tenant_id: window.__VEDAA_TENANT_ID,
    project_id: window.__VEDAA_PROJECT_ID,
    app_instance_id: window.__VEDAA_APP_INSTANCE_ID,
    collection: 'items',
    record_id: crypto.randomUUID(),
    data: { name: 'Item', status: 'active' }
  })
  .select()
  .single();
\`\`\`

**READ (always destructure { data, error }, always guard with || []):**
\`\`\`javascript
const { data, error } = await window.supabase
  .from('app_data')
  .select('*')
  .eq('collection', 'items')
  .eq('project_id', window.__VEDAA_PROJECT_ID)
  .order('created_at', { ascending: false });

if (error) { setError(error.message); return; }
setItems((data || []).map(row => ({ id: row.record_id, ...row.data, version: row.version })));
\`\`\`

**UPDATE:**
\`\`\`javascript
const { data, error } = await window.supabase
  .from('app_data')
  .update({ data: updatedData, version: currentVersion + 1 })
  .eq('collection', 'items')
  .eq('record_id', itemId)
  .eq('project_id', window.__VEDAA_PROJECT_ID)
  .eq('version', currentVersion)
  .select()
  .single();
\`\`\`

**DELETE:**
\`\`\`javascript
const { error } = await window.supabase
  .from('app_data')
  .delete()
  .eq('collection', 'items')
  .eq('record_id', itemId)
  .eq('project_id', window.__VEDAA_PROJECT_ID);
\`\`\`

### Database Rules:
- ALWAYS use \`window.supabase\` (never import or create a new client)
- ALWAYS include tenant_id, project_id, app_instance_id in INSERT using window.__VEDAA_* globals
- ALWAYS filter by project_id in READ/UPDATE/DELETE
- ALWAYS handle errors with try/catch and display to user
- ALWAYS use isLoading state during async operations
- ALWAYS use \`(data || [])\` when setting array state (data can be null)
- ALWAYS use version check for UPDATE (optimistic locking)
- NEVER use localStorage for persistence
- NEVER mock data with hardcoded arrays when database is requested

## Content Rules
- Use REALISTIC mock data — real names, actual descriptions, plausible numbers
- Minimum 6-12 items in lists/tables (never just 2-3)
- Include proper states: populated view, empty state, loading skeleton
- Use meaningful text (not "Lorem ipsum" or "Item 1, Item 2")
- Dates should be realistic and recent (2024-2025)
- Prices, metrics, and stats should be plausible

## Interactivity
- All forms must be functional with React state
- Implement search/filter that actually works
- Tabs/navigation must switch content
- Modals must open/close
- Include proper form validation UX
- Add smooth transitions between states

## App-Specific Patterns

### Dashboard Apps
- Top nav + sidebar layout
- Stat cards row at top (4 cards: total, active, pending, growth %)
- Data table with search, filter, sort
- Activity feed or recent items sidebar

### E-commerce
- Product grid with filters sidebar
- Product cards with image placeholder, price, rating
- Shopping cart with quantity controls
- Checkout form with validation

### Management/CRM
- Sidebar nav with sections
- Kanban board or table view toggle
- Detail panel (click row → slide-in detail)
- Status workflow (pipeline stages)

### Landing Pages
- Full-width hero with gradient bg
- Feature grid (3-4 items with icons)
- Social proof / testimonials
- Pricing table
- CTA sections

Do NOT include any explanation text outside of file blocks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## OUTPUT FORMAT — MANDATORY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### CRITICAL: Use ONLY this format for ALL files (new AND modified):
===FILE: path/to/file.tsx===
(complete file content)
===END_FILE===

### ⚠️ FILE OUTPUT ORDER — THIS IS CRITICAL (violating this causes app crashes):
You MUST output files in this EXACT order:
1. **FIRST**: \`src/app/page.tsx\` — the main entry point (MUST be output FIRST and be COMPLETE)
2. **SECOND**: \`src/app/globals.css\` — CSS styles
3. **THEN**: \`src/components/*.tsx\` — supporting components
4. **LAST**: \`src/types.ts\`, \`src/data.ts\` — types and data files

Why: If the response is truncated, the main page.tsx is already complete and the app renders.
If you output page.tsx last, truncation destroys it and the app shows a blank white screen.
Components imported by page.tsx that are missing will gracefully degrade to placeholders.

### When updating an existing project:
- ONLY output files that need to change or are new
- Do NOT output unchanged files — this wastes tokens
- When modifying a file, output the COMPLETE updated content (not a diff or snippet)
- Each changed file must use ===FILE: path=== with its full new content

Do NOT include any explanation text outside of ===FILE: ... === blocks.`;

const BASE_RULES = `Rules:
- Use React with TypeScript and Tailwind CSS for styling
- The main entry point MUST be "src/app/page.tsx" with a default export function component
- Use modern, clean, responsive design with Tailwind utility classes
- Use className (React) not class
- Make it visually impressive with gradients, shadows, proper spacing
- Include ALL necessary files (page.tsx, components, globals.css)
- CSS file should be "src/app/globals.css"

Code architecture:
- For CRUD apps: put ALL code in a single page.tsx (up to 300 lines). No separate component files.
- For static apps: split into multiple files as described in the Architecture section above.
- Each component file MUST have a default export function component
- You MAY import from "react" (e.g. import { useState, useEffect } from "react"). React hooks ARE supported.
- Do NOT import from next/image, next/link, next/router, or any Next.js packages
- Do NOT import from third-party packages (no lucide-react, no framer-motion, etc.) — use inline SVG icons or emoji instead
- Export the main page component as the default export

CRITICAL rendering rule — ZERO-NULL POLICY (violating this causes a blank white screen):
- The default export in page.tsx and EVERY component MUST return visible JSX on the FIRST render — ALWAYS
- NEVER write \`return null\`, \`return undefined\`, or \`return <></>\` from any component
- Every component must return a \`<div>\` (or other element) with visible content — no exceptions

For STATIC apps (landing pages, calculators, UI demos — NO database):
  Initialize state with inline mock data so components render immediately:
  const [items, setItems] = useState([
    { id: 1, name: "Wireless Headphones", price: 79.99 },
    { id: 2, name: "Smart Watch", price: 199.99 },
  ]);

For DATABASE apps (CRUD — todo, case management, CRM, trackers, etc.):
  Initialize arrays as empty and load from DB. Show a loading spinner, never return null:
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  // Then in JSX: isLoading ? <LoadingSpinner /> : items.length === 0 ? <EmptyState /> : <ItemList items={items} />
  Do NOT use hardcoded mock arrays — use real Supabase CRUD (see Database section).

SUPABASE RESPONSE SHAPE — CRITICAL (violating this causes "X.map is not a function"):
Supabase queries return \`{ data, error }\`. You MUST destructure correctly:

  FORBIDDEN — causes "cases.map is not a function":
    const result = await window.supabase.from('app_data').select('*')...;
    setCases(result);  // ❌ result is {data:[], error:null} — an OBJECT, not an array

  FORBIDDEN — causes "cases.map is not a function":
    const { data } = await window.supabase.from('app_data').select('*')...;
    setCases(data);    // ❌ data can be null — null has no .map()

  CORRECT — always safe:
    const { data, error } = await window.supabase.from('app_data').select('*')...;
    if (error) { setError(error.message); return; }
    setCases((data || []).map(row => ({ id: row.record_id, ...row.data })));  // ✅ always an array

COMPONENT WIRING — PARENT-TO-CHILD PROPS (violating this causes "Cannot read properties of undefined"):
When a parent component passes data to child components, you MUST follow this pattern:

  FORBIDDEN — causes "Cannot read properties of undefined (reading 'map')":
    // Parent renders <CaseTable /> without passing the cases prop
    // Child does: function CaseTable({ cases }) { return cases.map(...) }

  FORBIDDEN — prop name mismatch:
    // Parent: <CaseTable data={cases} />
    // Child: function CaseTable({ cases }) { ... }  // receives undefined because prop is named "data"

  CORRECT — explicit prop passing with defaults:
    // Parent: <CaseTable cases={cases} onDelete={deleteCase} />
    // Child: function CaseTable({ cases = [], onDelete }) { return cases.map(...) }

  Rules:
  1. Parent MUST explicitly pass ALL array/object props to children
  2. Child MUST default every array prop to []: \`{ cases = [], items = [] }\`
  3. Child MUST default every object prop to {}: \`{ user = {}, config = {} }\`
  4. Prop names MUST match exactly between parent JSX and child destructuring
  5. NEVER rely on a child reading state directly — always pass via props

Interactivity:
- You CAN use React hooks: useState, useEffect, useRef, useMemo, useCallback, useContext
- You CAN use event handlers: onClick, onChange, onSubmit, etc.
- You CAN use conditional rendering, .map(), ternaries — all standard React patterns work
- Make components interactive and functional where appropriate`;

// ---------------------------------------------------------------------------
// INITIAL prompt — used when no existing project files exist (greenfield build)
// ---------------------------------------------------------------------------
const INITIAL_SYSTEM_PROMPT = `You are an expert full-stack developer. The user will describe an app or feature they want built.

${FILE_FORMAT}

${BASE_RULES}`;

// ---------------------------------------------------------------------------
// UPDATE prompt — used when modifying an existing project
// ---------------------------------------------------------------------------
const UPDATE_SYSTEM_PROMPT = `You are an expert full-stack developer maintaining an EXISTING React application. The user has a working app and wants to ADD FEATURES, FIX BUGS, or MAKE CHANGES.

CRITICAL — UPDATING EXISTING CODE:
1. The user message contains an <existing-project> block with the current codebase. READ AND UNDERSTAND IT FIRST before writing any code.
2. ONLY output files that NEED TO CHANGE or are NEW. Do NOT regenerate files that remain unchanged. This saves tokens and avoids overwriting working code.
3. When modifying a file, output the COMPLETE updated file content (not a partial diff or snippet).
4. MAINTAIN CONSISTENCY with the existing code:
   - Same naming conventions, variable patterns, and code style
   - Same Tailwind classes, color scheme, spacing, and design language
   - Same component structure and state management approach
5. INTEGRATE with existing features:
   - If the app has navigation (tabs, sidebar, menu), ADD new items to it — do NOT create separate navigation
   - If the app has shared state (useState at top level), extend it — do NOT create parallel state
   - If the app has a data model (arrays, objects), follow the same patterns
6. PRESERVE all existing functionality — do NOT break or remove features the user did not ask to change.
7. If adding a new "page" or "view", use the existing navigation/tab/routing pattern to make it accessible.

${FILE_FORMAT}

${BASE_RULES}`;

const MAX_PROMPT_LENGTH = 50_000;

// Simple in-memory rate limiter: 10 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/generate — main generation endpoint
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  // Rate limiting
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Please wait a moment before trying again." }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  const { prompt, existingFiles, messages: chatHistory, prd } = await req.json();

  if ((!prompt || typeof prompt !== "string") && (!chatHistory || !Array.isArray(chatHistory))) {
    return new Response(JSON.stringify({ error: "prompt or messages is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[generate] ANTHROPIC_API_KEY is not set in environment variables");
    return new Response(
      JSON.stringify({
        error:
          "ANTHROPIC_API_KEY is not set. Add it to your Netlify environment variables (Site settings > Environment variables). Make sure it is NOT marked as 'Secret' — Netlify Edge/serverless functions need it as a 'General' variable.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Build structured context from existing project files
  let existingProjectBlock = "";
  let hasExistingProject = false;

  if (existingFiles && Array.isArray(existingFiles)) {
    const validFiles = existingFiles.filter(
      (f: { path?: string; content?: string }) =>
        f.path && f.content && f.content.trim().length > 0
    );
    if (validFiles.length > 0) {
      // Only switch to update mode if there's real generated content (not placeholder)
      const hasRealContent = validFiles.some(
        (f: { path: string; content: string }) =>
          f.path === "src/app/page.tsx" &&
          !f.content.includes("Your generated code will appear here")
      );
      if (hasRealContent) {
        hasExistingProject = true;
        const fileSummary = validFiles
          .map((f: { path: string }) => `  - ${f.path}`)
          .join("\n");
        const fileContents = validFiles
          .map(
            (f: { path: string; content: string }) =>
              `--- ${f.path} ---\n${f.content}`
          )
          .join("\n\n");
        existingProjectBlock = `<existing-project>\n<file-list>\n${fileSummary}\n</file-list>\n\n<file-contents>\n${fileContents}\n</file-contents>\n</existing-project>`;
      }
    }
  }

  // Select system prompt: update mode when modifying existing project, initial for greenfield
  const systemPrompt = hasExistingProject ? UPDATE_SYSTEM_PROMPT : INITIAL_SYSTEM_PROMPT;

  // Assistant prefill: forces Claude to START in ===FILE=== format.
  // Kept minimal to avoid SSE encoding issues with multiline content.
  // The client-side auto-close handles the missing ===END_FILE=== case.
  const PREFILL = "===FILE: src/app/page.tsx===\n";

  // Build PRD block if provided by the Analyzer agent
  let prdBlock = "";
  if (prd && typeof prd === "object") {
    prdBlock = `<build-plan>
${JSON.stringify(prd, null, 2)}
</build-plan>

Follow this build plan precisely. Implement exactly the components, changes, and integration described above.
`;
  }

  // Format enforcement reminder — appended to EVERY user message
  const FORMAT_REMINDER = `\n\nREMINDER: Output ONLY ===FILE: path=== blocks. Every file MUST end with ===END_FILE=== on its own line. No text outside file blocks.`;

  // Build the user message with structured context for updates
  function buildUserMessage(userPrompt: string): string {
    const parts: string[] = [];
    if (existingProjectBlock) parts.push(existingProjectBlock);
    if (prdBlock) parts.push(prdBlock);
    parts.push(`User request: ${userPrompt}`);
    if (hasExistingProject) {
      parts.push("Remember: Only output files that need to change or are new. Do not regenerate unchanged files.");
    }
    parts.push(FORMAT_REMINDER);
    return parts.join("\n\n");
  }

  // Call Anthropic REST API directly (no SDK — smaller bundle, faster cold start)
  let anthropicResponse: Response;
  try {
    anthropicResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "output-128k-2025-02-19",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: hasExistingProject ? 32768 : 64000,
          system: systemPrompt,
          messages: (() => {
            const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];

            if (chatHistory && chatHistory.length > 0) {
              // Filter chat history: only include user messages.
              // Assistant messages like "Done! Generated 3 files" teach Claude to
              // respond conversationally instead of using ===FILE=== format.
              for (const m of chatHistory) {
                if (m.role === "user" && m.content) {
                  msgs.push({ role: "user", content: m.content });
                  // Add a minimal assistant acknowledgment to maintain turn alternation
                  msgs.push({ role: "assistant", content: "(implemented)" });
                }
              }
            }

            // Add current user prompt
            if (prompt) {
              msgs.push({ role: "user", content: buildUserMessage(prompt) });
            }

            // Assistant prefill: forces Claude to START outputting in ===FILE=== format.
            // This eliminates preamble text ("Here's the code:", "I'll create...", etc.)
            // that causes the "could not be parsed into files" error.
            msgs.push({ role: "assistant", content: PREFILL });

            return msgs;
          })(),
          stream: true,
        }),
      }
    );
  } catch (fetchErr) {
    const msg =
      fetchErr instanceof Error ? fetchErr.message : "Network error";
    return new Response(
      JSON.stringify({
        error: `Failed to reach Anthropic API: ${msg}`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!anthropicResponse.ok) {
    const errBody = await anthropicResponse.text();
    let errorMessage = `Anthropic API error (${anthropicResponse.status})`;
    try {
      const parsed = JSON.parse(errBody);
      errorMessage = parsed.error?.message || errorMessage;
    } catch {
      // use default message
    }
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!anthropicResponse.body) {
    return new Response(
      JSON.stringify({ error: "No response stream from Anthropic" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Transform the Anthropic SSE stream into our own SSE stream for the client
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = anthropicResponse.body!.getReader();
      let buffer = "";

      // Inject the prefill content as the first SSE event.
      // The API response does NOT include the prefill — only new tokens.
      // Without this, the client would see "content after prefill" but not
      // the ===FILE: src/app/page.tsx===\n prefix, breaking the parser.
      const prefillEvent = JSON.stringify({ type: "text", content: PREFILL });
      controller.enqueue(encoder.encode(`data: ${prefillEvent}\n\n`));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === "[DONE]" || !jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);

              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "text_delta"
              ) {
                const data = JSON.stringify({
                  type: "text",
                  content: event.delta.text,
                });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              } else if (event.type === "message_delta" && event.delta?.stop_reason) {
                // Forward stop_reason so client knows if response was truncated
                const stopData = JSON.stringify({
                  type: "stop",
                  stop_reason: event.delta.stop_reason,
                });
                controller.enqueue(encoder.encode(`data: ${stopData}\n\n`));
              } else if (event.type === "message_stop") {
                // Stream complete
              } else if (event.type === "error") {
                const errData = JSON.stringify({
                  type: "error",
                  error: event.error?.message || "Anthropic stream error",
                });
                controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
              }
            } catch {
              // skip malformed JSON lines
            }
          }
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "done" })}\n\n`
          )
        );
        controller.close();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Stream error";
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", error: message })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
