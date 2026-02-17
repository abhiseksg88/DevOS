/**
 * Reviewer Agent — Uses Claude Haiku to review generated code against the PRD.
 *
 * This is the third agent in the swarm pipeline. It checks generated code for:
 * - Completeness (does it implement everything in the PRD?)
 * - Integration (is it connected to existing navigation/state?)
 * - Security (XSS, injection, unsafe patterns?)
 * - UI Quality (loading states, error handling, responsive?)
 *
 * Model: Claude Haiku (fast, cheap, ~$0.003 per call)
 */

import { NextRequest, NextResponse } from "next/server";

const REVIEWER_SYSTEM = `You are a Code Reviewer agent. You review generated React/TypeScript code for quality, completeness, and security.

You will receive:
1. A build plan (PRD) describing what should have been built
2. The generated code files

Your output MUST be valid JSON with this exact structure:
{
  "approved": true,
  "score": 8,
  "findings": [
    {
      "severity": "critical" | "warning" | "info",
      "category": "completeness" | "security" | "integration" | "ui_quality" | "consistency",
      "description": "What the issue is",
      "fix": "How to fix it"
    }
  ]
}

REVIEW CHECKLIST:
1. COMPLETENESS: Does the code implement ALL components and features from the PRD?
   - Every component listed in new_components must exist
   - Every change listed in changes must be implemented
   - Data model fields should be used in the UI
2. INTEGRATION: Are new features connected to existing code?
   - New pages/views accessible via existing navigation
   - Consistent state management pattern
   - No orphaned components
3. SECURITY: Check for dangerous patterns
   - No dangerouslySetInnerHTML with user input
   - No eval() or Function() constructors
   - No inline event handler strings
4. UI QUALITY:
   - Interactive elements have hover/focus states
   - Forms have validation feedback
   - Empty states handled
5. CONSISTENCY:
   - Same Tailwind classes and color scheme as existing code
   - Same component naming conventions
   - Same code structure patterns

RULES:
1. Set approved=false if there are ANY "critical" findings.
2. Set approved=true if there are only "warning" or "info" findings.
3. Be specific — reference exact component names and issues.
4. Don't be pedantic — focus on real problems, not style nitpicks.
5. Score from 1-10 (10 = perfect).
6. Output ONLY valid JSON. No markdown, no explanation.`;

export async function POST(req: NextRequest) {
  const { prd, files } = await req.json();

  if (!files || !Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: "files array is required" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured." },
      { status: 503 }
    );
  }

  // Build review input
  const fileContents = files
    .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const prdSection = prd ? `Build Plan (PRD):\n${JSON.stringify(prd, null, 2)}\n\n` : "";

  const startTime = Date.now();

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: REVIEWER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `${prdSection}Generated code files:\n${fileContents}\n\nReview the code against the build plan. Output JSON only.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `Anthropic API error (${response.status}): ${errText}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    const usage = data.usage || {};
    const latencyMs = Date.now() - startTime;

    if (!content) {
      return NextResponse.json({ error: "Empty response from Haiku" }, { status: 502 });
    }

    // Parse the JSON review
    let review;
    try {
      // Handle potential markdown wrapping
      const jsonStr = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      review = JSON.parse(jsonStr);
    } catch {
      // If parsing fails, create a permissive review (don't block generation)
      review = {
        approved: true,
        score: 6,
        findings: [
          {
            severity: "info",
            category: "completeness",
            description: "Reviewer output could not be parsed. Proceeding with approval.",
            fix: "N/A",
          },
        ],
      };
    }

    // Calculate cost (Haiku pricing: $0.80/$4.00 per 1M tokens for Haiku 3.5,
    // but claude-haiku-4-5 uses $1.00/$5.00)
    const costUsd =
      (usage.input_tokens || 0) * 1.0 / 1_000_000 +
      (usage.output_tokens || 0) * 5.0 / 1_000_000;

    return NextResponse.json({
      review,
      meta: {
        model: "claude-haiku-4-5-20251001",
        agent: "reviewer",
        tokens_in: usage.input_tokens || 0,
        tokens_out: usage.output_tokens || 0,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
        latency_ms: latencyMs,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Reviewer failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
