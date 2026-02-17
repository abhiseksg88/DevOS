import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

// Allow long-running streaming generation (5 minutes)
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// System prompt — the single most important piece for output quality.
// This is what makes the difference between "generic" and "Lovable-quality".
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Vedaa, an elite full-stack developer and UI/UX designer. You create production-grade React apps that look stunning and work perfectly.

## Output Format
Respond with ONLY code files. No explanations, no markdown outside files. Use this exact format:

===FILE: path/to/file.tsx===
(file content)
===END_FILE===

## Architecture — MULTI-FILE IS THE DEFAULT
- Main entry: \`src/app/page.tsx\` with a default export React function component
- ALWAYS split your code into multiple files. The system CRASHES if any single file exceeds 250 lines.
  - \`src/app/page.tsx\` — main page: imports components, manages top-level state, renders layout (under 150 lines)
  - \`src/components/[Name].tsx\` — one file per major UI section (table, form, modal, sidebar, chart, card grid)
  - \`src/types.ts\` — shared TypeScript interfaces and types (if more than 2 interfaces)
  - \`src/data.ts\` — mock data arrays and constants (if more than 10 items)
  - \`src/app/globals.css\` — custom CSS animations or base styles
- Import components with: \`import ComponentName from "@/components/ComponentName"\` or \`import { Thing } from "@/types"\`
- The ONLY exception: if the ENTIRE app is truly a single tiny widget under 150 lines total (e.g., "a counter", "a color picker")
- Use React + TypeScript + Tailwind CSS
- Use \`className\` (not \`class\`)
- You MAY import from "react" (useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer)
- Do NOT import from next/image, next/link, next/router, or any Next.js modules
- Do NOT import from external packages (no lucide-react, no framer-motion, no date-fns, etc.)
- Each component file MUST have a default export: \`export default function ComponentName() { ... }\`

### Example file structure for a meal tracker app:
\`\`\`
src/types.ts              — Meal, NutritionGoal interfaces
src/data.ts               — MOCK_MEALS array, NUTRITION_GOALS
src/components/MealForm.tsx      — add/edit meal form with validation
src/components/MealTable.tsx     — meal list/table with search & filter
src/components/NutritionStats.tsx — calorie/macro summary cards
src/app/page.tsx          — imports above, manages state, renders layout
src/app/globals.css       — animations
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

Do NOT include any explanation text outside of file/edit blocks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## OUTPUT FORMAT — MANDATORY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### CRITICAL INSTRUCTION — READ THIS FIRST
When existing project files are provided in context below, you MUST use ===EDIT===
with SEARCH/REPLACE blocks to modify them. Do NOT output ===FILE: path=== for any
file that already exists in the context. Full-file rewrites of existing files WILL
CRASH THE SYSTEM by exceeding the output token limit and truncating your response.
The parser will fail and the user will see an error.

### For NEW files (not in context):
===FILE: path/to/new_file.tsx===
(complete file content)
===END_FILE===

### For EXISTING files (provided in context):
===EDIT: path/to/existing_file.tsx===
<<<SEARCH
(exact existing code to find — include 2-3 lines of surrounding context)
>>>REPLACE
(new code to replace it with)
===END_EDIT===

Multiple changes to the same file = multiple ===EDIT=== blocks.

### Rules:
1. SEARCH text must match the existing code EXACTLY including whitespace and indentation.
2. Include 2-3 surrounding context lines so the match is unique.
3. NEVER put the entire file content in a SEARCH block — only the changing section.
4. Keep each SEARCH block under 20 lines. Split larger changes into multiple SEARCH/REPLACE pairs.
5. The ONLY exception for using ===FILE=== on an existing path: the file is very short
   (under 30 lines) AND you are rewriting it entirely.
6. For brand new files that don't exist yet, use ===FILE: path===.`;

