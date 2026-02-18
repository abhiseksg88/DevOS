/**
 * Analyzer Agent — Uses DeepSeek to parse user intent and generate a structured PRD.
 *
 * This is the first agent in the swarm pipeline. It analyzes the user's request
 * against the existing project state and produces a structured build plan (PRD)
 * that the Coder agent will follow precisely.
 *
 * Model: DeepSeek (cheapest, ~$0.001 per call)
 */

import { NextRequest, NextResponse } from "next/server";

const ANALYZER_SYSTEM = `You are a Product Architect agent. Your job is to analyze a user's request and produce a structured build plan (PRD) as JSON.

You will receive:
1. The user's request (what they want built or changed)
2. Optionally, a summary of existing project files

Your output MUST be valid JSON with this exact structure:
{
  "intent": "build_new" | "add_feature" | "fix_bug" | "modify" | "restyle",
  "summary": "One-line description of what needs to be done",
  "existing_analysis": {
    "current_pages": ["list of pages/views that exist"],
    "navigation_pattern": "how navigation works (tabs, sidebar, router, etc.)",
    "styling_pattern": "design language (colors, spacing, components)",
    "data_pattern": "how data is managed (useState, context, etc.)"
  },
  "changes": [
    {
      "type": "modify" | "create",
      "file": "src/app/page.tsx",
      "description": "What to change in this file"
    }
  ],
  "new_components": [
    {
      "name": "ComponentName",
      "description": "What this component does, its UI elements, interactions"
    }
  ],
  "data_model": {
    "collection_name": {
      "fields": ["field1", "field2", "field3"]
    }
  },
  "integration_notes": "How new features connect to existing navigation, state, and styling. Be specific."
}

ENTERPRISE ARCHITECTURE RULES:
When the prompt mentions CRM, admin panel, dashboard, RBAC, roles, permissions, or enterprise:
1. ALWAYS plan an auth layer (login/signup/session) in the data model and components.
2. ALWAYS plan role-based access — include "role" field in user data model.
3. ALWAYS plan a sidebar navigation layout with hash-based routing (#/dashboard, #/contacts, etc.).
4. ALWAYS plan a dashboard page with KPI cards and charts (Recharts is available via CDN).
5. Plan collections with explicit relationships (e.g., customer_id in contacts).
6. Plan pagination for any collection likely to exceed 50 records.
7. Plan form validation for all user inputs.
8. Plan confirmation dialogs for all DELETE operations.
9. Plan file upload with size/type validation if the app involves attachments.

RULES:
1. Analyze the existing code carefully before planning changes.
2. For "add_feature": identify existing navigation and plan to ADD to it, not replace it.
3. For "modify": be precise about what changes vs what stays the same.
4. Component descriptions should be detailed enough for a coder to implement without ambiguity.
5. Always specify integration_notes — how new code connects to existing code.
6. Keep the plan minimal — solve the request, nothing more.
7. Output ONLY valid JSON. No markdown, no explanation.`;

export async function POST(req: NextRequest) {
  const { prompt, existingFiles } = await req.json();

  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPSEEK_API_KEY is not configured. Add it to Netlify Site settings > Environment variables." },
      { status: 503 }
    );
  }

  // Build context from existing files
  let existingContext = "";
  if (existingFiles && Array.isArray(existingFiles) && existingFiles.length > 0) {
    const fileSummary = existingFiles
      .filter((f: { path?: string; content?: string }) => f.path && f.content)
      .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");
    if (fileSummary) {
      existingContext = `\n\nExisting project files:\n${fileSummary}`;
    }
  }

  const startTime = Date.now();

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: ANALYZER_SYSTEM },
          { role: "user", content: `User request: ${prompt}${existingContext}` },
        ],
        max_tokens: 4096,
        temperature: 0.0,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `DeepSeek API error (${response.status}): ${errText}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const usage = data.usage || {};
    const latencyMs = Date.now() - startTime;

    if (!content) {
      return NextResponse.json({ error: "Empty response from DeepSeek" }, { status: 502 });
    }

    // Parse the JSON PRD
    let prd;
    try {
      prd = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { error: "DeepSeek returned invalid JSON", raw: content },
        { status: 502 }
      );
    }

    // Calculate cost (DeepSeek pricing: $0.14/$0.28 per 1M tokens)
    const costUsd =
      (usage.prompt_tokens || 0) * 0.14 / 1_000_000 +
      (usage.completion_tokens || 0) * 0.28 / 1_000_000;

    return NextResponse.json({
      prd,
      meta: {
        model: "deepseek-chat",
        agent: "analyzer",
        tokens_in: usage.prompt_tokens || 0,
        tokens_out: usage.completion_tokens || 0,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
        latency_ms: latencyMs,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Analyzer failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
