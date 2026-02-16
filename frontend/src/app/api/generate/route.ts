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

For each file, use this exact delimiter format:
===FILE: path/to/file.tsx===
(file content here)
===END_FILE===

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
- CRITICAL: In page.tsx, define ALL helper component functions (Header, Hero, Footer, etc.) directly in the same file ABOVE the default export. The page MUST be fully self-contained.
- You MAY import from "react" (e.g. import { useState, useEffect } from "react"). React hooks ARE supported.
- Do NOT import from next/image, next/link, next/router, or any Next.js packages
- Do NOT import from third-party packages (no lucide-react, no framer-motion, etc.) — use inline SVG icons or emoji instead
- Do NOT import local component files — define everything inline in page.tsx
- You may create separate component files for code organization, but page.tsx must NOT depend on them
- Export the main page component as the default export

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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

  // Build PRD block if provided by the Analyzer agent
  let prdBlock = "";
  if (prd && typeof prd === "object") {
    prdBlock = `<build-plan>
${JSON.stringify(prd, null, 2)}
</build-plan>

Follow this build plan precisely. Implement exactly the components, changes, and integration described above.
`;
  }

  // Build the user message with structured context for updates
  function buildUserMessage(userPrompt: string): string {
    if (!hasExistingProject && !prdBlock) return userPrompt;
    const parts: string[] = [];
    if (existingProjectBlock) parts.push(existingProjectBlock);
    if (prdBlock) parts.push(prdBlock);
    parts.push(`User request: ${userPrompt}`);
    if (hasExistingProject) {
      parts.push("Remember: Only output files that need to change or are new. Do not regenerate unchanged files.");
    }
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
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 16384,
          system: systemPrompt,
          messages: chatHistory && chatHistory.length > 0
            ? [
                // Use conversation history for iterative chat
                ...chatHistory.map((m: { role: string; content: string }) => ({
                  role: m.role as "user" | "assistant",
                  content: m.content,
                })),
                // Append current prompt with existing project context
                ...(prompt ? [{
                  role: "user" as const,
                  content: buildUserMessage(prompt),
                }] : []),
              ]
            : [
                {
                  role: "user" as const,
                  content: buildUserMessage(prompt),
                },
              ],
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
      Connection: "keep-alive",
    },
  });
}