// ---------------------------------------------------------------------------
// Fix agent system prompt — targeted error resolution
// ---------------------------------------------------------------------------
const FIX_SYSTEM_PROMPT = `You are a React debugging specialist. You receive runtime errors from a preview render and the source code that caused them.

Your job: generate the MINIMUM fix needed. Do NOT rewrite the entire file.

## Output Format — Use SEARCH & REPLACE for targeted fixes:

===EDIT: path/to/file.tsx===
<<<SEARCH
const broken = something.undefined.value;
>>>REPLACE
const broken = something?.undefined?.value ?? "default";
===END_EDIT===

For each file, use ===EDIT=== with <<<SEARCH and >>>REPLACE blocks.
The SEARCH text must match the existing code EXACTLY.
Include 2-3 context lines around the bug for unique matching.

Do NOT use ===FILE: path=== for existing files — always use ===EDIT=== with SEARCH/REPLACE.
Only use ===FILE=== if creating a brand new file that doesn't exist yet.

Common fixes:
- Null/undefined: add optional chaining (?.) or default values (?? [])
- Missing state: add useState with proper initial value
- Event handler: bind correctly, prevent default where needed
- Rendering: guard .map() calls with Array.isArray or ?. or ?? []
- Import: remove broken imports, inline the code instead
- TypeScript: fix type errors with proper typing or 'as' assertions
- Hook rules: ensure hooks are called at top level, not conditionally
- Key prop: add unique key to .map() rendered elements

Rules:
- Use SEARCH/REPLACE blocks — do NOT rewrite entire files
- Fix ALL errors mentioned, not just the first one
- Preserve all existing functionality — don't remove features to fix errors
- No explanations outside of EDIT/FILE blocks`;

// ---------------------------------------------------------------------------
// Smart model routing — Haiku for small edits, Sonnet for everything else
// ---------------------------------------------------------------------------
function selectModel(prompt: string, hasExistingFiles: boolean): { model: string; maxTokens: number } {
  const lower = prompt.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;

  // Quick edits → Haiku (fast, cheap)
  const isQuickEdit =
    hasExistingFiles &&
    wordCount <= 20 &&
    (
      /^(make|change|set|update|fix|adjust|move|swap|remove|delete|hide|show)\b/.test(lower) ||
      /\b(color|colour|font|size|text|spacing|padding|margin|border|background|bg)\b/.test(lower) ||
      /\b(bigger|smaller|larger|wider|narrower|taller|shorter|bold|italic)\b/.test(lower)
    );

  if (isQuickEdit) {
    return { model: "claude-haiku-4-5-20251001", maxTokens: 4096 };
  }

  // New app generation needs more output room (multiple files, full content)
  // Editing existing files needs less (SEARCH/REPLACE blocks are compact)
  const maxTokens = hasExistingFiles ? 16384 : 32768;

  return { model: "claude-sonnet-4-5-20250929", maxTokens };
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------
const MAX_PROMPT_LENGTH = 50_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const requestLog = new Map<string, number[]>();

function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const timestamps = requestLog.get(clientId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) return false;
  recent.push(now);
  requestLog.set(clientId, recent);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of requestLog.entries()) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) requestLog.delete(key);
    else requestLog.set(key, recent);
  }
}, 5 * 60_000);

