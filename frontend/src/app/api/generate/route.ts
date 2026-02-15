import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const SYSTEM_PROMPT = `You are an expert full-stack developer. The user will describe an app or feature they want built.

You MUST respond with ONLY code files in the following exact format. No explanations before or after the files.

For each file, use this exact delimiter format:
===FILE: path/to/file.tsx===
(file content here)
===END_FILE===

Rules:
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
- Make components interactive and functional where appropriate

Do NOT include any explanation text outside of ===FILE: ... === blocks`;

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per IP, sliding window)
// ---------------------------------------------------------------------------
const MAX_PROMPT_LENGTH = 50_000; // 50KB max prompt size
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 10; // max 10 requests per minute per IP

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

// Clean up stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of requestLog.entries()) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) requestLog.delete(key);
    else requestLog.set(key, recent);
  }
}, 5 * 60_000);

export async function POST(req: NextRequest) {
  // Rate limit by IP
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Try again in a minute." }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  const { prompt, existingFiles } = await req.json();

  if (!prompt || typeof prompt !== "string") {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate prompt length to prevent DoS via oversized payloads
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Prompt too long (max ${MAX_PROMPT_LENGTH} characters)` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "ANTHROPIC_API_KEY not configured. Add it to frontend/.env.local",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const client = new Anthropic({ apiKey });

  // Build context from existing files
  let context = "";
  if (existingFiles && Array.isArray(existingFiles)) {
    const fileDescriptions = existingFiles
      .slice(0, 20) // Limit to 20 files max for context
      .filter((f: { content?: string }) => f.content)
      .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");
    if (fileDescriptions) {
      context = `\n\nHere are the existing project files for context:\n${fileDescriptions}\n\nModify or add files as needed based on the user's request.`;
    }
  }

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: prompt + context,
            },
          ],
          stream: true,
        });

        for await (const event of response) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            // Send as SSE
            const data = JSON.stringify({ type: "text", content: event.delta.text });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
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
