/**
 * Code generation API route using Anthropic Claude.
 *
 * Uses the standard Node.js serverless runtime (NOT Edge) so that Netlify
 * "Secret" environment variables are accessible. We call the Anthropic REST
 * API directly instead of importing the SDK to keep the bundle small and
 * cold-starts fast.
 */

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

export async function POST(req: NextRequest) {
  const { prompt, existingFiles } = await req.json();

  if (!prompt || typeof prompt !== "string") {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
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

  // Build context from existing files
  let context = "";
  if (existingFiles && Array.isArray(existingFiles)) {
    const fileDescriptions = existingFiles
      .filter((f: { content?: string }) => f.content)
      .map(
        (f: { path: string; content: string }) =>
          `--- ${f.path} ---\n${f.content}`
      )
      .join("\n\n");
    if (fileDescriptions) {
      context = `\n\nHere are the existing project files for context:\n${fileDescriptions}\n\nModify or add files as needed based on the user's request.`;
    }
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
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: prompt + context,
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