// ---------------------------------------------------------------------------
// POST /api/generate — main generation endpoint
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Try again in a minute." }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  const { prompt, existingFiles, mode } = await req.json();

  if (!prompt || typeof prompt !== "string") {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
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
        error: "ANTHROPIC_API_KEY not configured. Please add it to your Netlify environment variables (Site settings → Environment variables).",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const client = new Anthropic({ apiKey });

  // Pick the right system prompt and model
  const isFix = mode === "fix";
  const systemPrompt = isFix ? FIX_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const hasExisting = existingFiles && Array.isArray(existingFiles) && existingFiles.length > 0;
  const { model, maxTokens } = isFix
    ? { model: "claude-sonnet-4-5-20250929", maxTokens: 8192 }
    : selectModel(prompt, !!hasExisting);

  // Build context from existing files with token budgeting and relevance scoring
  let context = "";
  if (existingFiles && Array.isArray(existingFiles)) {
    const validFiles = existingFiles
      .slice(0, 20)
      .filter((f: { content?: string }) => f.content) as { path: string; content: string }[];

    // Score files by relevance to the prompt
    const promptLower = prompt.toLowerCase();
    const promptWords = new Set(promptLower.split(/\s+/).filter((w: string) => w.length > 3));
    const scored = validFiles.map((f) => {
      let score = 0;
      const pathLower = f.path.toLowerCase();
      const fileName = f.path.split("/").pop() ?? "";
      // File explicitly mentioned in prompt
      if (promptLower.includes(pathLower) || promptLower.includes(fileName.replace(/\.\w+$/, ""))) score += 10;
      // page.tsx is almost always relevant
      if (pathLower.endsWith("page.tsx")) score += 5;
      // globals.css relevant for style changes
      if (pathLower.endsWith("globals.css") && /\b(style|color|font|theme|dark|light|css|design|look)\b/.test(promptLower)) score += 5;
      // Keyword overlap with first 2000 chars of content
      const contentSnippet = f.content.toLowerCase().slice(0, 2000);
      for (const word of promptWords) {
        if (contentSnippet.includes(word)) score += 1;
      }
      return { ...f, score };
    }).sort((a, b) => b.score - a.score);

    // Token budget: ~6000 tokens ≈ 24000 chars for file context
    const MAX_CONTEXT_CHARS = 24000;
    let usedChars = 0;
    const includedFiles: { path: string; content: string }[] = [];
    const stubFiles: string[] = [];

    for (const f of scored) {
      if (usedChars + f.content.length <= MAX_CONTEXT_CHARS) {
        includedFiles.push({ path: f.path, content: f.content });
        usedChars += f.content.length;
      } else {
        // Try to fit a truncated version if budget allows
        const remaining = MAX_CONTEXT_CHARS - usedChars;
        if (remaining > 800) {
          includedFiles.push({
            path: f.path,
            content: f.content.slice(0, remaining) + "\n// ... (file truncated for context limit) ...",
          });
          usedChars = MAX_CONTEXT_CHARS;
        } else {
          stubFiles.push(f.path);
        }
      }
    }

    if (includedFiles.length > 0) {
      const existingPaths = includedFiles.map((f) => f.path);
      const pathList = existingPaths.map((p) => `  - ${p}`).join("\n");
      const fileContents = includedFiles
        .map((f) => `--- ${f.path} ---\n${f.content}`)
        .join("\n\n");

      let stubSection = "";
      if (stubFiles.length > 0) {
        stubSection = `\n\n## Other project files (not shown — do NOT modify unless asked):\n${stubFiles.map((p) => `  - ${p}`).join("\n")}`;
      }

      if (isFix) {
        context = `\n\n## EXISTING FILES — Use ===EDIT=== with SEARCH/REPLACE for fixes\n${pathList}\n\n## File Contents\n${fileContents}${stubSection}`;
      } else {
        context = `\n\n## EXISTING FILES — Use ===EDIT=== for these (NOT ===FILE===)\n${pathList}\n\n## File Contents\n${fileContents}${stubSection}`;
      }
    }
  }

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        // Send model info as first event
        send({ type: "meta", model });

        console.log(`[generate] Calling Anthropic API with model=${model}, maxTokens=${maxTokens}`);

        // Extended output: if maxTokens > 16384, we need the output-128k beta header
        const createParams = {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            {
              role: "user" as const,
              content: prompt + context,
            },
          ],
          stream: true as const,
        };
        const requestOptions = maxTokens > 16384
          ? { headers: { "anthropic-beta": "output-128k-2025-02-19" } }
          : undefined;
        const response = await client.messages.create(createParams, requestOptions);

        let charCount = 0;
        let stopReason = "end_turn";
        for await (const event of response) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            charCount += event.delta.text.length;
            send({ type: "text", content: event.delta.text });
          }
          // Capture stop reason to detect output truncation
          if (event.type === "message_delta") {
            const delta = event.delta as unknown as { stop_reason?: string };
            if (delta.stop_reason) {
              stopReason = delta.stop_reason;
            }
          }
        }

        console.log(`[generate] Stream complete — ${charCount} chars, stop_reason=${stopReason}`);

        // Alert the frontend if the response was truncated
        if (stopReason === "max_tokens") {
          console.warn(`[generate] Response TRUNCATED at ${charCount} chars — model hit max_tokens limit`);
          send({ type: "warning", warning: "truncated", charCount });
        }

        send({ type: "done" });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[generate] Error: ${message}`);
        send({ type: "error", error: message });
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
